import requests
import os
import json

# LBS API Configuration
BASE_URL = os.getenv("LBS_BASE_URL", "http://localhost:8100/api/lbs")

# API Key from environment (e.g. export LBS_API_KEY=your_key_here)
API_KEY = os.getenv("LBS_API_KEY", "")

headers = {
    "X-API-KEY": API_KEY,
    "Content-Type": "application/json"
}

def check_access():
    """Verify system access using the provided API Key."""
    print(f"--- API Key Access Check (Base URL: {BASE_URL}) ---")
    
    # 1. Health Check (Basic Auth Check)
    try:
        print("Checking Health...")
        response = requests.get(f"{BASE_URL}/health", headers=headers)
        response.raise_for_status()
        print(f"Success: {response.json()}")
    except Exception as e:
        print(f"Health check failed: {e}")

    # 2. Dashboard Summary
    try:
        print("\nFetching Dashboard...")
        response = requests.get(f"{BASE_URL}/dashboard", headers=headers)
        response.raise_for_status()
        print("Dashboard Data:")
        print(json.dumps(response.json(), indent=2))
    except Exception as e:
        print(f"Dashboard fetch failed: {e}")

    # 3. List Tasks
    try:
        print("\nListing Tasks...")
        response = requests.get(f"{BASE_URL}/tasks", headers=headers)
        response.raise_for_status()
        tasks = response.json()
        print(f"Verified: Found {len(tasks)} tasks.")
    except Exception as e:
        print(f"Task listing failed: {e}")

if __name__ == "__main__":
    if not API_KEY or "your_secret" in API_KEY:
        print("Error: Please set LBS_API_KEY environment variable.")
    else:
        check_access()
