"""
Metrics Service
===============
Tracks timings, response rates, and system performance metrics for
emergency operations.
"""
import logging
from datetime import datetime, timezone
from typing import Any

from bson import ObjectId
from pymongo.errors import PyMongoError

from database import get_emergencies_collection

_logger = logging.getLogger(__name__)

# Note: For full metrics we could create a separate "metrics" collection,
# but for MVP, calculating from the emergencies collection directly is sufficient.

def get_system_metrics() -> dict[str, Any]:
    """Calculate aggregated emergency metrics from the emergencies collection."""
    try:
        pipeline = [
            {
                "$group": {
                    "_id": None,
                    "total_emergencies": {"$sum": 1},
                    "completed_emergencies": {
                        "$sum": {"$cond": [{"$eq": ["$status", "COMPLETED"]}, 1, 0]}
                    },
                    "active_emergencies": {
                        "$sum": {"$cond": [
                            {"$in": ["$status", [
                                "REQUESTED", "DRIVER_NOTIFIED", "HOSPITAL_NOTIFIED",
                                "DRIVER_ASSIGNED", "EN_ROUTE_PATIENT", "PATIENT_PICKED",
                                "HOSPITAL_ASSIGNED", "EN_ROUTE_HOSPITAL"
                            ]]}, 1, 0
                        ]}
                    },
                    "cancelled_emergencies": {
                        "$sum": {"$cond": [{"$eq": ["$status", "CANCELLED"]}, 1, 0]}
                    },
                }
            }
        ]
        results = list(get_emergencies_collection().aggregate(pipeline))
        if not results:
            return {
                "success": True,
                "total_emergencies": 0,
                "active_emergencies": 0,
                "driver_acceptance_rate": 0,
                "hospital_acceptance_rate": 0,
            }
        
        stats = results[0]
        return {
            "success": True,
            "total_emergencies": stats.get("total_emergencies", 0),
            "active_emergencies": stats.get("active_emergencies", 0),
            # Simple estimations for MVP
            "driver_acceptance_rate": round(stats.get("completed_emergencies", 0) / max(stats.get("total_emergencies", 1), 1) * 100, 1),
            "hospital_acceptance_rate": round(stats.get("completed_emergencies", 0) / max(stats.get("total_emergencies", 1), 1) * 100, 1),
        }

    except PyMongoError as exc:
        _logger.error("[METRICS ERROR] %s", exc)
        return {"success": False, "message": "Failed to fetch metrics."}
