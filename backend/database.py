from __future__ import annotations

import logging
import os
from pathlib import Path

import certifi
from dotenv import load_dotenv
from pymongo import GEOSPHERE, MongoClient
from pymongo.collection import Collection
from pymongo.database import Database
from pymongo.errors import PyMongoError

_ENV_PATH = Path(__file__).resolve().parent / ".env"
load_dotenv(dotenv_path=_ENV_PATH)

MONGO_URL = os.getenv("MONGO_URL")
DB_NAME = os.getenv("DB_NAME", "codered_db")

if not MONGO_URL:
    raise RuntimeError("MONGO_URL is not set. Add it to backend/.env")

MONGO_URL = MONGO_URL.strip().strip('"').strip("'")

if "YOUR_PASSWORD" in MONGO_URL:
    raise RuntimeError(
        "MONGO_URL still contains a placeholder password. Update backend/.env with your Atlas password."
    )

_client: MongoClient = MongoClient(
    MONGO_URL,
    tlsCAFile=certifi.where(),
    serverSelectionTimeoutMS=5000,
)
_db: Database = _client[DB_NAME]
_logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Collection accessors
# ---------------------------------------------------------------------------

def get_database() -> Database:
    return _db


def get_hospitals_collection() -> Collection:
    return _db["hospitals"]


def get_drivers_collection() -> Collection:
    return _db["drivers"]


def get_admins_collection() -> Collection:
    return _db["admins"]


def get_emergencies_collection() -> Collection:
    return _db["emergencies"]


# ---------------------------------------------------------------------------
# Index creation
# ---------------------------------------------------------------------------

def init_indexes() -> None:
    """Create all required indexes, including the 2dsphere index for geo-queries."""
    get_hospitals_collection().create_index("email", unique=True)
    get_drivers_collection().create_index("email", unique=True)
    get_admins_collection().create_index("email", unique=True)

    # GeoJSON 2dsphere index — required for $near / $geoWithin queries
    get_hospitals_collection().create_index([("location", GEOSPHERE)], name="location_2dsphere")
    _logger.info("2dsphere index ensured on hospitals.location")

    # hospital_id unique index — for cleaner API lookups
    get_hospitals_collection().create_index("hospital_id", unique=True, sparse=True)
    _logger.info("Unique index ensured on hospitals.hospital_id")

    # Driver geospatial index — required for nearest-driver queries
    get_drivers_collection().create_index([("location", GEOSPHERE)], name="driver_location_2dsphere")
    _logger.info("2dsphere index ensured on drivers.location")

    # Driver status index — for filtering online/available drivers
    get_drivers_collection().create_index("dispatch_status", name="driver_dispatch_status")
    _logger.info("Index ensured on drivers.dispatch_status")

    # emergencies indexes
    get_emergencies_collection().create_index("phone_number")
    get_emergencies_collection().create_index("hospital_status")
    get_emergencies_collection().create_index("status")
    get_emergencies_collection().create_index("assigned_driver_id", sparse=True)
    get_emergencies_collection().create_index("created_at")

    # High-throughput query performance compound indexes
    get_emergencies_collection().create_index(
        [("hospital_status", 1), ("created_at", -1)],
        name="hospital_status_created_idx",
    )
    get_emergencies_collection().create_index(
        [("assigned_driver_id", 1), ("status", 1)],
        name="driver_status_idx",
        sparse=True,
    )


def verify_database_connection() -> None:
    _client.admin.command("ping")


def close_database_connection() -> None:
    """Gracefully close the MongoDB client connection pool."""
    try:
        _client.close()
        _logger.info("MongoDB client connection pool closed successfully.")
    except Exception as exc:
        _logger.warning("Error closing MongoDB connection pool: %s", exc)


def init_indexes_safe() -> bool:
    try:
        verify_database_connection()
        init_indexes()
        return True
    except PyMongoError as exc:
        _logger.warning(
            "MongoDB startup check failed: %s. Continuing without DB startup tasks. "
            "If using Atlas, verify Network Access allowlist and outbound TLS.",
            exc,
        )
        return False


# ---------------------------------------------------------------------------
# Migration helper — call once to fix legacy hospital location format
# ---------------------------------------------------------------------------

def migrate_hospitals_to_geojson() -> dict[str, int]:
    """
    One-shot migration: convert hospital documents from the legacy
    ``{"lat": float, "lng": float}`` location format to GeoJSON
    ``{"type": "Point", "coordinates": [lng, lat]}``.

    Returns a dict with keys "migrated" and "skipped".
    """
    collection = get_hospitals_collection()
    migrated = 0
    skipped = 0

    for doc in collection.find({}):
        loc = doc.get("location", {})

        # Already in GeoJSON format — skip
        if isinstance(loc, dict) and loc.get("type") == "Point":
            skipped += 1
            continue

        # Legacy format: {"lat": ..., "lng": ...}
        lat = loc.get("lat") if isinstance(loc, dict) else None
        lng = loc.get("lng") if isinstance(loc, dict) else None

        if lat is None or lng is None:
            _logger.warning(
                "Hospital %s has no usable location — skipping migration.", doc.get("_id")
            )
            skipped += 1
            continue

        geojson_location = {
            "type": "Point",
            "coordinates": [float(lng), float(lat)],  # GeoJSON: [lng, lat]
        }

        collection.update_one(
            {"_id": doc["_id"]},
            {"$set": {"location": geojson_location}},
        )
        migrated += 1
        _logger.info(
            "Migrated hospital %s → GeoJSON [%.6f, %.6f]", doc.get("_id"), lng, lat
        )

    _logger.info("Migration complete. migrated=%d  skipped=%d", migrated, skipped)
    return {"migrated": migrated, "skipped": skipped}
