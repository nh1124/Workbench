import os
import requests
from datetime import date, datetime, time
import enum
import enum
from typing import List, Optional, Dict, Any, Union

class TaskStatus(str, enum.Enum):
    """Possible statuses for an LBS task execution."""
    TODO = "todo"
    DONE = "done"
    SKIPPED = "skipped"

class LBSClient:
    """
    Life Balance System (LBS) API Client.
    
    Supports:
    - X-API-KEY (Recommended for AI/Automation)
    - Bearer Token (JWT)
    - Username/Password (Login Flow)
    """

    def __init__(
        self, 
        base_url: str = "http://localhost:8100/api/lbs", 
        api_key: Optional[str] = None, 
        token: Optional[str] = None,
        external_jwt: Optional[str] = None,
        x_timezone: Optional[str] = "UTC"
    ):
        """
        Initialize the LBS Client.
        
        :param base_url: The base URL of the LBS service (default: http://localhost:8100/api/lbs)
        :param api_key: X-API-KEY for authentication.
        :param token: JWT Bearer token for authentication.
        :param external_jwt: External system JWT for identity linking (X-EXTERNAL-JWT).
        """
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key or os.getenv("LBS_API_KEY")
        self.token = token
        self.external_jwt = external_jwt
        self.x_timezone = x_timezone
        self._session = requests.Session()

    def _get_headers(self) -> Dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json"
        }
        if self.x_timezone:
            headers["X-Timezone"] = self.x_timezone
        if self.api_key:
            headers["X-API-KEY"] = self.api_key
        elif self.token:
            headers["Authorization"] = f"Bearer {self.token}"
            
        if self.external_jwt:
            headers["X-EXTERNAL-JWT"] = self.external_jwt
            
        return headers

    def _request(self, method: str, path: str, **kwargs) -> Any:
        url = f"{self.base_url}/{path.lstrip('/')}"
        headers = self._get_headers()
        
        # Merge headers if provided in kwargs
        if "headers" in kwargs:
            headers.update(kwargs.pop("headers"))
            
        response = self._session.request(method, url, headers=headers, **kwargs)
        
        try:
            response.raise_for_status()
        except requests.HTTPError as e:
            # Try to extract error detail from JSON response
            try:
                error_data = response.json()
                detail = error_data.get("detail", str(e))
                raise requests.HTTPError(f"{response.status_code} Client Error: {detail} for url: {url}") from e
            except Exception:
                raise e

        if response.status_code == 204:
            return None
        return response.json()

    # --- Authentication & API Keys ---

    def login(self, username_or_email: str, password: str) -> str:
        """
        Login with username/email and password to obtain a JWT.
        Sets self.token automatically.
        """
        payload = {
            "username_or_email": username_or_email,
            "password": password
        }
        data = self._request("POST", "auth/login", json=payload)
        self.token = data.get("access_token")
        return self.token

    def verify_identity(self) -> Dict:
        """Verify current identity status (/auth/me)"""
        return self._request("GET", "auth/me")

    def get_full_identity_debug(self) -> Dict:
        """Debug endpoint to show resolved identity (local, external, or api_key)."""
        return self._request("GET", "auth/identity")

    def confirm_link_external(self) -> Dict:
        """
        Link a verified External System JWT identity (from X-EXTERNAL-JWT header) 
        to the currently logged-in local LBS account.
        """
        return self._request("POST", "auth/link/confirm")

    def provision_api_key(self, rotate: bool = False, scopes: List[str] = ["read"]) -> Dict:
        """
        Provision an API key for a specific external integration client.
        """
        payload = {"rotate": rotate, "scopes": scopes}
        return self._request("POST", "auth/api-keys/provision", json=payload)

    def create_api_key(self, client_id: str, scopes: List[str] = ["read"], expires_in_days: Optional[int] = None) -> Dict:
        """Create a user-managed API key."""
        payload = {
            "client_id": client_id,
            "scopes": scopes,
            "expires_in_days": expires_in_days
        }
        return self._request("POST", "auth/api-keys", json=payload)

    def list_api_keys(self) -> List[Dict]:
        """List metadata for all API keys belonging to the current user."""
        return self._request("GET", "auth/api-keys")

    def revoke_api_key(self, key_id: str) -> Dict:
        """Revoke an API key."""
        return self._request("DELETE", f"auth/api-keys/{key_id}")

    # --- User Management ---

    def create_user(self, email: str, name: Optional[str] = None, password: Optional[str] = None) -> Dict:
        """Create a new local user account."""
        payload = {
            "email": email,
            "name": name,
            "password": password
        }
        return self._request("POST", "users/", json=payload)

    def get_user_me(self) -> Dict:
        """Get full profile details for current user."""
        return self._request("GET", "users/me")

    # --- Task Operations ---

    def list_tasks(self, context: Optional[str] = None, active: Optional[bool] = None) -> List[Dict]:
        """
        List task definitions (Master data).
        
        :param context: Filter by task context string.
        :param active: Filter by active status (True/False).
        """
        params = {}
        if context:
            params["context"] = context
        if active is not None:
            params["active"] = str(active).lower()
        return self._request("GET", "tasks", params=params)

    def get_task(self, task_id: str, target_date: Optional[Union[date, str]] = None) -> Dict:
        """
        Get detailed task information.
        
        :param task_id: The task ID.
        :param target_date: Optional specific date to resolve dynamic status for.
        """
        params = {}
        if target_date:
            params["target_date"] = target_date.isoformat() if isinstance(target_date, date) else target_date
        return self._request("GET", f"tasks/{task_id}", params=params)

    def get_resolved_task(self, task_id: str, target_date: Union[date, str]) -> Dict:
        """
        Get task with exception overrides applied for a specific date.
        
        Returns the task with resolved times, load, and exception details
        reflecting any exceptions that apply to that date.
        
        :param task_id: The task ID.
        :param target_date: The date to resolve the task for.
        """
        date_str = target_date.isoformat() if isinstance(target_date, date) else target_date
        return self._request("GET", f"tasks/{task_id}/resolved", params={"target_date": date_str})

    def create_task(self, task_data: Dict) -> Dict:
        """Create a new LBS task."""
        return self._request("POST", "tasks", json=task_data)

    def update_task(self, task_id: str, task_data: Dict, force_override: bool = False) -> Dict:
        """Update an existing task."""
        params = {"force_override": str(force_override).lower()}
        return self._request("PUT", f"tasks/{task_id}", json=task_data, params=params)

    def delete_task(self, task_id: str, force_override: bool = False) -> Dict:
        """Delete a task."""
        params = {"force_override": str(force_override).lower()}
        return self._request("DELETE", f"tasks/{task_id}", params=params)

    def bulk_delete_tasks(self, task_ids: List[str], force_override: bool = False) -> Dict:
        """Delete multiple tasks by ID list."""
        params = {"force_override": str(force_override).lower()}
        return self._request("POST", "tasks/bulk-delete", json={"task_ids": task_ids}, params=params)

    def bulk_update_active(self, task_ids: List[str], active: bool, force_override: bool = False) -> Dict:
        """Update active status (archive/unarchive) for multiple tasks."""
        params = {"force_override": str(force_override).lower()}
        return self._request("POST", "tasks/bulk-update-active", json={"task_ids": task_ids, "active": active}, params=params)

    def toggle_task_completion(self, task_id: str, target_date: Union[date, str], status: Union[bool, TaskStatus] = TaskStatus.DONE) -> Dict:
        """
        Record a specific task execution status for a particular date.
        
        :param status: Can be boolean True (maps to DONE), False (maps to TODO), 
                       or a TaskStatus enum value (DONE, SKIPPED, IN_PROGRESS, TODO).
        """
        date_str = target_date.isoformat() if isinstance(target_date, date) else target_date
        
        # Convert boolean to Enum for backward compatibility or ease of use
        if isinstance(status, bool):
            status_val = TaskStatus.DONE if status else TaskStatus.TODO
        else:
            status_val = status
            
        return self._request("POST", f"tasks/{task_id}/complete", json={
            "target_date": date_str, 
            "status": status_val.value if isinstance(status_val, TaskStatus) else status_val
        })

    def get_task_history(self, task_id: str, start_date: Union[date, str], end_date: Union[date, str]) -> List[Dict]:
        """Get historical execution records for a specific task."""
        params = {
            "start_date": start_date.isoformat() if isinstance(start_date, date) else start_date,
            "end_date": end_date.isoformat() if isinstance(end_date, date) else end_date
        }
        return self._request("GET", f"tasks/{task_id}/history", params=params)

    def upload_csv(self, file_path: str) -> Dict:
        """Bulk import tasks via CSV file."""
        with open(file_path, 'rb') as f:
            files = {'file': (os.path.basename(file_path), f, 'text/csv')}
            # Note: We need to override headers for multipart/form-data
            headers = self._get_headers()
            del headers["Content-Type"] # requests will set this with boundary
            url = f"{self.base_url}/tasks/upload-csv"
            response = self._session.post(url, headers=headers, files=files)
            response.raise_for_status()
            return response.json()

    # --- Load Analysis & Insights ---

    def get_dashboard(self, start_date: Optional[Union[date, str]] = None) -> Dict:
        """Get summary of current load and predictions."""
        params = {}
        if start_date:
            params["start_date"] = start_date.isoformat() if isinstance(start_date, date) else start_date
        return self._request("GET", "dashboard", params=params)

    def get_heatmap(self, start: Union[date, str], end: Union[date, str], statuses: Optional[List[Union[str, TaskStatus]]] = None) -> List[Dict]:
        """
        Get daily load distribution.
        
        :param statuses: List of task statuses to include (e.g. ['todo', 'done']).
        """
        params = {
            "start": start.isoformat() if isinstance(start, date) else start,
            "end": end.isoformat() if isinstance(end, date) else end,
        }
        if statuses:
            params["status"] = [s.value if isinstance(s, TaskStatus) else s for s in statuses]
        return self._request("GET", "heatmap", params=params)

    def get_trends(self, weeks: int = 12, start_date: Optional[Union[date, str]] = None, statuses: Optional[List[Union[str, TaskStatus]]] = None) -> Dict:
        """
        Get multi-week load trend predictions.
        """
        params = {"weeks": weeks}
        if statuses:
            params["status"] = [s.value if isinstance(s, TaskStatus) else s for s in statuses]
        if start_date:
            params["start_date"] = start_date.isoformat() if isinstance(start_date, date) else start_date
        return self._request("GET", "trends", params=params)

    def get_context_distribution(self, start: Union[date, str], end: Union[date, str], statuses: Optional[List[Union[str, TaskStatus]]] = None) -> Dict:
        """Get load distribution grouped by task context."""
        params = {
            "start": start.isoformat() if isinstance(start, date) else start,
            "end": end.isoformat() if isinstance(end, date) else end,
        }
        if statuses:
            params["status"] = [s.value if isinstance(s, TaskStatus) else s for s in statuses]
        return self._request("GET", "context-distribution", params=params)

    def calculate_load(self, target_date: Union[date, str], statuses: Optional[List[Union[str, TaskStatus]]] = None) -> Dict:
        """Get raw load calculation for a specific date."""
        target = target_date.isoformat() if isinstance(target_date, date) else target_date
        params = {}
        if statuses:
            params["status"] = [s.value if isinstance(s, TaskStatus) else s for s in statuses]
        return self._request("GET", f"calculate/{target}", params=params)

    def get_schedule(self, start_date: Union[date, str], end_date: Union[date, str]) -> List[Dict]:
        """
        Get daily schedule (Source of Truth).
        Returns grouped list of dates with associated tasks and loads.
        """
        params = {
            "start_date": start_date.isoformat() if isinstance(start_date, date) else start_date,
            "end_date": end_date.isoformat() if isinstance(end_date, date) else end_date
        }
        return self._request("GET", "schedule", params=params)

    def force_expand(self, start_date: Union[date, str], end_date: Union[date, str]) -> Dict:
        """Force trigger task expansion for a range."""
        params = {
            "start_date": start_date.isoformat() if isinstance(start_date, date) else start_date,
            "end_date": end_date.isoformat() if isinstance(end_date, date) else end_date
        }
        return self._request("POST", "expand", params=params)

    def create_exception(
        self, 
        task_id: str, 
        target_date: Union[date, str], 
        exception_type: str,
        override_load_value: Optional[float] = None,
        start_time: Optional[Union[time, str]] = None,
        end_time: Optional[Union[time, str]] = None,
        notes: Optional[str] = None,
        force_override: bool = False,
        is_locked: Optional[bool] = None
    ) -> Dict:
        """
        Create a task exception for a specific date.
        
        :param task_id: ID of the task to create exception for.
        :param target_date: Date for the exception (YYYY-MM-DD).
        :param exception_type: Type of exception ('SKIP', 'OVERRIDE_LOAD', 'FORCE_DO').
        :param override_load_value: Optional load value override.
        :param start_time: Optional start time override (HH:MM:SS).
        :param end_time: Optional end time override (HH:MM:SS).
        :param notes: Optional notes.
        :param force_override: Set to True to bypass safety locks (User Intent).
        :param is_locked: Set the lock state of the exception itself.
        """
        payload = {
            "task_id": task_id,
            "target_date": target_date.isoformat() if isinstance(target_date, date) else target_date,
            "exception_type": exception_type
        }
        if override_load_value is not None:
            payload["override_load_value"] = override_load_value
        if start_time:
            payload["start_time"] = start_time.isoformat() if isinstance(start_time, time) else start_time
        if end_time:
            payload["end_time"] = end_time.isoformat() if isinstance(end_time, time) else end_time
        if notes:
            payload["notes"] = notes
        if is_locked is not None:
            payload["is_locked"] = is_locked

        params = {"force_override": str(force_override).lower()}
        return self._request("POST", "exceptions", json=payload, params=params)

    def list_exceptions(
        self, 
        task_id: Optional[str] = None, 
        start_date: Optional[Union[date, str]] = None, 
        end_date: Optional[Union[date, str]] = None
    ) -> List[Dict]:
        """
        List task exceptions with optional filters.
        
        :param task_id: Optional task ID to filter by.
        :param start_date: Optional start date filter.
        :param end_date: Optional end date filter.
        """
        params = {}
        if task_id:
            params["task_id"] = task_id
        if start_date:
            params["start_date"] = start_date.isoformat() if isinstance(start_date, date) else start_date
        if end_date:
            params["end_date"] = end_date.isoformat() if isinstance(end_date, date) else end_date
        return self._request("GET", "exceptions", params=params)

    def get_exception(self, exception_id: int) -> Dict:
        """Get a specific exception by ID."""
        return self._request("GET", f"exceptions/{exception_id}")

    def update_exception(
        self, 
        exception_id: int,
        exception_type: Optional[str] = None,
        override_load_value: Optional[float] = None,
        start_time: Optional[Union[time, str]] = None,
        end_time: Optional[Union[time, str]] = None,
        notes: Optional[str] = None,
        is_locked: Optional[bool] = None,
        force_override: bool = False
    ) -> Dict:
        """
        Update an existing exception.
        
        :param exception_id: ID of the exception to update.
        :param exception_type: Optional new exception type.
        :param override_load_value: Optional new load value.
        :param start_time: Optional new start time.
        :param end_time: Optional new end time.
        :param notes: Optional new notes.
        :param is_locked: Optional new lock state.
        :param force_override: Set to True to bypass safety locks (User Intent).
        """
        payload = {}
        if exception_type is not None:
            payload["exception_type"] = exception_type
        if override_load_value is not None:
            payload["override_load_value"] = override_load_value
        if start_time is not None:
            payload["start_time"] = start_time.isoformat() if isinstance(start_time, time) else start_time
        if end_time is not None:
            payload["end_time"] = end_time.isoformat() if isinstance(end_time, time) else end_time
        if notes is not None:
            payload["notes"] = notes
        if is_locked is not None:
            payload["is_locked"] = is_locked

        params = {"force_override": str(force_override).lower()}
        return self._request("PUT", f"exceptions/{exception_id}", json=payload, params=params)

    def delete_exception(self, exception_id: int, force_override: bool = False) -> Dict:
        """Delete an exception by ID."""
        params = {"force_override": str(force_override).lower()}
        return self._request("DELETE", f"exceptions/{exception_id}", params=params)

    # --- System ---

    def health_check(self) -> Dict:
        """Check system status (No auth required)."""
        return self._request("GET", "health")
