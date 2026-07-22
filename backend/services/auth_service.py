from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import HTTPException, status
from pymongo.errors import DuplicateKeyError, PyMongoError

from database import get_admins_collection, get_drivers_collection, get_hospitals_collection
from schemas.auth import (
    AdminSignupRequest,
    DriverSignupRequest,
    HospitalSignupRequest,
    LoginRequest,
)
from utils.hashing import hash_password, verify_password
from utils.jwt_handler import create_access_token


@dataclass
class AuthResult:
    user: Dict[str, Any]
    token: str


def _raise_db_unavailable(exc: Exception) -> None:
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=(
            "Database unavailable. Check MongoDB Atlas Network Access allowlist "
            "and your local network TLS connectivity."
        ),
    ) from exc


def _normalize_email(email: str) -> str:
    return email.strip().lower()


def _is_truthy(value: Optional[str]) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


DEFAULT_PRESET_PASSWORD = os.getenv("DEFAULT_PRESET_PASSWORD", "Password@123")
DEFAULT_ADMIN_PASSWORD = os.getenv("DEFAULT_ADMIN_PASSWORD", "Admin@123")
DEFAULT_ADMIN_ROLE = os.getenv("DEFAULT_ADMIN_ROLE", "Admin")
SEED_DEFAULT_ADMINS = _is_truthy(os.getenv("SEED_DEFAULT_ADMINS", "false"))

DEFAULT_ADMIN_ACCOUNTS = [
    {
        "name": "Aarav Mehta",
        "role": "Chief Operations Admin",
        "email": "admin.ops@codered.ai",
    },
    {
        "name": "Siya Iyer",
        "role": "Verification Lead",
        "email": "admin.verify@codered.ai",
    },
    {
        "name": "Kabir Khan",
        "role": "Quality & Reviews Admin",
        "email": "admin.reviews@codered.ai",
    },
    {
        "name": "Neha Desai",
        "role": "Compliance Admin",
        "email": "admin.compliance@codered.ai",
    },
]


def _email_suffix_code(value: str) -> str:
    total = sum(ord(char) for char in value)
    return str(total % 900 + 100)


def _build_callsign(name: str, email: str) -> str:
    letters = "".join(char for char in name.upper() if char.isalpha())
    prefix = letters[:3] or email.split("@")[0][:3].upper()
    return f"{prefix}-{_email_suffix_code(email)}"


def _build_hospital_user(doc: Dict[str, Any]) -> Dict[str, Any]:
    location_out = None
    if "location" in doc and doc["location"]:
        loc = doc["location"]
        if isinstance(loc, dict) and "coordinates" in loc:
            # GeoJSON uses [lng, lat]
            location_out = {"lng": loc["coordinates"][0], "lat": loc["coordinates"][1]}
        else:
            location_out = loc

    return {
        "id": doc.get("hospital_id") or str(doc["_id"]),
        "name": doc.get("name") or doc.get("hospital_id", ""),
        "email": doc.get("email", ""),
        "hospitalId": doc.get("hospital_id"),
        "bedCapacity": doc.get("bed_capacity"),
        "address": doc.get("address"),
        "location": location_out,
    }


def _build_driver_user(doc: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": str(doc["_id"]),
        "name": doc.get("name", ""),
        "email": doc.get("email", ""),
        "phone": doc.get("phone"),
        "callSign": doc.get("call_sign"),
        "vehicleNumber": doc.get("vehicle_number"),
        "linkedHospitalId": doc.get("linked_hospital_id"),
    }


def _build_admin_user(doc: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": str(doc["_id"]),
        "name": doc.get("name", ""),
        "email": doc.get("email", ""),
        "role": doc.get("role", DEFAULT_ADMIN_ROLE),
    }


def _issue_token(user: Dict[str, Any], role: str) -> str:
    payload = {
        "sub": user["id"],
        "role": role,
        "email": user.get("email"),
        "name": user.get("name"),
    }
    return create_access_token(payload)


def signup_hospital(payload: HospitalSignupRequest) -> AuthResult:
    collection = get_hospitals_collection()
    hospital_id = payload.hospitalId.strip().upper()
    email = _normalize_email(payload.email)
    bed_capacity = payload.bedCapacity
    location = payload.location
    now = datetime.utcnow()

    if not hospital_id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Hospital ID is required.",
        )

    doc = {
        "hospital_id": hospital_id,
        "name": hospital_id,
        "email": email,
        "password_hash": hash_password(payload.password),
        "role": "hospital",
        "bed_capacity": bed_capacity,
        "location": {
            "type": "Point",
            "coordinates": [location.lng, location.lat],  # [lng, lat]
        },
        "status": "active",
        "created_at": now,
        "updated_at": now,
    }

    try:
        email_exists = collection.find_one({"email": email}, {"_id": 1})
        if email_exists:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Email already registered.",
            )

        hospital_id_exists = collection.find_one({"hospital_id": hospital_id}, {"_id": 1})
        if hospital_id_exists:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Hospital ID already registered.",
            )

        result = collection.insert_one(doc)
    except DuplicateKeyError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Hospital ID or email already registered.",
        ) from exc
    except PyMongoError as exc:
        _raise_db_unavailable(exc)

    user = _build_hospital_user({**doc, "_id": result.inserted_id})
    token = _issue_token(user, "hospital")
    return AuthResult(user=user, token=token)


def login_hospital(payload: LoginRequest) -> AuthResult:
    collection = get_hospitals_collection()
    email = _normalize_email(payload.email)
    try:
        doc = collection.find_one({"email": email})
    except PyMongoError as exc:
        _raise_db_unavailable(exc)

    if not doc or not verify_password(payload.password, doc.get("password_hash", "")):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password.",
        )

    now = datetime.utcnow()
    try:
        collection.update_one({"_id": doc["_id"]}, {"$set": {"last_login_at": now}})
    except PyMongoError:
        # Non-critical side effect; authentication already validated.
        pass

    user = _build_hospital_user(doc)
    token = _issue_token(user, "hospital")
    return AuthResult(user=user, token=token)


def signup_driver(payload: DriverSignupRequest) -> AuthResult:
    collection = get_drivers_collection()
    email = _normalize_email(payload.email)
    now = datetime.utcnow()
    phone = payload.phone.strip()
    vehicle_number = payload.vehicleNumber.strip().upper()
    linked_hospital_id = payload.linkedHospitalId.strip().upper()

    if not phone:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Phone is required.",
        )

    if not vehicle_number:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Vehicle number is required.",
        )

    if not linked_hospital_id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Linked hospital ID is required.",
        )

    doc = {
        "name": payload.driverName.strip(),
        "email": email,
        "phone": phone,
        "call_sign": _build_callsign(payload.driverName, email),
        "vehicle_number": vehicle_number,
        "linked_hospital_id": linked_hospital_id,
        "password_hash": hash_password(payload.password),
        "role": "driver",
        "created_at": now,
        "updated_at": now,
    }

    try:
        result = collection.insert_one(doc)
    except DuplicateKeyError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email already registered.",
        ) from exc
    except PyMongoError as exc:
        _raise_db_unavailable(exc)

    user = _build_driver_user({**doc, "_id": result.inserted_id})
    token = _issue_token(user, "driver")
    return AuthResult(user=user, token=token)


def login_driver(payload: LoginRequest) -> AuthResult:
    collection = get_drivers_collection()
    email = _normalize_email(payload.email)
    try:
        doc = collection.find_one({"email": email})
    except PyMongoError as exc:
        _raise_db_unavailable(exc)

    if not doc or not verify_password(payload.password, doc.get("password_hash", "")):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password.",
        )

    now = datetime.utcnow()
    try:
        collection.update_one({"_id": doc["_id"]}, {"$set": {"last_login_at": now}})
    except PyMongoError:
        # Non-critical side effect; authentication already validated.
        pass

    user = _build_driver_user(doc)
    token = _issue_token(user, "driver")
    return AuthResult(user=user, token=token)


def signup_admin(payload: AdminSignupRequest) -> AuthResult:
    collection = get_admins_collection()
    email = _normalize_email(payload.email)
    now = datetime.utcnow()

    doc = {
        "name": payload.adminName.strip(),
        "email": email,
        "password_hash": hash_password(payload.password),
        "role": DEFAULT_ADMIN_ROLE,
        "created_at": now,
        "updated_at": now,
    }

    try:
        result = collection.insert_one(doc)
    except DuplicateKeyError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email already registered.",
        ) from exc
    except PyMongoError as exc:
        _raise_db_unavailable(exc)

    user = _build_admin_user({**doc, "_id": result.inserted_id})
    token = _issue_token(user, "admin")
    return AuthResult(user=user, token=token)


def login_admin(payload: LoginRequest) -> AuthResult:
    collection = get_admins_collection()
    email = _normalize_email(payload.email)
    try:
        doc = collection.find_one({"email": email})
    except PyMongoError as exc:
        _raise_db_unavailable(exc)

    if not doc or not verify_password(payload.password, doc.get("password_hash", "")):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password.",
        )

    now = datetime.utcnow()
    try:
        collection.update_one({"_id": doc["_id"]}, {"$set": {"last_login_at": now}})
    except PyMongoError:
        # Non-critical side effect; authentication already validated.
        pass

    user = _build_admin_user(doc)
    token = _issue_token(user, "admin")
    return AuthResult(user=user, token=token)


def get_preset_hospitals(limit: int = 10) -> Dict[str, Any]:
    collection = get_hospitals_collection()
    try:
        docs = list(collection.find({}, {"name": 1, "email": 1}).limit(limit))
    except PyMongoError as exc:
        _raise_db_unavailable(exc)
    hospitals = [
        {"id": str(doc["_id"]), "name": doc.get("name", ""), "email": doc.get("email", "")}
        for doc in docs
    ]
    return {"defaultPassword": DEFAULT_PRESET_PASSWORD, "hospitals": hospitals}


def get_preset_drivers(limit: int = 500) -> Dict[str, Any]:
    collection = get_drivers_collection()
    try:
        docs = list(
            collection.find({}, {"name": 1, "email": 1, "call_sign": 1})
            .sort("email", 1)
            .limit(limit)
        )
    except PyMongoError as exc:
        _raise_db_unavailable(exc)
    drivers = [
        {
            "id": str(doc["_id"]),
            "name": doc.get("name", ""),
            "email": doc.get("email", ""),
            "callSign": doc.get("call_sign"),
        }
        for doc in docs
    ]
    return {"defaultPassword": DEFAULT_PRESET_PASSWORD, "drivers": drivers}


def seed_default_admins() -> int:
    if not SEED_DEFAULT_ADMINS:
        return 0

    collection = get_admins_collection()
    now = datetime.utcnow()
    inserted = 0

    for account in DEFAULT_ADMIN_ACCOUNTS:
        email = _normalize_email(account["email"])
        doc = {
            "name": account["name"],
            "email": email,
            "password_hash": hash_password(DEFAULT_ADMIN_PASSWORD),
            "role": account["role"],
            "created_at": now,
            "updated_at": now,
        }
        try:
            collection.insert_one(doc)
            inserted += 1
        except DuplicateKeyError:
            continue
        except PyMongoError:
            return inserted

    return inserted
