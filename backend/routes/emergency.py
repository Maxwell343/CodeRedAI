"""
Emergency Coordination Routes
==============================
Thin route layer — all business logic is delegated to services.

Endpoints:
    POST /api/emergency              Create emergency + geo-notify hospitals
    POST /api/hospital/accept        Atomic hospital acceptance + ambulance dispatch
    POST /api/hospital/reject        Rejection with automatic 10 km fallback
    GET  /api/hospital/pending       List pending emergencies for hospital dashboard
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query, status

from schemas.emergency import (
    AcceptEmergencyRequest,
    AcceptEmergencyResponse,
    AmbulanceInfo,
    CreateEmergencyRequest,
    CreateEmergencyResponse,
    NotifiedHospitalInfo,
    PendingEmergenciesResponse,
    PendingEmergencyItem,
    RejectEmergencyRequest,
    RejectEmergencyResponse,
)
from services.driver_service import (
    create_driver_offers,
    find_nearest_drivers,
)
from services.emergency_service import (
    VALID_EMERGENCY_TYPES,
    create_emergency,
    save_to_db,
)
from services.hospital_service import (
    accept_emergency,
    find_nearest_hospitals,
    get_pending_emergencies,
    notify_hospitals,
    reject_emergency,
)

_logger = logging.getLogger(__name__)
router = APIRouter()


# ---------------------------------------------------------------------------
# POST /api/emergency
# ---------------------------------------------------------------------------

@router.post(
    "/emergency",
    response_model=CreateEmergencyResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Report an emergency and notify nearby hospitals",
)
async def create_emergency_endpoint(payload: CreateEmergencyRequest):
    """
    Full emergency intake flow:
    1. Validate emergency type
    2. Build + persist emergency document
    3. Geo-search for nearest active hospitals within 5 km
    4. Notify matched hospitals
    5. Return confirmation with notified hospital list
    """
    etype = payload.emergency_type.lower().strip()
    if etype not in VALID_EMERGENCY_TYPES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid emergency_type '{etype}'. Valid values: {sorted(VALID_EMERGENCY_TYPES)}",
        )

    # Step 1: build and save emergency
    doc = create_emergency(
        phone_number=payload.phone_number,
        lat=payload.lat,
        lng=payload.lng,
        address=payload.address,
        emergency_type=etype,
    )
    emergency_id = save_to_db(doc)
    if not emergency_id:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Could not persist emergency to database. Check MongoDB connectivity.",
        )

    # Step 2: geo-search nearest hospitals (parallel branch 1)
    hospitals = find_nearest_hospitals(payload.lat, payload.lng)

    # Step 3: notify matched hospitals (updates MongoDB + logs)
    notify_hospitals(emergency_id, hospitals)

    # Step 4: geo-search nearest drivers (parallel branch 2)
    drivers = find_nearest_drivers(payload.lat, payload.lng)

    # Step 5: create dispatch offers for drivers
    driver_offers = create_driver_offers(emergency_id, drivers)

    # Update emergency status to reflect notifications sent
    if hospitals or drivers:
        from datetime import datetime, timezone
        from bson import ObjectId
        new_status = "DRIVER_NOTIFIED" if drivers else "HOSPITAL_NOTIFIED"
        try:
            from database import get_emergencies_collection
            get_emergencies_collection().update_one(
                {"_id": ObjectId(emergency_id)},
                {"$set": {"status": new_status, "updated_at": datetime.now(tz=timezone.utc)}},
            )
        except Exception:
            pass  # Non-critical status update

    notified = [
        NotifiedHospitalInfo(
            hospital_id=h["hospital_id"],
            name=h["name"],
            distance_m=h.get("distance_m"),
        )
        for h in hospitals
    ]

    msg = (
        f"Emergency created. {len(hospitals)} hospital(s) and {len(drivers)} driver(s) notified within 5 km."
        if hospitals or drivers
        else "Emergency created. No active hospitals or drivers found within 5 km — try again shortly."
    )

    return CreateEmergencyResponse(
        success=True,
        emergency_id=emergency_id,
        severity=doc["severity"],
        notified_hospitals=notified,
        message=msg,
    )


# ---------------------------------------------------------------------------
# POST /api/hospital/accept
# ---------------------------------------------------------------------------

@router.post(
    "/hospital/accept",
    response_model=AcceptEmergencyResponse,
    summary="Hospital accepts an emergency (race-condition safe)",
)
async def hospital_accept_endpoint(payload: AcceptEmergencyRequest):
    """
    Atomically assign this hospital to the emergency.
    Only the first hospital to successfully POST here wins.
    On success, ambulance is dispatched immediately.
    """
    try:
        result = accept_emergency(
            hospital_id=payload.hospital_id,
            emergency_id=payload.emergency_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    except Exception as exc:
        _logger.exception("Unexpected error in accept_emergency: %s", exc)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Internal server error.")

    if not result["won"]:
        # Another hospital already accepted — return 409
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=result["message"],
        )

    ambulance_data = result.get("ambulance")
    ambulance_info = AmbulanceInfo(**ambulance_data) if ambulance_data else None

    return AcceptEmergencyResponse(
        success=True,
        message=result["message"],
        ambulance=ambulance_info,
    )


# ---------------------------------------------------------------------------
# POST /api/hospital/reject
# ---------------------------------------------------------------------------

@router.post(
    "/hospital/reject",
    response_model=RejectEmergencyResponse,
    summary="Hospital rejects an emergency; triggers 10 km fallback if all reject",
)
async def hospital_reject_endpoint(payload: RejectEmergencyRequest):
    """
    Record this hospital's rejection of the emergency.
    If all notified hospitals have now rejected, the system automatically
    searches within 10 km and notifies the next available hospitals.
    """
    try:
        result = reject_emergency(
            hospital_id=payload.hospital_id,
            emergency_id=payload.emergency_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    except Exception as exc:
        _logger.exception("Unexpected error in reject_emergency: %s", exc)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Internal server error.")

    new_notified = [
        NotifiedHospitalInfo(
            hospital_id=h["hospital_id"],
            name=h["name"],
            distance_m=h.get("distance_m"),
        )
        for h in result.get("new_hospitals", [])
    ]

    return RejectEmergencyResponse(
        success=True,
        message=result["message"],
        fallback_triggered=result.get("fallback_triggered", False),
        new_notified_hospitals=new_notified,
    )


# ---------------------------------------------------------------------------
# GET /api/hospital/pending
# ---------------------------------------------------------------------------

@router.get(
    "/hospital/pending",
    response_model=PendingEmergenciesResponse,
    summary="List emergencies awaiting hospital acceptance",
)
async def hospital_pending_endpoint(
    hospital_id: str | None = Query(
        default=None,
        description="Filter to only emergencies where this hospital was notified. Leave blank for all.",
    ),
):
    """
    Returns all emergencies with hospital_status='pending'.
    Hospitals can optionally filter by their own ID to see only their assignments.
    """
    emergencies_raw = get_pending_emergencies(hospital_id=hospital_id)

    items = [
        PendingEmergencyItem(
            emergency_id=e["emergency_id"],
            phone_number=e["phone_number"],
            address=e["address"],
            emergency_type=e["emergency_type"],
            severity=e["severity"],
            created_at=e.get("created_at"),
            notified_hospitals=e.get("notified_hospitals", []),
        )
        for e in emergencies_raw
    ]

    return PendingEmergenciesResponse(
        success=True,
        count=len(items),
        emergencies=items,
    )
