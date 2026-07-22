import sys
import os

# Add backend directory to sys.path so we can import from that directory
sys.path.append(os.path.join(os.getcwd(), 'backend'))

try:
    from database import get_hospitals_collection, get_drivers_collection
    from pymongo import GEOSPHERE
    import random
except Exception as e:
    print('Failed to import database:', e)
    sys.exit(1)

LAT = 19.243
LNG = 72.85

hospitals = [
    {
        'hospital_id': 'HSP-BVR1',
        'email': 'admin@borivalicity.health',
        'name': 'Borivali City Hospital',
        'address': 'Borivali West, Mumbai',
        'phone': '022-9876543',
        'location': {
            'type': 'Point',
            'coordinates': [LNG + 0.001, LAT + 0.001]
        },
        'resources': {'ambulances_available': 2, 'icu_beds': 5, 'general_beds': 20},
        'status': 'active'
    },
    {
        'hospital_id': 'HSP-BVR2',
        'email': 'admin@apexmulti.health',
        'name': 'Apex Multispeciality',
        'address': 'Borivali East, Mumbai',
        'phone': '022-1234567',
        'location': {
            'type': 'Point',
            'coordinates': [LNG - 0.002, LAT - 0.001]
        },
        'resources': {'ambulances_available': 1, 'icu_beds': 2, 'general_beds': 10},
        'status': 'active'
    }
]

drivers = [
    {
        'email': 'driver.bvr1@example.com',
        'name': 'Ramesh Borivali',
        'phone': '9999911111',
        'location': {
            'type': 'Point',
            'coordinates': [LNG + 0.005, LAT + 0.005]
        },
        'speed_kmph': 30,
        'heading': 120,
        'dispatch_status': 'online',
        'current_emergency_id': None
    },
    {
        'email': 'driver.bvr2@example.com',
        'name': 'Suresh Dahisar',
        'phone': '9999922222',
        'location': {
            'type': 'Point',
            'coordinates': [LNG - 0.004, LAT - 0.003]
        },
        'speed_kmph': 0,
        'heading': 0,
        'dispatch_status': 'online',
        'current_emergency_id': None
    }
]

h_col = get_hospitals_collection()
d_col = get_drivers_collection()

# Insert Hospitals
for h in hospitals:
    h_col.update_one({'hospital_id': h['hospital_id']}, {'$set': h}, upsert=True)
print('Seeded 2 dummy hospitals.')

# Insert Drivers
for d in drivers:
    d_col.update_one({'email': d['email']}, {'$set': d}, upsert=True)
print('Seeded 2 dummy drivers.')

