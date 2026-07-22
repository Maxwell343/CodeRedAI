"""
Driver Service
==============
Geospatial driver discovery, dispatch offer management,
first-accept-wins assignment, and active mission tracking.

Architecture: all business logic lives here. Routes are thin wrappers.
"""
from __future__ import annotations

import logging
import random
import string
from datetime import datetime, timezone, timedelta
from typing import Any

from bson import ObjectId
from pymongo.errors import PyMongoError

from database import get_drivers_collection, get_emergencies_collection, get_hospitals_collection

_logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_DEFAULT_RADIUS_M = 5_000       # 5 km initial search radius
_FALLBACK_RADIUS_M = 10_000     # 10 km fallback
_EXTENDED_RADIUS_M = 20_000     # 20 km extended fallback
_MAX_DRIVERS_TO_NOTIFY = 5      # cap notifications per emergency
_OFFER_TTL_SECONDS = 60         # configurable offer timeout


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _oid(id_str: str) -> ObjectId:
    """Convert a string ID to ObjectId, raising ValueError if malformed."""
    try:
        return ObjectId(id_str)
    except Exception as exc:
        raise ValueError(f"Invalid ID format: {id_str!r}") from exc


def _generate_offer_id() -> str:
    """Generate a unique offer ID."""
    letters = "".join(random.choices(string.ascii_uppercase, k=4))
    digits = "".join(random.choices(string.digits, k=6))
    return f"OFR-{letters}{digits}"


def _serialize_driver_docs(docs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Normalize driver documents into a consistent response shape."""
    drivers: list[dict[str, Any]] = []
    for doc in docs:
        loc = doc.get("location", {})
        coords = loc.get("coordinates", [0, 0]) if isinstance(loc, dict) else [0, 0]

        drivers.append({
            "driver_id": doc.get("email", str(doc.get("_id", ""))),
            "name": doc.get("name", "Unknown Driver"),
            "email": doc.get("email", ""),
            "phone": doc.get("phone", ""),
            "location": {"lat": coords[1], "lng": coords[0]} if len(coords) >= 2 else None,
            "speed_kmph": doc.get("speed_kmph"),
            "distance_m": None,
        })

    return drivers


def _find_fallback_available_drivers(
    limit: int,
    exclude_ids: list[str] | None,
) -> list[dict[str, Any]]:
    """
    Fallback when geo-search yields no matches.

    Returns drivers that are online/available or have no dispatch status yet,
    sorted by recent activity so a newly logged-in driver can still receive offers.
    """
    projection = {
        "email": 1,
        "name": 1,
        "phone": 1,
        "location": 1,
        "speed_kmph": 1,
        "last_ping_at": 1,
        "last_login_at": 1,
        "updated_at": 1,
        "dispatch_status": 1,
    }

    excluded = list(exclude_ids or [])
    collected_docs: list[dict[str, Any]] = []

    def fetch_docs(query: dict[str, Any], fetch_limit: int) -> list[dict[str, Any]]:
        if fetch_limit <= 0:
            return []

        final_query = dict(query)
        if excluded:
            final_query["email"] = {"$nin": excluded}

        return list(
            get_drivers_collection()
            .find(final_query, projection)
            .sort([("last_ping_at", -1), ("last_login_at", -1), ("updated_at", -1)])
            .limit(fetch_limit)
        )

    try:
        # Priority 1: explicitly online/available drivers.
        online_docs = fetch_docs({"dispatch_status": {"$in": ["online", "available"]}}, limit)
        collected_docs.extend(online_docs)
        excluded.extend([doc.get("email") for doc in online_docs if doc.get("email")])

        # Priority 2: any remaining non-assigned drivers.
        remaining = limit - len(collected_docs)
        if remaining > 0:
            fallback_docs = fetch_docs(
                {
                    "$or": [
                        {"dispatch_status": {"$nin": ["assigned", "on_mission"]}},
                        {"dispatch_status": {"$exists": False}},
                    ]
                },
                remaining,
            )
            collected_docs.extend(fallback_docs)
    except PyMongoError as exc:
        _logger.error("[DRIVER FALLBACK QUERY ERROR] %s", exc)
        return []

    drivers = _serialize_driver_docs(collected_docs)
    _logger.info("[DRIVER FALLBACK] selected %d driver(s) without geo constraint", len(drivers))
    return drivers


# ---------------------------------------------------------------------------
# Driver Location Management
# ---------------------------------------------------------------------------

def update_driver_location(
    driver_id: str,
    lat: float,
    lng: float,
    speed_kmph: float | None = None,
    heading: float | None = None,
) -> bool:
    """
    Upsert the driver's live GPS location in GeoJSON format.
    Also sets dispatch_status to 'online' and refreshes last_ping_at.

    Returns True on success, False on DB failure.
    """
    collection = get_drivers_collection()

    update_fields: dict[str, Any] = {
        "location": {
            "type": "Point",
            "coordinates": [lng, lat],  # GeoJSON order: [lng, lat]
        },
        "last_ping_at": datetime.now(tz=timezone.utc),
        "updated_at": datetime.now(tz=timezone.utc),
    }

    # Only set to online if not currently on a mission
    # (dispatch_status "assigned" should not be overwritten)
    update_on_insert = {
        "dispatch_status": "online",
    }

    if speed_kmph is not None:
        update_fields["speed_kmph"] = speed_kmph
    if heading is not None:
        update_fields["heading"] = heading

    try:
        result = collection.update_one(
            {"email": driver_id},
            {
                "$set": update_fields,
                "$setOnInsert": update_on_insert,
            },
            upsert=True,  # Crucial: create the driver doc if they don't exist yet
        )

        # If the driver exists and is not assigned, set them to online
        if result.matched_count > 0:
            collection.update_one(
                {
                    "email": driver_id,
                    "dispatch_status": {"$nin": ["assigned", "on_mission"]},
                },
                {"$set": {"dispatch_status": "online"}},
            )

        _logger.debug(
            "[DRIVER LOCATION] %s → (%.4f, %.4f) speed=%.1f",
            driver_id, lat, lng, speed_kmph or 0,
        )
        return True

    except PyMongoError as exc:
        _logger.error("[DRIVER LOCATION ERROR] %s: %s", driver_id, exc)
        return False


# ---------------------------------------------------------------------------
# Geospatial Driver Discovery
# ---------------------------------------------------------------------------

def find_nearest_drivers(
    lat: float,
    lng: float,
    radius_m: int = _DEFAULT_RADIUS_M,
    limit: int = _MAX_DRIVERS_TO_NOTIFY,
    exclude_ids: list[str] | None = None,
) -> list[dict[str, Any]]:
    """
    Find the nearest online drivers using MongoDB's $near geospatial operator.
    Requires a 2dsphere index on drivers.location.

    If no geo-qualified drivers are found, falls back to recently active
    online/available drivers so dispatch can still proceed.

    Parameters
    ----------
    lat, lng : float
        Patient/emergency GPS coordinates.
    radius_m : int
        Search radius in metres.
    limit : int
        Maximum number of drivers to return.
    exclude_ids : list[str] | None
        Driver IDs (emails) to exclude (already rejected/notified).

    Returns
    -------
    list of driver dicts with keys: driver_id, name, email, distance_m, location.
    """
    collection = get_drivers_collection()

    # Only find drivers who are online and have a GeoJSON location
    query: dict[str, Any] = {
        "location": {
            "$near": {
                "$geometry": {
                    "type": "Point",
                    "coordinates": [lng, lat],
                },
                "$maxDistance": radius_m,
            }
        },
        "dispatch_status": "online",
    }

    if exclude_ids:
        query["email"] = {"$nin": exclude_ids}

    try:
        docs = list(collection.find(query).limit(limit))
    except PyMongoError as exc:
        _logger.error("[DRIVER GEO SEARCH ERROR] %s", exc)
        docs = []

    drivers = _serialize_driver_docs(docs)

    selected_ids = [driver.get("driver_id") for driver in drivers if driver.get("driver_id")]
    excluded_ids = [*(exclude_ids or []), *selected_ids]

    if len(drivers) < limit:
        supplemental = _find_fallback_available_drivers(
            limit=limit - len(drivers),
            exclude_ids=excluded_ids,
        )
        drivers.extend(supplemental)

    _logger.info(
        "[DRIVER GEO SEARCH] lat=%.4f lng=%.4f radius=%dm → found %d driver(s)",
        lat, lng, radius_m, len(drivers),
    )
    for d in drivers:
        _logger.info("  ↳ %s | %s", d["driver_id"], d["name"])

    return drivers


# ---------------------------------------------------------------------------
# Dispatch Offer Management
# ---------------------------------------------------------------------------

def create_driver_offers(
    emergency_id: str,
    drivers: list[dict[str, Any]],
    ttl_seconds: int = _OFFER_TTL_SECONDS,
) -> list[dict[str, Any]]:
    """
    Create dispatch offers for the given drivers and store them on the
    emergency document in MongoDB.

    Each offer has a unique ID and an expiration timestamp.

    Returns the list of created offer dicts.
    """
    if not drivers:
        _logger.warning("[OFFERS] No drivers to create offers for emergency=%s", emergency_id)
        return []

    now = datetime.now(tz=timezone.utc)
    expires_at = now + timedelta(seconds=ttl_seconds)

    offers = []
    for driver in drivers:
        offer = {
            "offer_id": _generate_offer_id(),
            "driver_id": driver["driver_id"],
            "driver_name": driver["name"],
            "status": "pending",
            "created_at": now.isoformat(),
            "expires_at": expires_at.isoformat(),
        }
        offers.append(offer)

    try:
        get_emergencies_collection().update_one(
            {"_id": _oid(emergency_id)},
            {
                "$set": {
                    "driver_offers": offers,
                    "driver_status": "offers_pending",
                    "updated_at": now,
                },
            },
        )
    except PyMongoError as exc:
        _logger.error("[OFFERS DB ERROR] %s", exc)
        return []

    _logger.info(
        "[OFFERS] Created %d offer(s) for emergency=%s (TTL=%ds)",
        len(offers), emergency_id, ttl_seconds,
    )
    for o in offers:
        _logger.info("  📡 Offer %s → driver %s", o["offer_id"], o["driver_id"])

    return offers


def get_pending_offers_for_driver(driver_id: str) -> list[dict[str, Any]]:
    """
    Find all emergencies with a pending offer for this driver that haven't expired.

    Returns a list of dicts with emergency + offer details merged.
    """
    now = datetime.now(tz=timezone.utc).isoformat()

    try:
        docs = list(
            get_emergencies_collection().find(
                {
                    "driver_offers": {
                        "$elemMatch": {
                            "driver_id": driver_id,
                            "status": "pending",
                        }
                    },
                    "status": {
                        "$in": ["REQUESTED", "DRIVER_NOTIFIED", "HOSPITAL_NOTIFIED", "HOSPITAL_ASSIGNED"]
                    },
                }
            ).sort("created_at", -1).limit(10)
        )
    except PyMongoError as exc:
        _logger.error("[OFFERS QUERY ERROR] %s", exc)
        return []

    results = []
    for doc in docs:
        offers = doc.get("driver_offers", [])
        for offer in offers:
            if offer.get("driver_id") != driver_id or offer.get("status") != "pending":
                continue

            # Check if expired
            if offer.get("expires_at", "") < now:
                continue

            loc = doc.get("location", {})
            results.append({
                "offer_id": offer["offer_id"],
                "emergency_id": str(doc["_id"]),
                "patient_phone": doc.get("phone_number", ""),
                "patient_address": loc.get("address", ""),
                "patient_lat": loc.get("lat"),
                "patient_lng": loc.get("lng"),
                "emergency_type": doc.get("emergency_type", ""),
                "severity": doc.get("severity", ""),
                "created_at": doc.get("created_at", ""),
                "expires_at": offer["expires_at"],
                "assigned_hospital": doc.get("assigned_hospital"),
            })

    _logger.info("[OFFERS] driver=%s has %d pending offer(s)", driver_id, len(results))
    return results


# ---------------------------------------------------------------------------
# First-Accept-Wins Driver Assignment
# ---------------------------------------------------------------------------

def accept_driver_offer(
    driver_id: str,
    emergency_id: str,
    offer_id: str,
) -> dict[str, Any]:
    """
    Atomically assign this driver to the emergency.

    The update only succeeds if driver_status is still 'offers_pending',
    ensuring exactly one driver wins the race.

    Returns dict with keys: assigned (bool), message (str).
    """
    now = datetime.now(tz=timezone.utc)

    try:
        # Atomic update: only succeed if no driver already assigned
        result = get_emergencies_collection().update_one(
            {
                "_id": _oid(emergency_id),
                "driver_status": "offers_pending",
                "driver_offers.offer_id": offer_id,
                "driver_offers.driver_id": driver_id,
                "driver_offers.status": "pending",
            },
            {
                "$set": {
                    "assigned_driver_id": driver_id,
                    "driver_status": "assigned",
                    "status": "DRIVER_ASSIGNED",
                    "driver_assigned_at": now,
                    "updated_at": now,
                    "driver_offers.$[matched].status": "accepted",
                },
            },
            array_filters=[{"matched.offer_id": offer_id}],
        )
    except PyMongoError as exc:
        _logger.error("[DRIVER ACCEPT ERROR] %s", exc)
        raise

    if result.matched_count == 0:
        _logger.warning(
            "[DRIVER ACCEPT LOST] driver=%s emergency=%s — race lost or expired",
            driver_id, emergency_id,
        )
        return {
            "assigned": False,
            "message": "Offer expired or another driver was already assigned.",
        }

    # Mark the driver as assigned in the drivers collection
    try:
        get_drivers_collection().update_one(
            {"email": driver_id},
            {
                "$set": {
                    "dispatch_status": "assigned",
                    "current_emergency_id": emergency_id,
                    "updated_at": now,
                }
            },
        )
    except PyMongoError as exc:
        _logger.error("[DRIVER STATUS UPDATE ERROR] %s", exc)

    # Cancel all other pending offers for this emergency
    try:
        get_emergencies_collection().update_one(
            {"_id": _oid(emergency_id)},
            {
                "$set": {
                    "driver_offers.$[other].status": "cancelled",
                }
            },
            array_filters=[{
                "other.offer_id": {"$ne": offer_id},
                "other.status": "pending",
            }],
        )
    except PyMongoError:
        pass  # Non-critical — just cleanup

    _logger.info(
        "[DRIVER ACCEPT WON] driver=%s emergency=%s offer=%s",
        driver_id, emergency_id, offer_id,
    )
    return {
        "assigned": True,
        "message": "You have been assigned to this emergency. Navigate to the patient now.",
    }


def reject_driver_offer(
    driver_id: str,
    emergency_id: str,
    offer_id: str,
) -> dict[str, Any]:
    """
    Record this driver's rejection. If all offers are now rejected/expired,
    expand the search radius and create new offers.
    """
    now = datetime.now(tz=timezone.utc)

    try:
        get_emergencies_collection().update_one(
            {
                "_id": _oid(emergency_id),
                "driver_offers.offer_id": offer_id,
            },
            {
                "$set": {
                    "driver_offers.$[matched].status": "rejected",
                    "updated_at": now,
                }
            },
            array_filters=[{"matched.offer_id": offer_id}],
        )
    except PyMongoError as exc:
        _logger.error("[DRIVER REJECT ERROR] %s", exc)
        raise

    _logger.info("[DRIVER REJECT] driver=%s emergency=%s", driver_id, emergency_id)

    # Check if all offers are now resolved (rejected or expired)
    try:
        doc = get_emergencies_collection().find_one({"_id": _oid(emergency_id)})
    except PyMongoError:
        return {"message": "Rejection recorded.", "fallback_triggered": False}

    if not doc:
        return {"message": "Emergency not found.", "fallback_triggered": False}

    offers = doc.get("driver_offers", [])
    still_pending = [
        o for o in offers
        if o.get("status") == "pending" and o.get("expires_at", "") >= now.isoformat()
    ]

    if still_pending:
        return {
            "message": f"Rejection recorded. {len(still_pending)} driver(s) still pending.",
            "fallback_triggered": False,
        }

    # All offers exhausted — try fallback radius
    rejected_ids = [o["driver_id"] for o in offers]
    loc = doc.get("location", {})
    lat = loc.get("lat")
    lng = loc.get("lng")

    if lat is None or lng is None:
        return {
            "message": "All drivers rejected. No coordinates for fallback.",
            "fallback_triggered": False,
        }

    _logger.warning(
        "[DRIVER FALLBACK] All offers rejected for emergency=%s — expanding to %dm",
        emergency_id, _FALLBACK_RADIUS_M,
    )

    new_drivers = find_nearest_drivers(
        lat, lng,
        radius_m=_FALLBACK_RADIUS_M,
        limit=_MAX_DRIVERS_TO_NOTIFY,
        exclude_ids=rejected_ids,
    )

    if not new_drivers:
        # Try extended radius
        new_drivers = find_nearest_drivers(
            lat, lng,
            radius_m=_EXTENDED_RADIUS_M,
            limit=_MAX_DRIVERS_TO_NOTIFY,
            exclude_ids=rejected_ids,
        )

    if not new_drivers:
        _logger.error("[DRIVER FALLBACK] No drivers found even at %dm", _EXTENDED_RADIUS_M)
        get_emergencies_collection().update_one(
            {"_id": _oid(emergency_id)},
            {"$set": {"driver_status": "no_drivers", "updated_at": now}},
        )
        return {
            "message": "All drivers rejected. No additional drivers available within 20 km.",
            "fallback_triggered": False,
        }

    new_offers = create_driver_offers(emergency_id, new_drivers)
    return {
        "message": f"Fallback triggered — {len(new_offers)} new driver(s) notified within expanded radius.",
        "fallback_triggered": True,
    }


# ---------------------------------------------------------------------------
# Active Mission Management
# ---------------------------------------------------------------------------

def get_active_mission(driver_id: str) -> dict[str, Any] | None:
    """
    Get the currently active emergency mission for a driver.
    Returns the full emergency document if the driver is assigned, else None.
    """
    try:
        doc = get_emergencies_collection().find_one({
            "assigned_driver_id": driver_id,
            "status": {
                "$in": [
                    "DRIVER_ASSIGNED",
                    "EN_ROUTE_PATIENT",
                    "PATIENT_PICKED",
                    "HOSPITAL_ASSIGNED",
                    "EN_ROUTE_HOSPITAL",
                ]
            },
        })
    except PyMongoError as exc:
        _logger.error("[ACTIVE MISSION ERROR] %s", exc)
        return None

    if not doc:
        return None

    loc = doc.get("location", {})

    mission: dict[str, Any] = {
        "emergency_id": str(doc["_id"]),
        "status": doc.get("status", ""),
        "patient_phone": doc.get("phone_number", ""),
        "patient_address": loc.get("address", ""),
        "patient_lat": loc.get("lat"),
        "patient_lng": loc.get("lng"),
        "emergency_type": doc.get("emergency_type", ""),
        "severity": doc.get("severity", ""),
        "assigned_hospital_id": doc.get("assigned_hospital"),
        "created_at": doc.get("created_at"),
        "driver_assigned_at": doc.get("driver_assigned_at"),
    }

    # If a hospital is assigned, fetch its details
    if mission["assigned_hospital_id"]:
        try:
            from database import get_hospitals_collection
            hospital = get_hospitals_collection().find_one(
                {"hospital_id": mission["assigned_hospital_id"]}
            )
            if hospital:
                mission["assigned_hospital_name"] = hospital.get("name", "")
                h_loc = hospital.get("location", {})
                if isinstance(h_loc, dict) and h_loc.get("type") == "Point":
                    coords = h_loc.get("coordinates", [])
                    if len(coords) >= 2:
                        mission["hospital_lng"] = coords[0]
                        mission["hospital_lat"] = coords[1]
        except Exception:
            pass  # Non-critical

    return mission


def _resolve_hospital_details(hospital_id: str) -> dict[str, Any] | None:
    """Fetch hospital name + GeoJSON coordinates for a hospital_id."""
    try:
        hospital = get_hospitals_collection().find_one({"hospital_id": hospital_id})
        if not hospital:
            return None

        details: dict[str, Any] = {
            "hospital_id": hospital_id,
            "name": hospital.get("name", "Unknown Hospital"),
            "address": hospital.get("address", ""),
            "available_beds": hospital.get("available_beds", hospital.get("bed_capacity", 0)),
        }

        h_loc = hospital.get("location", {})
        if isinstance(h_loc, dict) and h_loc.get("type") == "Point":
            coords = h_loc.get("coordinates", [])
            if len(coords) >= 2:
                details["lng"] = coords[0]
                details["lat"] = coords[1]

        return details
    except Exception as exc:
        _logger.warning("[HOSPITAL DETAILS] lookup failed for %s: %s", hospital_id, exc)
        return None


def _auto_assign_nearest_hospital(
    emergency_id: str,
    driver_lat: float,
    driver_lng: float,
) -> dict[str, Any] | None:
    """
    Automatically find the nearest hospital with available beds, assign it
    to the emergency, and return full hospital details for the driver.

    Called when the driver transitions to PATIENT_PICKED so they get
    immediate routing to the best available hospital.

    Returns a hospital details dict on success, or None if no hospital found.
    """
    try:
        from services.hospital_service import find_nearest_hospitals
    except Exception:
        _logger.error("[AUTO HOSPITAL] Could not import hospital_service")
        return None

    # Search within 5 km first, expand to 10 km, then 20 km
    for radius in (_DEFAULT_RADIUS_M, _FALLBACK_RADIUS_M, _EXTENDED_RADIUS_M):
        hospitals = find_nearest_hospitals(driver_lat, driver_lng, radius_m=radius, limit=5)
        if hospitals:
            break
    else:
        _logger.warning(
            "[AUTO HOSPITAL] No hospitals found within %dm for emergency=%s",
            _EXTENDED_RADIUS_M, emergency_id,
        )
        return None

    # Pick the nearest hospital that has available beds
    chosen = None
    for h in hospitals:
        beds = h.get("available_beds", 0)
        if beds > 0:
            chosen = h
            break

    # Fallback: pick nearest even if beds unknown
    if not chosen:
        chosen = hospitals[0]

    hospital_id = chosen["hospital_id"]
    now = datetime.now(tz=timezone.utc)

    # Atomically assign — only if no hospital is already assigned
    try:
        assign_result = get_emergencies_collection().update_one(
            {
                "_id": _oid(emergency_id),
                "$or": [
                    {"assigned_hospital": None},
                    {"assigned_hospital": {"$exists": False}},
                ],
            },
            {
                "$set": {
                    "assigned_hospital": hospital_id,
                    "hospital_status": "auto_assigned",
                    "updated_at": now,
                },
                "$addToSet": {
                    "notified_hospitals": hospital_id,
                },
            },
        )

        if assign_result.modified_count == 0:
            # Hospital already assigned by earlier flow — fetch that one instead
            doc = get_emergencies_collection().find_one({"_id": _oid(emergency_id)})
            existing_id = doc.get("assigned_hospital") if doc else None
            if existing_id:
                _logger.info(
                    "[AUTO HOSPITAL] Hospital already assigned (%s) for emergency=%s",
                    existing_id, emergency_id,
                )
                return _resolve_hospital_details(existing_id)
            return None
    except PyMongoError as exc:
        _logger.error("[AUTO HOSPITAL DB ERROR] %s", exc)
        return None

    _logger.info(
        "[AUTO HOSPITAL] Assigned %s (%s) to emergency=%s | beds=%s | dist=%sm",
        chosen["name"], hospital_id, emergency_id,
        chosen.get("available_beds"), chosen.get("distance_m"),
    )

    # Return full details for the driver's navigation
    details = _resolve_hospital_details(hospital_id)
    if details:
        details["distance_m"] = chosen.get("distance_m")
    else:
        # Fallback to search result data if DB lookup returns nothing extra
        details = {
            "hospital_id": hospital_id,
            "name": chosen.get("name", "Unknown Hospital"),
            "address": chosen.get("address", ""),
            "available_beds": chosen.get("available_beds", 0),
            "distance_m": chosen.get("distance_m"),
        }

    return details


def update_mission_status(
    driver_id: str,
    emergency_id: str,
    new_status: str,
    lat: float | None = None,
    lng: float | None = None,
) -> dict[str, Any]:
    """
    Transition the emergency status as the driver progresses through the mission.

    Valid transitions:
        DRIVER_ASSIGNED → EN_ROUTE_PATIENT
        EN_ROUTE_PATIENT → PATIENT_PICKED
        PATIENT_PICKED → EN_ROUTE_HOSPITAL
        EN_ROUTE_HOSPITAL → COMPLETED

    When transitioning to PATIENT_PICKED, the system automatically:
        1. Finds the nearest hospital with available beds
        2. Assigns it to the emergency
        3. Returns hospital details (name, lat, lng) for driver navigation
    """
    valid_transitions = {
        "EN_ROUTE_PATIENT": ["DRIVER_ASSIGNED"],
        "PATIENT_PICKED": ["EN_ROUTE_PATIENT"],
        "EN_ROUTE_HOSPITAL": ["PATIENT_PICKED", "HOSPITAL_ASSIGNED"],
        "COMPLETED": ["EN_ROUTE_HOSPITAL"],
    }

    allowed_from = valid_transitions.get(new_status)
    if not allowed_from:
        return {"success": False, "message": f"Invalid status transition target: {new_status}"}

    now = datetime.now(tz=timezone.utc)

    update_fields: dict[str, Any] = {
        "status": new_status,
        "updated_at": now,
    }

    if new_status == "COMPLETED":
        update_fields["completed_at"] = now

    try:
        result = get_emergencies_collection().update_one(
            {
                "_id": _oid(emergency_id),
                "assigned_driver_id": driver_id,
                "status": {"$in": allowed_from},
            },
            {"$set": update_fields},
        )
    except PyMongoError as exc:
        _logger.error("[MISSION UPDATE ERROR] %s", exc)
        return {"success": False, "message": f"Database error: {exc}"}

    if result.matched_count == 0:
        return {
            "success": False,
            "message": f"Cannot transition to {new_status}. Current status may not allow this transition.",
        }

    # ── PATIENT_PICKED: auto-discover and assign nearest hospital ──────
    recommended_hospital: dict[str, Any] | None = None
    if new_status == "PATIENT_PICKED" and lat is not None and lng is not None:
        recommended_hospital = _auto_assign_nearest_hospital(
            emergency_id=emergency_id,
            driver_lat=lat,
            driver_lng=lng,
        )
        if recommended_hospital:
            _logger.info(
                "[MISSION UPDATE] Auto-assigned hospital %s for emergency=%s",
                recommended_hospital.get("name"), emergency_id,
            )
    elif new_status == "PATIENT_PICKED":
        # No GPS — try using the patient's location from the emergency doc
        try:
            doc = get_emergencies_collection().find_one({"_id": _oid(emergency_id)})
            if doc:
                eloc = doc.get("location", {})
                plat = eloc.get("lat")
                plng = eloc.get("lng")
                if plat is not None and plng is not None:
                    recommended_hospital = _auto_assign_nearest_hospital(
                        emergency_id=emergency_id,
                        driver_lat=plat,
                        driver_lng=plng,
                    )
        except Exception:
            pass

    # ── COMPLETED: free the driver ────────────────────────────────────
    if new_status == "COMPLETED":
        try:
            get_drivers_collection().update_one(
                {"email": driver_id},
                {
                    "$set": {
                        "dispatch_status": "online",
                        "current_emergency_id": None,
                        "updated_at": now,
                    }
                },
            )
        except PyMongoError:
            pass

    _logger.info(
        "[MISSION UPDATE] driver=%s emergency=%s → %s",
        driver_id, emergency_id, new_status,
    )

    response: dict[str, Any] = {
        "success": True,
        "message": f"Status updated to {new_status}.",
    }

    if recommended_hospital:
        response["recommended_hospital"] = recommended_hospital
        response["message"] = (
            f"Status updated to {new_status}. "
            f"Recommended hospital: {recommended_hospital.get('name', 'Unknown')} "
            f"({recommended_hospital.get('available_beds', '?')} beds available)"
        )

    return response


# ---------------------------------------------------------------------------
# Driver Profile & Settings
# ---------------------------------------------------------------------------

def get_driver_profile(driver_id: str) -> dict[str, Any] | None:
    """Fetch driver profile info."""
    try:
        doc = get_drivers_collection().find_one({"email": driver_id})
    except PyMongoError as exc:
        _logger.error("[DRIVER PROFILE ERROR] %s", exc)
        return None
    if not doc:
        return None
    return {
        "driver_id": doc.get("email", ""),
        "name": doc.get("name", ""),
        "email": doc.get("email", ""),
        "phone": doc.get("phone", ""),
        "dispatch_status": doc.get("dispatch_status", "offline"),
        "call_sign": doc.get("call_sign", ""),
        "vehicle_id": doc.get("vehicle_id", ""),
        "joined_at": str(doc.get("created_at", "")) if doc.get("created_at") else None,
        "settings": doc.get("settings", {}),
    }


def update_driver_profile(
    driver_id: str,
    name: str | None = None,
    phone: str | None = None,
) -> dict[str, Any]:
    """Update editable driver profile fields."""
    update_fields: dict[str, Any] = {"updated_at": datetime.now(tz=timezone.utc)}
    if name is not None:
        update_fields["name"] = name
    if phone is not None:
        update_fields["phone"] = phone
    try:
        result = get_drivers_collection().update_one(
            {"email": driver_id},
            {"$set": update_fields},
        )
        if result.matched_count == 0:
            return {"success": False, "message": "Driver not found."}
        return {"success": True, "message": "Profile updated."}
    except PyMongoError as exc:
        _logger.error("[DRIVER PROFILE UPDATE ERROR] %s", exc)
        return {"success": False, "message": f"Database error: {exc}"}


def update_driver_settings(
    driver_id: str,
    settings: dict[str, Any],
) -> dict[str, Any]:
    """Update driver preference settings (notification prefs, critical only, etc)."""
    try:
        # Merge into existing settings
        update_fields: dict[str, Any] = {
            "updated_at": datetime.now(tz=timezone.utc),
        }
        # Handle dispatch_status separately if included
        if "dispatch_status" in settings:
            update_fields["dispatch_status"] = settings.pop("dispatch_status")
        if settings:
            for k, v in settings.items():
                update_fields[f"settings.{k}"] = v

        result = get_drivers_collection().update_one(
            {"email": driver_id},
            {"$set": update_fields},
        )
        if result.matched_count == 0:
            return {"success": False, "message": "Driver not found."}
        return {"success": True, "message": "Settings updated."}
    except PyMongoError as exc:
        _logger.error("[DRIVER SETTINGS ERROR] %s", exc)
        return {"success": False, "message": f"Database error: {exc}"}


# ---------------------------------------------------------------------------
# Mission History & Stats
# ---------------------------------------------------------------------------

def get_driver_mission_history(
    driver_id: str,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """
    Fetch all past emergencies assigned to this driver.
    Returns missions sorted newest first.
    """
    try:
        docs = list(
            get_emergencies_collection()
            .find({"assigned_driver_id": driver_id})
            .sort("created_at", -1)
            .limit(limit)
        )
    except PyMongoError as exc:
        _logger.error("[MISSION HISTORY ERROR] %s", exc)
        return []

    missions = []
    for doc in docs:
        loc = doc.get("location", {})
        created = doc.get("created_at")
        completed = doc.get("completed_at")
        assigned_at = doc.get("driver_assigned_at")

        # Calculate duration in minutes
        duration_min = 0
        if created and completed:
            try:
                delta = completed - created
                duration_min = max(1, int(delta.total_seconds() / 60))
            except Exception:
                duration_min = 0

        # Estimate response time (from creation to driver assignment)
        response_time_min = 0
        if created and assigned_at:
            try:
                delta = assigned_at - created
                response_time_min = max(0, round(delta.total_seconds() / 60, 1))
            except Exception:
                pass

        # Estimate distance from location data (simplified)
        distance_km = 0.0
        patient_lat = loc.get("lat")
        patient_lng = loc.get("lng")
        if patient_lat and patient_lng:
            # Try to get hospital location for distance calc
            hospital_id = doc.get("assigned_hospital")
            if hospital_id:
                try:
                    from database import get_hospitals_collection
                    hospital = get_hospitals_collection().find_one({"hospital_id": hospital_id})
                    if hospital:
                        h_loc = hospital.get("location", {})
                        if isinstance(h_loc, dict) and h_loc.get("type") == "Point":
                            coords = h_loc.get("coordinates", [])
                            if len(coords) >= 2:
                                import math
                                dx = (coords[0] - patient_lng) * math.cos(math.radians(patient_lat)) * 111.32
                                dy = (coords[1] - patient_lat) * 111.32
                                distance_km = round(math.sqrt(dx*dx + dy*dy), 1)
                except Exception:
                    pass
            if distance_km == 0:
                # Default estimate based on duration
                distance_km = round(duration_min * 0.5, 1)  # ~30 km/h avg

        # Earnings calculation
        base_pay = max(280, round(distance_km * 34 + duration_min * 3.5))
        severity = doc.get("severity", "low")
        is_critical = severity in ("critical", "high")
        golden_hour_met = duration_min <= 60 if doc.get("status") == "COMPLETED" else False
        bonus = (100 if golden_hour_met else 0) + (50 if is_critical else 0)
        total_earnings = base_pay + bonus

        # Map status to user-friendly values
        status_raw = doc.get("status", "REQUESTED")
        if status_raw == "COMPLETED":
            display_status = "Completed"
            payout_status = "Paid"
        elif status_raw == "CANCELLED":
            display_status = "Cancelled"
            payout_status = "N/A"
        elif status_raw in ("DRIVER_ASSIGNED", "EN_ROUTE_PATIENT", "PATIENT_PICKED", "EN_ROUTE_HOSPITAL"):
            display_status = "Ongoing"
            payout_status = "Pending"
        else:
            display_status = "Requested"
            payout_status = "Pending"

        # Map severity to priority label
        priority_map = {"critical": "Critical", "high": "High", "medium": "Medium", "low": "Low"}
        priority = priority_map.get(severity, "Low")

        missions.append({
            "missionId": str(doc["_id"]),
            "createdAt": str(created) if created else "",
            "completedAt": str(completed) if completed else None,
            "patientPhone": doc.get("phone_number", ""),
            "patientAddress": loc.get("address", ""),
            "patientLat": patient_lat,
            "patientLng": patient_lng,
            "emergencyType": doc.get("emergency_type", ""),
            "severity": severity,
            "priority": priority,
            "status": display_status,
            "rawStatus": status_raw,
            "distanceKm": distance_km,
            "durationMin": duration_min,
            "responseTimeMin": response_time_min,
            "basePay": base_pay,
            "bonus": bonus,
            "earningsInr": total_earnings,
            "goldenHourMet": golden_hour_met,
            "payoutStatus": payout_status,
            "assignedHospital": doc.get("assigned_hospital"),
            "assignedHospitalName": None,  # Can be enriched if needed
        })

    _logger.info("[MISSION HISTORY] driver=%s → %d mission(s)", driver_id, len(missions))
    return missions


def get_driver_stats(driver_id: str) -> dict[str, Any]:
    """
    Compute aggregate stats for a driver from their mission history.
    """
    missions = get_driver_mission_history(driver_id, limit=500)
    completed = [m for m in missions if m["status"] == "Completed"]
    ongoing = [m for m in missions if m["status"] == "Ongoing"]
    cancelled = [m for m in missions if m["status"] == "Cancelled"]

    total_earnings = sum(m["earningsInr"] for m in completed)
    total_distance = sum(m["distanceKm"] for m in completed)
    avg_response = (
        round(sum(m["responseTimeMin"] for m in completed) / len(completed), 1)
        if completed else 0
    )
    golden_count = sum(1 for m in completed if m["goldenHourMet"])
    golden_rate = round((golden_count / len(completed)) * 100, 1) if completed else 0
    success_rate = (
        round((len(completed) / len(missions)) * 100, 1)
        if missions else 0
    )

    return {
        "totalMissions": len(missions),
        "completedMissions": len(completed),
        "ongoingMissions": len(ongoing),
        "cancelledMissions": len(cancelled),
        "totalEarnings": total_earnings,
        "totalDistance": round(total_distance, 1),
        "avgResponseTimeMin": avg_response,
        "goldenHourRate": golden_rate,
        "successRate": success_rate,
    }


def get_driver_earnings(driver_id: str) -> dict[str, Any]:
    """
    Compute detailed earnings data for charts and tables.
    """
    missions = get_driver_mission_history(driver_id, limit=500)
    completed = [m for m in missions if m["status"] == "Completed"]

    now = datetime.now(tz=timezone.utc)
    week_ago = now - timedelta(days=7)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    total_earnings = sum(m["earningsInr"] for m in completed)
    total_bonuses = sum(m["bonus"] for m in completed)
    pending_payout = sum(m["earningsInr"] for m in completed if m["payoutStatus"] == "Pending")

    # This-week earnings
    week_earnings = 0
    for m in completed:
        try:
            created = datetime.fromisoformat(m["createdAt"].replace("Z", "+00:00")) if m["createdAt"] else None
            if created and created >= week_ago:
                week_earnings += m["earningsInr"]
        except Exception:
            pass

    # This-month earnings
    month_earnings = 0
    for m in completed:
        try:
            created = datetime.fromisoformat(m["createdAt"].replace("Z", "+00:00")) if m["createdAt"] else None
            if created and created >= month_start:
                month_earnings += m["earningsInr"]
        except Exception:
            pass

    avg_per_mission = round(total_earnings / len(completed)) if completed else 0

    # Weekly chart data (last 8 weeks)
    weekly_data = []
    for i in range(7, -1, -1):
        week_start = now - timedelta(weeks=i+1)
        week_end = now - timedelta(weeks=i)
        week_total = 0
        for m in completed:
            try:
                created = datetime.fromisoformat(m["createdAt"].replace("Z", "+00:00")) if m["createdAt"] else None
                if created and week_start <= created < week_end:
                    week_total += m["earningsInr"]
            except Exception:
                pass
        weekly_data.append({
            "week": f"W{8-i}",
            "amount": week_total,
        })

    return {
        "totalEarnings": total_earnings,
        "thisWeekEarnings": week_earnings,
        "thisMonthEarnings": month_earnings,
        "pendingPayout": pending_payout,
        "totalBonuses": total_bonuses,
        "avgPerMission": avg_per_mission,
        "weeklyChart": weekly_data,
        "completedMissions": len(completed),
    }
