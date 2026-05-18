import requests
import os
import json

# LBS API Configuration
BASE_URL = os.getenv("LBS_BASE_URL", "http://localhost:8100/api/lbs")

# 1. Credentials for LBS Login
USERNAME = os.getenv("LBS_USERNAME", "dev-user")
PASSWORD = os.getenv("LBS_PASSWORD", "password")

# 2. External System Identity (Simulated)
# This would normally be provided by the host client system (e.g. Antigravity OS)
EXTERNAL_JWT = os.getenv("EXTERNAL_SYSTEM_TOKEN", "mock-external-jwt-token")

def authenticate_lbs():
    """Step 1: Authenticate with LBS local credentials to get an LBS JWT."""
    print("--- Step 1: LBS Login ---")
    payload = {
        "username_or_email": USERNAME,
        "password": PASSWORD
    }
    try:
        response = requests.post(f"{BASE_URL}/auth/login", json=payload)
        response.raise_for_status()
        token = response.json().get("access_token")
        print("Successfully logged into LBS.")
        return token
    except Exception as e:
        print(f"LBS Login failed: {e}")
        return None

def link_external_account(lbs_token, external_jwt):
    """Step 2: Link the external identity to the local LBS account."""
    print("\n--- Step 2: Linking External Account ---")
    headers = {
        "Authorization": f"Bearer {lbs_token}",
        "X-EXTERNAL-JWT": external_jwt
    }
    try:
        # Note: Body is empty or as required by LinkConfirmRequest schema
        response = requests.post(f"{BASE_URL}/auth/link/confirm", headers=headers, json={})
        response.raise_for_status()
        print(f"Linking Result: {response.json().get('message')}")
        return True
    except Exception as e:
        print(f"Account linking failed: {e}")
        return False

def call_api_with_external_token(external_jwt):
    """Step 3: Call LBS APIs using the external JWT (mapping handled by LBS)."""
    print("\n--- Step 3: Calling API with External Token ---")
    headers = {
        "Authorization": f"Bearer {external_jwt}",
        "Content-Type": "application/json"
    }
    try:
        response = requests.get(f"{BASE_URL}/auth/me", headers=headers)
        response.raise_for_status()
        print("Identity Verified via External Token:")
        print(json.dumps(response.json(), indent=2))
        
        # Test fetching tasks
        response = requests.get(f"{BASE_URL}/tasks", headers=headers)
        response.raise_for_status()
        print(f"Found {len(response.json())} tasks via external mapping.")
    except Exception as e:
        print(f"API call with external token failed: {e}")

if __name__ == "__main__":
    print(f"Starting End-to-End Linking Flow (Base URL: {BASE_URL})")
    
    # Flow: Login -> Link -> Use External Token
    lbs_token = authenticate_lbs()
    if lbs_token:
        if link_external_account(lbs_token, EXTERNAL_JWT):
            call_api_with_external_token(EXTERNAL_JWT)
