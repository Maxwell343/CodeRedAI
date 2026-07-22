import asyncio
from backend.database import get_drivers_collection

async def main():
    coll = get_drivers_collection()
    import motor.motor_asyncio
    # Assuming the return is a motor collection which is not awaitable but its methods are.
    # We might need to handle if it's a sync or async collection.
    # Looking at the traceback, it's a 'Collection' object.
    # Let's try to query it.
    cursor = coll.find().sort("email", 1).limit(12)
    drivers = await cursor.to_list(length=12)
    for d in drivers:
        print(f"email: {d.get('email')}, dispatch_status: {d.get('dispatch_status')}, current_emergency_id: {d.get('current_emergency_id')}, last_ping_at: {d.get('last_ping_at')}")

if __name__ == '__main__':
    asyncio.run(main())
