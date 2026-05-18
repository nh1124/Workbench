import os
from datetime import date, datetime
from lbs_client import LBSClient, TaskStatus

# --- Configuration ---
LBS_URL = "http://localhost:8100/api/lbs"

def run_api_key_lifecycle_example():
    print("\n--- Running API Key Lifecycle Example ---")
    # 1. Login to get a token
    client = LBSClient(base_url=LBS_URL)
    try:
        token = client.login(username_or_email="admin", password="password")
        print("Login successful.")
        
        # 2. Provision a new API Key
        provision = client.provision_api_key(rotate=True, scopes=["read", "write"])
        api_key = provision["api_key"]
        print(f"Provisioned new API Key: {api_key[:8]}...")
        
        # 3. Create a manual API Key
        new_key_data = client.create_api_key(client_id="my-automation-script", expires_in_days=30)
        print(f"Created manual key: {new_key_data['api_key'][:8]}... for client: {new_key_data['client_id']}")
        
        # 4. List keys
        keys = client.list_api_keys()
        print(f"User now has {len(keys)} active API keys.")
        
    except Exception as e:
        print(f"Error: {e}")

def run_identity_linking_example():
    print("\n--- Running Identity Linking Example (X-EXTERNAL-JWT) ---")
    # Imagine we have a JWT from an external system (e.g. VisionArk) 
    # that we want to link to an LBS account.
    external_jwt = "eyJhbG... (your external system JWT)"
    
    client = LBSClient(base_url=LBS_URL, external_jwt=external_jwt)
    
    try:
        # 1. Login to the LBS account you want to link to
        client.login(username_or_email="user@example.com", password="password")
        
        # 2. Confirm the link
        # This uses the X-EXTERNAL-JWT header + Authorization: Bearer <LBS_TOKEN>
        result = client.confirm_link_external()
        print(f"Linking Result: {result['message']}")
        
        # 3. Verify identity (shows both local and linked info if supported)
        identity = client.get_full_identity_debug()
        print(f"Resolved Identity: {identity['auth_method']}")
        
    except Exception as e:
        print(f"Error (Expected if JWT is invalid): {e}")

def run_user_management_example():
    print("\n--- Running User Management Example ---")
    client = LBSClient(base_url=LBS_URL)
    
    try:
        # 1. Create a new user
        new_user = client.create_user(
            email="newuser@example.com", 
            name="New User", 
            password="securepassword123"
        )
        print(f"Created user: {new_user['user_id']}")
        
        # 2. Login as new user
        client.login(username_or_email="newuser@example.com", password="securepassword123")
        
        # 3. Get profile
        profile = client.get_user_me()
        print(f"Profile: {profile['name']} ({profile['email']})")
        
    except Exception as e:
        print(f"Error: {e}")

def run_task_filtering_example():
    print("\n--- Running Task Filtering Example ---")
    client = LBSClient(base_url=LBS_URL)
    
    email = f"test_{datetime.now().strftime('%H%M%S')}@example.com"
    password = "password123"
    
    try:
        # 1. Create a user first
        print(f"Creating test user: {email}")
        client.create_user(email=email, password=password, name="Test User")
        
        # 2. Login
        client.login(username_or_email=email, password=password)
        print("Login successful.")
        
        # 3. Create a "done" task
        done_task = client.create_task({
            "task_name": "Completed Project Review",
            "context": "work",
            "base_load_score": 4.0,
            "status": TaskStatus.DONE,
            "rule_type": "ONCE",
            "due_date": date.today().isoformat()
        })
        print(f"Created done task: {done_task['task_id']}")

        # 3. List active tasks (Master data)
        active_tasks = client.list_tasks(active=True)
        print(f"Active master tasks found: {len(active_tasks)}")

        # 4. Get Daily Schedule (Grouped)
        schedule = client.get_schedule(date.today(), date.today())
        print(f"Schedule for today retrieved. Days: {len(schedule)}")
        for day in schedule:
            print(f"  Date: {day['date']}, Total Load: {day['total_load']}")
            for t in day['tasks']:
                print(f"    - {t['task_name']} ({t['status']}): Load {t['load']}")

        # 5. Record execution and check history
        client.toggle_task_completion(done_task['task_id'], date.today(), status=TaskStatus.DONE)
        print(f"Marked task {done_task['task_id']} as DONE for today.")
        
        history = client.get_task_history(done_task['task_id'], date.today(), date.today())
        print(f"Execution history for task: {len(history)} record(s) found.")

        # 6. Calculate relative loads
        load_with_done = client.calculate_load(date.today(), include_completed=True)
        print(f"Today's load (including done): {load_with_done['adjusted_load']}")

    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    print("LBS Client Examples")
    # run_user_management_example()
    # run_api_key_lifecycle_example()
    # run_task_filtering_example()
    
    print("\nSee samples/python_client/lbs_client.py for full method list.")
