import asyncio
from lbs_client_async import AsyncLBSClient, TaskStatus
from datetime import date
import json

async def main():
    # Use localhost:8100 as default
    client = AsyncLBSClient()
    
    print("--- 1. Health Check ---")
    try:
        health = await client.health_check()
        print(f"Health: {json.dumps(health, indent=2)}")
    except Exception as e:
        print(f"Health check failed: {e}")
        return

    print("\n--- 2. Dashboard ---")
    try:
        dash = await client.get_dashboard()
        print(f"Dashboard Load: {dash.get('today', {}).get('adjusted_load')}")
    except Exception as e:
        print(f"Dashboard failed: {e}")

    print("\n--- 3. Using Context Manager ---")
    async with AsyncLBSClient() as lbs:
        try:
            # Try to list tasks
            tasks = await lbs.list_tasks(active=True)
            print(f"Fetched {len(tasks)} active tasks.")
            
            # Heatmap with status filter
            heatmap = await lbs.get_heatmap(
                start=date.today(), 
                end=date.today(), 
                statuses=[TaskStatus.TODO, TaskStatus.SKIPPED]
            )
            if heatmap:
                print(f"Heatmap for today: {heatmap[0].get('adjusted_load')} (status: todo, skipped)")
        except Exception as e:
            print(f"Context manager operations failed: {e}")

if __name__ == "__main__":
    asyncio.run(main())
