import sys
import os

# Add current directory to path so we can import lbs_client
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from lbs_client import LBSClient

def verify():
    print("Verifying LBSClient...")
    client = LBSClient(base_url="http://localhost:8100/api/lbs")
    
    try:
        print("Testing health check...")
        health = client.health_check()
        print(f"SUCCESS: Health check returned: {health}")
    except Exception as e:
        print(f"SKIPPED/FAILED: Health check failed (is the service running?): {e}")
        print("Note: This is expected if the LBS service is not currently active on port 8100.")

    print("\nVerifying method signatures...")
    methods = [
        "login", "verify_identity", "get_full_identity_debug", 
        "confirm_link_external", "provision_api_key", "create_api_key",
        "list_api_keys", "revoke_api_key", "create_user", "get_user_me",
        "list_tasks", "get_task", "create_task", "update_task", "delete_task", 
        "bulk_delete_tasks", "bulk_update_status", "upload_csv",
        "get_dashboard", "get_heatmap", "get_trends", 
        "get_context_distribution", "calculate_load", 
        "force_expand", "create_exception", "health_check"
    ]
    
    for m in methods:
        if hasattr(client, m):
            print(f"Found method: {m}")
        else:
            print(f"MISSING method: {m}")
            sys.exit(1)
            
    print("\nClient verification script completed.")

if __name__ == "__main__":
    verify()
