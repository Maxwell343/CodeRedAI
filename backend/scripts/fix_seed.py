"""Fix the Borivali seed data: add available_beds to hospitals."""
import sys
sys.path.append('backend')
from database import get_hospitals_collection, get_drivers_collection

h_col = get_hospitals_collection()
d_col = get_drivers_collection()

# Fix Borivali hospitals — add available_beds
result1 = h_col.update_one(
    {"hospital_id": "HSP-BVR1"},
    {"$set": {"available_beds": 20}}
)
print(f"HSP-BVR1 updated: {result1.modified_count}")

result2 = h_col.update_one(
    {"hospital_id": "HSP-BVR2"},
    {"$set": {"available_beds": 10}}
)
print(f"HSP-BVR2 updated: {result2.modified_count}")

# Also fix the broken Lilavati hospital that has no hospital_id and wrong location format
h_col.delete_many({"hospital_id": {"$exists": False}})
print("Cleaned up broken hospital records.")

print("\n=== VERIFICATION ===")
for h in h_col.find({"hospital_id": {"$regex": "^HSP-BVR"}}):
    print(f"  {h['hospital_id']} | beds={h.get('available_beds')} | status={h.get('status')} | loc={h.get('location')}")

for d in d_col.find({"email": {"$regex": "bvr"}}):
    print(f"  {d['email']} | dispatch={d.get('dispatch_status')} | loc={d.get('location')}")
