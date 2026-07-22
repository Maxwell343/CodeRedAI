import os
import sys
from datetime import datetime
from pathlib import Path

# Ensure backend root is in sys.path
_BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from database import get_admins_collection, get_drivers_collection, get_hospitals_collection
from utils.hashing import hash_password

DEFAULT_PRESET_PASSWORD = "Password@123"
DEFAULT_ADMIN_PASSWORD = "Admin@123"

DEMO_HOSPITALS = [
    {
        "hospital_id": "HSP-APOLLO",
        "name": "Apollo Emergency Center",
        "email": "apollo.er@codered.ai",
        "password_hash": hash_password(DEFAULT_PRESET_PASSWORD),
        "role": "hospital",
        "bed_capacity": 25,
        "available_beds": 25,
        "address": "Juhu, Mumbai",
        "phone": "+91 22 2626 7000",
        "location": {
            "type": "Point",
            "coordinates": [72.8258, 19.1075]  # [lng, lat]
        },
        "status": "active"
    },
    {
        "hospital_id": "HSP-LILAVATI",
        "name": "Lilavati Hospital & Research Centre",
        "email": "lilavati.er@codered.ai",
        "password_hash": hash_password(DEFAULT_PRESET_PASSWORD),
        "role": "hospital",
        "bed_capacity": 20,
        "available_beds": 18,
        "address": "Bandra West, Mumbai",
        "phone": "+91 22 2675 1000",
        "location": {
            "type": "Point",
            "coordinates": [72.8273, 19.0511]
        },
        "status": "active"
    },
    {
        "hospital_id": "HSP-FORTIS",
        "name": "Fortis Hospital ER",
        "email": "fortis.er@codered.ai",
        "password_hash": hash_password(DEFAULT_PRESET_PASSWORD),
        "role": "hospital",
        "bed_capacity": 30,
        "available_beds": 30,
        "address": "Mulund West, Mumbai",
        "phone": "+91 22 6799 4444",
        "location": {
            "type": "Point",
            "coordinates": [72.9431, 19.1678]
        },
        "status": "active"
    },
    {
        "hospital_id": "HSP-KOKILABEN",
        "name": "Kokilaben Dhirubhai Ambani Hospital",
        "email": "kokilaben.er@codered.ai",
        "password_hash": hash_password(DEFAULT_PRESET_PASSWORD),
        "role": "hospital",
        "bed_capacity": 22,
        "available_beds": 22,
        "address": "Andheri West, Mumbai",
        "phone": "+91 22 3099 9999",
        "location": {
            "type": "Point",
            "coordinates": [72.8242, 19.1314]
        },
        "status": "active"
    },
    {
        "hospital_id": "HSP-NANAVATI",
        "name": "Nanavati Max Super Speciality",
        "email": "nanavati.er@codered.ai",
        "password_hash": hash_password(DEFAULT_PRESET_PASSWORD),
        "role": "hospital",
        "bed_capacity": 15,
        "available_beds": 15,
        "address": "Vile Parle West, Mumbai",
        "phone": "+91 22 2626 7500",
        "location": {
            "type": "Point",
            "coordinates": [72.8406, 19.0968]
        },
        "status": "active"
    },
    {
        "hospital_id": "HSP-RUBY",
        "name": "Ruby Hall Clinic ER",
        "email": "rubyhall.er@codered.ai",
        "password_hash": hash_password(DEFAULT_PRESET_PASSWORD),
        "role": "hospital",
        "bed_capacity": 40,
        "available_beds": 40,
        "address": "Pune Central ER",
        "phone": "+91 20 6645 5100",
        "location": {
            "type": "Point",
            "coordinates": [73.8742, 18.5308]
        },
        "status": "active"
    }
]

DEMO_DRIVERS = [
    {
        "name": "Rajesh Kumar",
        "email": "driver.rajesh@codered.ai",
        "phone": "+91 98200 11223",
        "call_sign": "AMB-101",
        "vehicle_number": "MH-02-AX-1001",
        "linked_hospital_id": "HSP-APOLLO",
        "password_hash": hash_password(DEFAULT_PRESET_PASSWORD),
        "role": "driver",
        "dispatch_status": "online",
        "location": {
            "type": "Point",
            "coordinates": [72.8340, 19.1274]
        }
    },
    {
        "name": "Vikram Singh",
        "email": "driver.vikram@codered.ai",
        "phone": "+91 98200 22334",
        "call_sign": "AMB-102",
        "vehicle_number": "MH-02-AX-1002",
        "linked_hospital_id": "HSP-LILAVATI",
        "password_hash": hash_password(DEFAULT_PRESET_PASSWORD),
        "role": "driver",
        "dispatch_status": "online",
        "location": {
            "type": "Point",
            "coordinates": [72.8273, 19.0511]
        }
    },
    {
        "name": "Amit Sharma",
        "email": "driver.amit@codered.ai",
        "phone": "+91 98200 33445",
        "call_sign": "AMB-103",
        "vehicle_number": "MH-04-BX-2001",
        "linked_hospital_id": "HSP-FORTIS",
        "password_hash": hash_password(DEFAULT_PRESET_PASSWORD),
        "role": "driver",
        "dispatch_status": "online",
        "location": {
            "type": "Point",
            "coordinates": [72.9431, 19.1678]
        }
    },
    {
        "name": "Suresh Patil",
        "email": "driver.suresh@codered.ai",
        "phone": "+91 98200 44556",
        "call_sign": "AMB-104",
        "vehicle_number": "MH-03-CX-3001",
        "linked_hospital_id": "HSP-KOKILABEN",
        "password_hash": hash_password(DEFAULT_PRESET_PASSWORD),
        "role": "driver",
        "dispatch_status": "online",
        "location": {
            "type": "Point",
            "coordinates": [72.8242, 19.1314]
        }
    },
    {
        "name": "Priya Deshmukh",
        "email": "driver.priya@codered.ai",
        "phone": "+91 98200 55667",
        "call_sign": "AMB-105",
        "vehicle_number": "MH-01-DX-4001",
        "linked_hospital_id": "HSP-NANAVATI",
        "password_hash": hash_password(DEFAULT_PRESET_PASSWORD),
        "role": "driver",
        "dispatch_status": "online",
        "location": {
            "type": "Point",
            "coordinates": [72.8406, 19.0968]
        }
    },
    {
        "name": "Rohit Verma",
        "email": "driver.rohit@codered.ai",
        "phone": "+91 98200 66778",
        "call_sign": "AMB-106",
        "vehicle_number": "MH-02-EX-5001",
        "linked_hospital_id": "HSP-RUBY",
        "password_hash": hash_password(DEFAULT_PRESET_PASSWORD),
        "role": "driver",
        "dispatch_status": "online",
        "location": {
            "type": "Point",
            "coordinates": [73.8742, 18.5308]
        }
    }
]

DEMO_ADMINS = [
    {
        "name": "Aarav Mehta",
        "role": "Chief Operations Admin",
        "email": "admin.ops@codered.ai",
        "password_hash": hash_password(DEFAULT_ADMIN_PASSWORD),
    },
    {
        "name": "Siya Iyer",
        "role": "Verification Lead",
        "email": "admin.verify@codered.ai",
        "password_hash": hash_password(DEFAULT_ADMIN_PASSWORD),
    },
    {
        "name": "Kabir Khan",
        "role": "Quality & Reviews Admin",
        "email": "admin.reviews@codered.ai",
        "password_hash": hash_password(DEFAULT_ADMIN_PASSWORD),
    },
    {
        "name": "Neha Desai",
        "role": "Compliance Admin",
        "email": "admin.compliance@codered.ai",
        "password_hash": hash_password(DEFAULT_ADMIN_PASSWORD),
    }
]

def seed_database():
    now = datetime.utcnow()
    h_col = get_hospitals_collection()
    d_col = get_drivers_collection()
    a_col = get_admins_collection()

    print("Cleaning up old trash accounts...")
    h_col.delete_many({})
    d_col.delete_many({})
    a_col.delete_many({})

    print("Seeding demo hospitals...")
    for h in DEMO_HOSPITALS:
        h["created_at"] = now
        h["updated_at"] = now
        h_col.insert_one(h)
    print(f"Seeded {len(DEMO_HOSPITALS)} demo hospitals.")

    print("Seeding demo drivers...")
    for d in DEMO_DRIVERS:
        d["created_at"] = now
        d["updated_at"] = now
        d_col.insert_one(d)
    print(f"Seeded {len(DEMO_DRIVERS)} demo drivers.")

    print("Seeding demo admins...")
    for a in DEMO_ADMINS:
        a["created_at"] = now
        a["updated_at"] = now
        a_col.insert_one(a)
    print(f"Seeded {len(DEMO_ADMINS)} demo admins.")
    print("Database seeding completed successfully!")

if __name__ == "__main__":
    seed_database()
