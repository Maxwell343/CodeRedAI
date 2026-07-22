import sys
sys.path.append('backend')
from database import get_hospitals_collection, get_drivers_collection

print('=== HOSPITALS ===')
for h in get_hospitals_collection().find():
    hid = h.get('hospital_id', '?')
    name = h.get('name', '?')
    status = h.get('status')
    beds = h.get('available_beds')
    loc = h.get('location')
    print(f"  {hid} | {name} | status={status} | beds={beds} | loc={loc}")

print()
print('=== DRIVERS ===')
for d in get_drivers_collection().find():
    email = d.get('email', '?')
    name = d.get('name', '?')
    ds = d.get('dispatch_status')
    loc = d.get('location')
    print(f"  {email} | {name} | dispatch={ds} | loc={loc}")
