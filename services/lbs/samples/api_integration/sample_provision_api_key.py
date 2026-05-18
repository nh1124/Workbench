import requests
import os
import json

# LBS API Configuration
BASE_URL = os.getenv("LBS_BASE_URL", "http://localhost:8100/api/lbs")

# Credentials for Login (Use values from your .env or system defaults)
USERNAME = os.getenv("LBS_USERNAME", "admin")
PASSWORD = os.getenv("LBS_PASSWORD", "admin123")

def provision_and_test():
    """Full lifecycle: Login -> Create X-API-KEY -> Use X-API-KEY."""
    print(f"--- Starting Provisioning Flow (Base URL: {BASE_URL}) ---")
    
    # 1. Login to get JWT
    print("\n1. Logging in to LBS...")
    login_payload = {
        "username_or_email": USERNAME,
        "password": PASSWORD
    }
    try:
        response = requests.post(f"{BASE_URL}/auth/login", json=login_payload)
        response.raise_for_status()
        jwt_token = response.json().get("access_token")
        print("Success: Obtained JWT.")
    except Exception as e:
        print(f"Login failed: {e}")
        return

    # 2. Use JWT to create a new API Key
    print("\n2. Requesting new API Key...")
    provision_headers = {
        "Authorization": f"Bearer {jwt_token}",
        "Content-Type": "application/json"
    }
    provision_payload = {
        "client_id": "provisioning-sample-client",
        "scopes": ["read", "write"],
        "expires_in_days": 7
    }
    try:
        response = requests.post(f"{BASE_URL}/auth/api-keys", headers=provision_headers, json=provision_payload)
        response.raise_for_status()
        key_data = response.json()
        new_api_key = key_data.get("api_key")
        print(f"Success: Created Key {key_data.get('id')}")
        print(f"API KEY: {new_api_key}")
    except Exception as e:
        print(f"Key provisioning failed: {e}")
        return

    # 3. Use the new API Key to call LBS
    print("\n3. Testing API Access with new Key...")
    usage_headers = {
        "X-API-KEY": new_api_key,
        "Content-Type": "application/json"
    }
    try:
        # Health check
        response = requests.get(f"{BASE_URL}/health", headers=usage_headers)
        response.raise_for_status()
        print(f"Health check: {response.json()}")
        
        # Dashboard
        response = requests.get(f"{BASE_URL}/dashboard", headers=usage_headers)
        response.raise_for_status()
        print("Dashboard access verified.")
    except Exception as e:
        print(f"API usage failed: {e}")

if __name__ == "__main__":
    provision_and_test()
