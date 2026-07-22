"""
Driver Operations Routes
=========================
Thin route layer for driver location tracking, dispatch offers,
and mission management. All business logic is in driver_service.py.

Endpoints:
    POST /api/driver/location          Driver GPS ping
    GET  /api/driver/offers            Poll pending dispatch offers
    POST /api/driver/offer/accept      Accept a dispatch offer (first-wins)
    POST /api/driver/offer/reject      Reject a dispatch offer
    GET  /api/driver/active-mission    Get current mission details
    POST /api/driver/mission/update    Update mission status (state transitions)
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query, status

from schemas.driver_ops import (
    ActiveMission,
    ActiveMissionResponse,
    DriverLocationUpdate,
    DriverOfferAction,
    DriverOfferItem,
    DriverOffersResponse,
    DriverOfferActionResponse,
    LocationUpdateResponse,
    MissionStatusUpdate,
    MissionUpdateResponse,
    RecommendedHospital,
)
from services.driver_service import (
    accept_driver_offer,
    get_active_mission,
    get_driver_earnings,
    get_driver_mission_history,
    get_driver_profile,
    get_driver_stats,
    get_pending_offers_for_driver,
    reject_driver_offer,
    update_driver_location,
    update_driver_profile,
    update_driver_settings,
    update_mission_status,
)

_logger = logging.getLogger(__name__)
router = APIRouter()


# ---------------------------------------------------------------------------
# POST /api/driver/location
# ---------------------------------------------------------------------------

@router.post(
    "/driver/location",
    response_model=LocationUpdateResponse,
    summary="Driver GPS location ping",
)
async def driver_location_endpoint(payload: DriverLocationUpdate):
    """
    Accept a GPS ping from a driver. Updates their GeoJSON location
    in MongoDB for geospatial queries.
    """
    success = update_driver_location(
        driver_id=payload.driver_id,
        lat=payload.lat,
        lng=payload.lng,
        speed_kmph=payload.speed_kmph,
        heading=payload.heading,
    )

    if not success:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Failed to update driver location.",
        )

    return LocationUpdateResponse(
        success=True,
        message="Location updated.",
    )


# ---------------------------------------------------------------------------
# GET /api/driver/offers
# ---------------------------------------------------------------------------

@router.get(
    "/driver/offers",
    response_model=DriverOffersResponse,
    summary="Poll for pending dispatch offers",
)
async def driver_offers_endpoint(
    driver_id: str = Query(..., description="Driver email/ID to check offers for"),
):
    """
    Returns all pending dispatch offers for this driver.
    Drivers should poll this endpoint every 5 seconds.
    """
    raw_offers = get_pending_offers_for_driver(driver_id)

    offers = [
        DriverOfferItem(
            offer_id=o["offer_id"],
            emergency_id=o["emergency_id"],
            patient_phone=o["patient_phone"],
            patient_address=o["patient_address"],
            patient_lat=o.get("patient_lat"),
            patient_lng=o.get("patient_lng"),
            emergency_type=o["emergency_type"],
            severity=o["severity"],
            created_at=str(o["created_at"]) if o.get("created_at") else None,
            expires_at=o["expires_at"],
            assigned_hospital=o.get("assigned_hospital"),
        )
        for o in raw_offers
    ]

    return DriverOffersResponse(
        success=True,
        count=len(offers),
        offers=offers,
    )


# ---------------------------------------------------------------------------
# POST /api/driver/offer/accept
# ---------------------------------------------------------------------------

@router.post(
    "/driver/offer/accept",
    response_model=DriverOfferActionResponse,
    summary="Accept a dispatch offer (first-accept-wins)",
)
async def driver_offer_accept_endpoint(payload: DriverOfferAction):
    """
    Atomically assign this driver to the emergency.
    Only the first driver to accept wins — all others get rejected.
    """
    try:
        result = accept_driver_offer(
            driver_id=payload.driver_id,
            emergency_id=payload.emergency_id,
            offer_id=payload.offer_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    except Exception as exc:
        _logger.exception("Unexpected error in accept_driver_offer: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal server error.",
        )

    if not result["assigned"]:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=result["message"],
        )

    return DriverOfferActionResponse(
        success=True,
        message=result["message"],
        emergency_id=payload.emergency_id,
        assigned=True,
    )


# ---------------------------------------------------------------------------
# POST /api/driver/offer/reject
# ---------------------------------------------------------------------------

@router.post(
    "/driver/offer/reject",
    response_model=DriverOfferActionResponse,
    summary="Reject a dispatch offer",
)
async def driver_offer_reject_endpoint(payload: DriverOfferAction):
    """
    Record this driver's rejection. If all offers are exhausted,
    automatically expand search radius and notify new drivers.
    """
    try:
        result = reject_driver_offer(
            driver_id=payload.driver_id,
            emergency_id=payload.emergency_id,
            offer_id=payload.offer_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    except Exception as exc:
        _logger.exception("Unexpected error in reject_driver_offer: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal server error.",
        )

    return DriverOfferActionResponse(
        success=True,
        message=result["message"],
        emergency_id=payload.emergency_id,
        assigned=False,
    )


# ---------------------------------------------------------------------------
# GET /api/driver/active-mission
# ---------------------------------------------------------------------------

@router.get(
    "/driver/active-mission",
    response_model=ActiveMissionResponse,
    summary="Get the driver's current active mission",
)
async def driver_active_mission_endpoint(
    driver_id: str = Query(..., description="Driver email/ID"),
):
    """
    Returns the currently assigned emergency for this driver,
    including patient location, hospital assignment, and mission status.
    """
    mission_data = get_active_mission(driver_id)

    if not mission_data:
        return ActiveMissionResponse(
            success=True,
            mission=None,
            message="No active mission.",
        )

    mission = ActiveMission(
        emergency_id=mission_data["emergency_id"],
        status=mission_data["status"],
        patient_phone=mission_data["patient_phone"],
        patient_address=mission_data["patient_address"],
        patient_lat=mission_data.get("patient_lat"),
        patient_lng=mission_data.get("patient_lng"),
        emergency_type=mission_data["emergency_type"],
        severity=mission_data["severity"],
        assigned_hospital_id=mission_data.get("assigned_hospital_id"),
        assigned_hospital_name=mission_data.get("assigned_hospital_name"),
        hospital_lat=mission_data.get("hospital_lat"),
        hospital_lng=mission_data.get("hospital_lng"),
        created_at=str(mission_data["created_at"]) if mission_data.get("created_at") else None,
        driver_assigned_at=str(mission_data["driver_assigned_at"]) if mission_data.get("driver_assigned_at") else None,
    )

    return ActiveMissionResponse(
        success=True,
        mission=mission,
        message="Active mission found.",
    )


# ---------------------------------------------------------------------------
# POST /api/driver/mission/update
# ---------------------------------------------------------------------------

@router.post(
    "/driver/mission/update",
    response_model=MissionUpdateResponse,
    summary="Update mission status (state machine transitions)",
)
async def driver_mission_update_endpoint(payload: MissionStatusUpdate):
    """
    Transition the emergency through its lifecycle:
        DRIVER_ASSIGNED → EN_ROUTE_PATIENT → PATIENT_PICKED → EN_ROUTE_HOSPITAL → COMPLETED

    When transitioning to PATIENT_PICKED, the backend automatically discovers
    the nearest hospital with available beds and returns it for driver navigation.
    """
    result = update_mission_status(
        driver_id=payload.driver_id,
        emergency_id=payload.emergency_id,
        new_status=payload.status,
        lat=payload.lat,
        lng=payload.lng,
    )

    if not result["success"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=result["message"],
        )

    # Build recommended hospital object if the service returned one
    rec_hospital = None
    rec_data = result.get("recommended_hospital")
    if rec_data and isinstance(rec_data, dict):
        rec_hospital = RecommendedHospital(
            hospital_id=rec_data.get("hospital_id", ""),
            name=rec_data.get("name", "Unknown Hospital"),
            address=rec_data.get("address", ""),
            available_beds=rec_data.get("available_beds"),
            lat=rec_data.get("lat"),
            lng=rec_data.get("lng"),
            distance_m=rec_data.get("distance_m"),
        )

    return MissionUpdateResponse(
        success=True,
        message=result["message"],
        new_status=payload.status,
        recommended_hospital=rec_hospital,
    )


# ---------------------------------------------------------------------------
# GET /api/driver/missions
# ---------------------------------------------------------------------------

@router.get(
    "/driver/missions",
    summary="Get driver's mission history",
)
async def driver_missions_endpoint(
    driver_id: str = Query(..., description="Driver email/ID"),
):
    """Returns all past missions for this driver."""
    missions = get_driver_mission_history(driver_id)
    return {"success": True, "count": len(missions), "missions": missions}


# ---------------------------------------------------------------------------
# GET /api/driver/earnings
# ---------------------------------------------------------------------------

@router.get(
    "/driver/earnings",
    summary="Get driver's earnings data",
)
async def driver_earnings_endpoint(
    driver_id: str = Query(..., description="Driver email/ID"),
):
    """Returns detailed earnings breakdown and chart data."""
    earnings = get_driver_earnings(driver_id)
    return {"success": True, **earnings}


# ---------------------------------------------------------------------------
# GET /api/driver/stats
# ---------------------------------------------------------------------------

@router.get(
    "/driver/stats",
    summary="Get driver's aggregate statistics",
)
async def driver_stats_endpoint(
    driver_id: str = Query(..., description="Driver email/ID"),
):
    """Returns aggregate performance stats."""
    stats = get_driver_stats(driver_id)
    return {"success": True, **stats}


# ---------------------------------------------------------------------------
# GET /api/driver/profile
# ---------------------------------------------------------------------------

@router.get(
    "/driver/profile",
    summary="Get driver profile",
)
async def driver_profile_get_endpoint(
    driver_id: str = Query(..., description="Driver email/ID"),
):
    """Returns driver profile information."""
    profile = get_driver_profile(driver_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Driver not found.")
    return {"success": True, **profile}


# ---------------------------------------------------------------------------
# PUT /api/driver/profile
# ---------------------------------------------------------------------------

@router.put(
    "/driver/profile",
    summary="Update driver profile",
)
async def driver_profile_update_endpoint(payload: dict):
    """Update editable profile fields (name, phone)."""
    driver_id = payload.get("driver_id")
    if not driver_id:
        raise HTTPException(status_code=400, detail="driver_id is required.")
    result = update_driver_profile(
        driver_id=driver_id,
        name=payload.get("name"),
        phone=payload.get("phone"),
    )
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["message"])
    return result


# ---------------------------------------------------------------------------
# PUT /api/driver/settings
# ---------------------------------------------------------------------------

@router.put(
    "/driver/settings",
    summary="Update driver settings",
)
async def driver_settings_update_endpoint(payload: dict):
    """Update driver preferences (availability, notifications, etc)."""
    driver_id = payload.get("driver_id")
    if not driver_id:
        raise HTTPException(status_code=400, detail="driver_id is required.")
    settings = {k: v for k, v in payload.items() if k != "driver_id"}
    result = update_driver_settings(driver_id=driver_id, settings=settings)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["message"])
    return result
