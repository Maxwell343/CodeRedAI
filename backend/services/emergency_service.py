"""
Emergency Service
=================
Handles emergency document creation, severity classification, MongoDB
persistence, and ambulance dispatch simulation.

All business logic lives here; routes stay thin.
"""
from __future__ import annotations

import logging
import random
import string
from datetime import datetime, timezone
from typing import Any

from bson import ObjectId
from pymongo.errors import PyMongoError

from database import get_emergencies_collection

_logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Severity classification
# ---------------------------------------------------------------------------

SEVERITY_MAP: dict[str, str] = {
    "heart_attack": "critical",
    "stroke": "high",
    "accident": "high",
    "fainting": "medium",
    "other": "low",
}

VALID_EMERGENCY_TYPES = frozenset(SEVERITY_MAP.keys())

# ---------------------------------------------------------------------------
# Emergency State Machine
# ---------------------------------------------------------------------------
#
# REQUESTED → DRIVER_NOTIFIED → DRIVER_ASSIGNED → EN_ROUTE_PATIENT
#   → PATIENT_PICKED → HOSPITAL_NOTIFIED → HOSPITAL_ASSIGNED
#   → EN_ROUTE_HOSPITAL → COMPLETED
#
# Parallel branch: Hospital notification happens simultaneously with driver
# notification, so HOSPITAL_NOTIFIED can co-exist with DRIVER_NOTIFIED.
# The "status" field tracks the overall lifecycle position.
# ---------------------------------------------------------------------------

EMERGENCY_STATES = [
    "REQUESTED",
    "DRIVER_NOTIFIED",
    "DRIVER_ASSIGNED",
    "EN_ROUTE_PATIENT",
    "PATIENT_PICKED",
    "HOSPITAL_NOTIFIED",
    "HOSPITAL_ASSIGNED",
    "EN_ROUTE_HOSPITAL",
    "COMPLETED",
    "CANCELLED",
    "NO_RESOURCES",
]

# ---------------------------------------------------------------------------
# Ambulance driver simulation pool
# ---------------------------------------------------------------------------

_DRIVER_NAMES: list[str] = [
    "Ravi Kumar", "Anita Sharma", "Mohammed Farhan", "Priya Menon",
    "Suresh Pillai", "Divya Nair", "Arjun Reddy", "Lakshmi Das",
    "Kiran Joshi", "Sunita Patel", "Deepak Singh", "Meena Rao",
]

_AREA_CODES: list[str] = ["98", "97", "96", "95", "94", "93", "92", "91", "80", "70"]


def _random_phone() -> str:
    area = random.choice(_AREA_CODES)
    tail = "".join(random.choices(string.digits, k=8))
    return f"+91{area}{tail}"


def _random_ambulance_id() -> str:
    letters = "".join(random.choices(string.ascii_uppercase, k=2))
    digits = "".join(random.choices(string.digits, k=4))
    return f"AMB-{letters}{digits}"


# ---------------------------------------------------------------------------
# Public service functions
# ---------------------------------------------------------------------------

def create_emergency(
    phone_number: str,
    lat: float | None,
    lng: float | None,
    address: str,
    emergency_type: str,
) -> dict[str, Any]:
    """
    Build the full emergency document for initial insertion.

    The document is inserted with status='pending' and hospital_status='pending'.
    Ambulance is NOT assigned yet — that happens after hospital acceptance.

    Returns the document dict (without ``_id``; MongoDB injects it on insert).
    """
    severity = SEVERITY_MAP.get(emergency_type, "low")

    doc: dict[str, Any] = {
        "phone_number": phone_number,
        "location": {
            "lat": lat,
            "lng": lng,
            "address": address,
        },
        "emergency_type": emergency_type,
        "severity": severity,
        "status": "REQUESTED",
        # Hospital coordination
        "assigned_hospital": None,
        "hospital_status": "pending",
        "notified_hospitals": [],      # list of hospital_id strings
        "rejected_hospitals": [],      # hospitals that explicitly rejected
        # Driver coordination
        "assigned_driver_id": None,
        "driver_status": "pending",
        "driver_offers": [],           # list of dispatch offer dicts
        "driver_assigned_at": None,
        # Ambulance (populated after driver accepts)
        "ambulance": None,
        # Timestamps
        "created_at": datetime.now(tz=timezone.utc),
        "updated_at": datetime.now(tz=timezone.utc),
        "completed_at": None,
    }

    _logger.info(
        "[EMERGENCY CREATED] type=%s  severity=%s  phone=%s  location=(%.4f, %.4f)",
        emergency_type, severity, phone_number, lat or 0.0, lng or 0.0,
    )
    return doc


def save_to_db(emergency_doc: dict[str, Any]) -> str | None:
    """
    Persist an emergency document to the ``emergencies`` collection.

    Returns the string ``_id`` of the inserted document, or ``None`` on failure.
    """
    try:
        collection = get_emergencies_collection()
        result = collection.insert_one(emergency_doc)
        inserted_id = str(result.inserted_id)
        _logger.info("[DB WRITE] Emergency persisted  id=%s", inserted_id)
        return inserted_id
    except PyMongoError as exc:
        _logger.error("[DB ERROR] Failed to save emergency: %s", exc)
        return None


def dispatch_ambulance(emergency_id: str) -> dict[str, Any] | None:
    """
    Simulate ambulance dispatch and atomically write it to MongoDB.

    Called only after a hospital has accepted the emergency (race already won).

    Returns the ambulance sub-document on success, or ``None`` on DB failure.
    """
    eta_minutes = random.randint(5, 15)
    ambulance: dict[str, Any] = {
        "id": _random_ambulance_id(),
        "driver_name": random.choice(_DRIVER_NAMES),
        "contact": _random_phone(),
        "eta": f"{eta_minutes} minutes",
        "dispatched_at": datetime.now(tz=timezone.utc).isoformat(),
    }

    try:
        collection = get_emergencies_collection()
        result = collection.update_one(
            {"_id": ObjectId(emergency_id)},
            {
                "$set": {
                    "ambulance": ambulance,
                    "status": "ambulance_assigned",
                    "updated_at": datetime.now(tz=timezone.utc),
                }
            },
        )
        if result.modified_count == 0:
            _logger.warning("[DISPATCH] No document modified for emergency_id=%s", emergency_id)
            return None

        _logger.info(
            "[AMBULANCE DISPATCHED]  emergency=%s  driver=%s  eta=%s  unit=%s",
            emergency_id, ambulance["driver_name"], ambulance["eta"], ambulance["id"],
        )
        return ambulance

    except PyMongoError as exc:
        _logger.error("[DISPATCH ERROR] %s", exc)
        return None


# ---------------------------------------------------------------------------
# Emergency status query
# ---------------------------------------------------------------------------

def get_emergency_status(emergency_id: str) -> dict[str, Any] | None:
    """
    Retrieve the full status of an emergency for any party to poll.

    Returns a serialized dict with all relevant fields, or None if not found.
    """
    try:
        doc = get_emergencies_collection().find_one({"_id": ObjectId(emergency_id)})
    except PyMongoError as exc:
        _logger.error("[STATUS QUERY ERROR] %s", exc)
        return None

    if not doc:
        return None

    loc = doc.get("location", {})
    return {
        "emergency_id": str(doc["_id"]),
        "status": doc.get("status", ""),
        "severity": doc.get("severity", ""),
        "emergency_type": doc.get("emergency_type", ""),
        "patient_address": loc.get("address", ""),
        "patient_lat": loc.get("lat"),
        "patient_lng": loc.get("lng"),
        "assigned_driver_id": doc.get("assigned_driver_id"),
        "assigned_hospital_id": doc.get("assigned_hospital"),
        "hospital_status": doc.get("hospital_status"),
        "driver_status": doc.get("driver_status"),
        "ambulance": doc.get("ambulance"),
        "created_at": str(doc["created_at"]) if doc.get("created_at") else None,
        "updated_at": str(doc["updated_at"]) if doc.get("updated_at") else None,
        "completed_at": str(doc["completed_at"]) if doc.get("completed_at") else None,
    }

