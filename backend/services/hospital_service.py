"""
Hospital Service
================
Geospatial hospital discovery, multi-hospital notification,
atomic race-safe acceptance, ambulance dispatch trigger, and
rejection with automatic radius fallback.

Architecture: all business logic lives here. Routes are thin wrappers.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from bson import ObjectId
from pymongo.errors import PyMongoError

from database import get_emergencies_collection, get_hospitals_collection
from services.emergency_service import dispatch_ambulance

_logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_DEFAULT_RADIUS_M = 5_000     # 5 km initial search radius
_FALLBACK_RADIUS_M = 10_000   # 10 km fallback when all hospitals reject
_MAX_HOSPITALS_TO_NOTIFY = 3  # cap notifications per emergency

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _oid(emergency_id: str) -> ObjectId:
    """Convert a string emergency ID to ObjectId, raising ValueError if malformed."""
    try:
        return ObjectId(emergency_id)
    except Exception as exc:
        raise ValueError(f"Invalid emergency_id format: {emergency_id!r}") from exc


def _serialize_hospital(doc: dict[str, Any], distance_m: float | None = None) -> dict[str, Any]:
    """Return a clean, serializable hospital record for API responses."""
    available_beds = doc.get("available_beds")
    if available_beds is None:
        available_beds = doc.get("bed_capacity", 0)

    return {
        "hospital_id": doc.get("hospital_id") or str(doc["_id"]),
        "name": doc.get("name", "Unknown Hospital"),
        "address": doc.get("address", ""),
        "available_beds": available_beds,
        "bed_capacity": doc.get("bed_capacity", available_beds),
        "distance_m": round(distance_m, 1) if distance_m is not None else None,
    }


# ---------------------------------------------------------------------------
# Geo search
# ---------------------------------------------------------------------------

def find_nearest_hospitals(
    lat: float,
    lng: float,
    radius_m: int = _DEFAULT_RADIUS_M,
    limit: int = _MAX_HOSPITALS_TO_NOTIFY,
) -> list[dict[str, Any]]:
    """
    Find the nearest active hospitals with available beds using MongoDB's
    ``$near`` geospatial operator (requires a 2dsphere index on
    ``hospitals.location``).

    Parameters
    ----------
    lat, lng : float
        Caller's GPS coordinates.
    radius_m : int
        Search radius in metres (default 5 000 m).
    limit : int
        Maximum number of hospitals to return (default 3).

    Returns
    -------
    list of serialized hospital dicts, sorted nearest-first.
    """
    collection = get_hospitals_collection()

    query = {
        "location": {
            "$near": {
                "$geometry": {
                    "type": "Point",
                    "coordinates": [lng, lat],   # GeoJSON order: [lng, lat]
                },
                "$maxDistance": radius_m,
            }
        },
        "status": "active",
        "$or": [
            {"available_beds": {"$gt": 0}},
            {"bed_capacity": {"$gt": 0}},
        ],
    }

    try:
        docs = list(collection.find(query).limit(limit))
    except PyMongoError as exc:
        _logger.error("[GEO SEARCH ERROR] %s", exc)
        return []

    hospitals = [_serialize_hospital(doc) for doc in docs]

    _logger.info(
        "[GEO SEARCH] lat=%.4f lng=%.4f radius=%dm → found %d hospital(s)",
        lat, lng, radius_m, len(hospitals),
    )
    for h in hospitals:
        _logger.info(
            "  ↳ %s | %s | beds=%s | dist=%sm",
            h["hospital_id"], h["name"], h["available_beds"], h["distance_m"],
        )

    return hospitals


# ---------------------------------------------------------------------------
# Notification
# ---------------------------------------------------------------------------

def notify_hospitals(emergency_id: str, hospitals: list[dict[str, Any]]) -> None:
    """
    Record all notified hospital IDs on the emergency document and log each
    simulated notification.

    In production this would send push notifications / webhooks to hospital
    dashboards. Here we simulate with structured log output.
    """
    if not hospitals:
        _logger.warning("[NOTIFY] No hospitals to notify for emergency=%s", emergency_id)
        return

    hospital_ids = [h["hospital_id"] for h in hospitals]

    try:
        get_emergencies_collection().update_one(
            {"_id": _oid(emergency_id)},
            {
                "$set": {
                    "notified_hospitals": hospital_ids,
                    "hospital_status": "pending",
                    "updated_at": datetime.now(tz=timezone.utc),
                }
            },
        )
    except PyMongoError as exc:
        _logger.error("[NOTIFY DB ERROR] %s", exc)
        return

    _logger.info(
        "[NOTIFY] Emergency %s → notifying %d hospital(s)", emergency_id, len(hospitals)
    )
    for h in hospitals:
        _logger.info("  📡 Notified: %s (%s)", h["name"], h["hospital_id"])


# ---------------------------------------------------------------------------
# Atomic acceptance — race-condition safe
# ---------------------------------------------------------------------------

def accept_emergency(hospital_id: str, emergency_id: str) -> dict[str, Any]:
    """
    Atomically assign a hospital to an emergency.

    The update only succeeds if ``hospital_status == "pending"``, ensuring
    exactly one hospital can win the race even under concurrent requests.

    Returns
    -------
    dict with keys:
        ``won``      – True if this hospital won the assignment
        ``ambulance`` – ambulance dict if won, else None
        ``message``  – human-readable outcome
    """
    try:
        result = get_emergencies_collection().update_one(
            {
                "_id": _oid(emergency_id),
                "hospital_status": "pending",           # atomic guard
                "notified_hospitals": hospital_id,      # must have been notified
            },
            {
                "$set": {
                    "assigned_hospital": hospital_id,
                    "hospital_status": "accepted",
                    "status": "HOSPITAL_ASSIGNED",
                    "updated_at": datetime.now(tz=timezone.utc),
                }
            },
        )
    except PyMongoError as exc:
        _logger.error("[ACCEPT ERROR] %s", exc)
        raise

    if result.matched_count == 0:
        # Either already accepted by another hospital, or hospital wasn't notified
        _logger.warning(
            "[ACCEPT LOST] hospital=%s  emergency=%s — race lost or not notified",
            hospital_id, emergency_id,
        )
        return {"won": False, "ambulance": None, "message": "Emergency already assigned to another hospital."}

    _logger.info(
        "[ACCEPT WON] hospital=%s  emergency=%s",
        hospital_id, emergency_id,
    )

    # Check if a driver is already assigned — if not, trigger driver discovery
    try:
        doc = get_emergencies_collection().find_one({"_id": _oid(emergency_id)})
        if doc and not doc.get("assigned_driver_id"):
            loc = doc.get("location", {})
            lat = loc.get("lat")
            lng = loc.get("lng")
            if lat is not None and lng is not None:
                from services.driver_service import find_nearest_drivers, create_driver_offers
                
                existing_offers = doc.get("driver_offers", [])
                exclude_ids = [o["driver_id"] for o in existing_offers]
                drivers = find_nearest_drivers(lat, lng, exclude_ids=exclude_ids)
                if drivers:
                    create_driver_offers(emergency_id, drivers)
                    _logger.info(
                        "[ACCEPT] Hospital accepted — also notified %d driver(s)",
                        len(drivers),
                    )
    except Exception as exc:
        _logger.warning("[ACCEPT] Driver discovery post-acceptance failed: %s", exc)

    # Trigger ambulance dispatch immediately after winning
    ambulance = dispatch_ambulance(emergency_id)
    if ambulance:
        _logger.info(
            "[ACCEPT] Ambulance dispatched → unit=%s  driver=%s  eta=%s",
            ambulance["id"], ambulance["driver_name"], ambulance["eta"],
        )
        return {"won": True, "ambulance": ambulance, "message": "Emergency accepted. Ambulance dispatched."}
    else:
        _logger.error("[ACCEPT] Hospital won but ambulance dispatch failed for emergency=%s", emergency_id)
        return {"won": True, "ambulance": None, "message": "Emergency accepted but ambulance dispatch failed."}


# ---------------------------------------------------------------------------
# Rejection with automatic radius fallback
# ---------------------------------------------------------------------------

def reject_emergency(hospital_id: str, emergency_id: str) -> dict[str, Any]:
    """
    Record a hospital's rejection of an emergency.

    If ALL notified hospitals have now rejected, automatically expand the
    search radius to 10 km and re-notify the next batch.

    Returns
    -------
    dict with keys:
        ``all_rejected``         – True if every notified hospital rejected
        ``fallback_triggered``   – True if the 10 km fallback was started
        ``new_hospitals``        – list of newly notified hospitals (if fallback)
        ``message``              – human-readable outcome
    """
    try:
        # Push this hospital into the rejected list
        get_emergencies_collection().update_one(
            {"_id": _oid(emergency_id)},
            {
                "$addToSet": {"rejected_hospitals": hospital_id},
                "$set": {"updated_at": datetime.now(tz=timezone.utc)},
            },
        )
    except PyMongoError as exc:
        _logger.error("[REJECT DB ERROR] %s", exc)
        raise

    _logger.info("[REJECT] hospital=%s  emergency=%s", hospital_id, emergency_id)

    # Reload document to check if all notified hospitals have rejected
    try:
        doc = get_emergencies_collection().find_one({"_id": _oid(emergency_id)})
    except PyMongoError as exc:
        _logger.error("[REJECT RELOAD ERROR] %s", exc)
        raise

    if not doc:
        return {"all_rejected": False, "fallback_triggered": False, "new_hospitals": [], "message": "Emergency not found."}

    notified: list = doc.get("notified_hospitals", [])
    rejected: list = doc.get("rejected_hospitals", [])
    current_status: str = doc.get("hospital_status", "")

    # Check if all notified hospitals have rejected and no one has accepted
    all_rejected = current_status != "accepted" and set(notified).issubset(set(rejected))

    if not all_rejected:
        remaining = len(set(notified) - set(rejected))
        _logger.info("[REJECT] %d hospital(s) still pending for emergency=%s", remaining, emergency_id)
        return {
            "all_rejected": False,
            "fallback_triggered": False,
            "new_hospitals": [],
            "message": f"Rejection recorded. {remaining} hospital(s) still pending.",
        }

    # All notified hospitals rejected — trigger 10 km fallback
    _logger.warning(
        "[REJECT ALL] All %d notified hospitals rejected emergency=%s — expanding to %dm",
        len(notified), emergency_id, _FALLBACK_RADIUS_M,
    )

    loc = doc.get("location", {})
    lat = loc.get("lat")
    lng = loc.get("lng")

    if lat is None or lng is None:
        _logger.error("[FALLBACK ERROR] No coordinates on emergency=%s", emergency_id)
        return {
            "all_rejected": True,
            "fallback_triggered": False,
            "new_hospitals": [],
            "message": "All hospitals rejected. Fallback failed — no coordinates on record.",
        }

    # Search with expanded radius, excluding already-rejected hospitals
    new_hospitals = find_nearest_hospitals(lat, lng, radius_m=_FALLBACK_RADIUS_M, limit=5)
    new_hospitals = [h for h in new_hospitals if h["hospital_id"] not in rejected]

    if not new_hospitals:
        _logger.error("[FALLBACK] No additional hospitals found within %dm", _FALLBACK_RADIUS_M)
        get_emergencies_collection().update_one(
            {"_id": _oid(emergency_id)},
            {"$set": {"hospital_status": "no_hospitals", "status": "no_hospitals_available", "updated_at": datetime.now(tz=timezone.utc)}},
        )
        return {
            "all_rejected": True,
            "fallback_triggered": False,
            "new_hospitals": [],
            "message": "All hospitals rejected. No additional hospitals found within 10 km.",
        }

    # Notify the newly found hospitals and reset hospital_status to pending
    try:
        new_ids = [h["hospital_id"] for h in new_hospitals]
        get_emergencies_collection().update_one(
            {"_id": _oid(emergency_id)},
            {
                "$set": {
                    "hospital_status": "pending",
                    "notified_hospitals": new_ids,
                    "updated_at": datetime.now(tz=timezone.utc),
                }
            },
        )
    except PyMongoError as exc:
        _logger.error("[FALLBACK UPDATE ERROR] %s", exc)
        raise

    for h in new_hospitals:
        _logger.info("  📡 Fallback notify: %s (%s)", h["name"], h["hospital_id"])

    return {
        "all_rejected": True,
        "fallback_triggered": True,
        "new_hospitals": new_hospitals,
        "message": f"All initial hospitals rejected. Fallback triggered — notified {len(new_hospitals)} new hospital(s) within 10 km.",
    }


# ---------------------------------------------------------------------------
# Query helpers
# ---------------------------------------------------------------------------

def get_pending_emergencies(hospital_id: str | None = None) -> list[dict[str, Any]]:
    """
    Return all emergencies awaiting hospital acceptance.

    If ``hospital_id`` is given, only return emergencies where that hospital
    was notified (for a hospital-specific dashboard view).
    """
    query: dict[str, Any] = {"hospital_status": "pending"}
    if hospital_id:
        query["notified_hospitals"] = hospital_id

    try:
        docs = list(
            get_emergencies_collection()
            .find(query)
            .sort("created_at", -1)
            .limit(50)
        )
    except PyMongoError as exc:
        _logger.error("[PENDING QUERY ERROR] %s", exc)
        return []

    results = []
    for doc in docs:
        results.append({
            "emergency_id": str(doc["_id"]),
            "phone_number": doc.get("phone_number", ""),
            "address": doc.get("location", {}).get("address", ""),
            "emergency_type": doc.get("emergency_type", ""),
            "severity": doc.get("severity", "low"),
            "created_at": doc.get("created_at"),
            "notified_hospitals": doc.get("notified_hospitals", []),
        })

    _logger.info("[PENDING QUERY] hospital_id=%s → %d result(s)", hospital_id or "all", len(results))
    return results
