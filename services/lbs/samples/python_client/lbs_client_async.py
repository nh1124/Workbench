import httpx
import os
import enum
from datetime import date, datetime, time
from typing import List, Optional, Dict, Any, Union

class TaskStatus(str, enum.Enum):
    """Possible statuses for an LBS task execution."""
    TODO = "todo"
    DONE = "done"
    SKIPPED = "skipped"

class AsyncLBSClient:
    """
    Asynchronous Life Balance System (LBS) API Client.
    Uses httpx for non-blocking I/O.
    """

    def __init__(
        self, 
        base_url: str = "http://localhost:8100/api/lbs", 
        api_key: Optional[str] = None, 
        token: Optional[str] = None,
        external_jwt: Optional[str] = None,
        x_timezone: Optional[str] = "UTC",
        timeout: float = 30.0
    ):
        """
        Initialize the Async LBS Client.
        
        :param base_url: The base URL of the LBS service.
        :param api_key: X-API-KEY for authentication.
        :param token: JWT Bearer token for authentication.
        :param external_jwt: External system JWT (X-EXTERNAL-JWT).
        :param timeout: Request timeout in seconds.
        """
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key or os.getenv("LBS_API_KEY")
        self.token = token
        self.external_jwt = external_jwt
        self.x_timezone = x_timezone
        self.timeout = timeout
        self._client: Optional[httpx.AsyncClient] = None

    async def __aenter__(self):
        self._client = httpx.AsyncClient(base_url=self.base_url, timeout=self.timeout)
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self._client:
            await self._client.aclose()
            self._client = None

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

    async def _request(self, method: str, path: str, **kwargs) -> Any:
        headers = self._get_headers()
        if "headers" in kwargs:
            headers.update(kwargs.pop("headers"))

        # If used as a context manager, use the internal client
        if self._client:
            resp = await self._client.request(method, path.lstrip("/"), headers=headers, **kwargs)
        else:
            # Otherwise, create a one-off client
            async with httpx.AsyncClient(base_url=self.base_url, timeout=self.timeout) as client:
                resp = await client.request(method, path.lstrip("/"), headers=headers, **kwargs)

        try:
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            try:
                error_data = resp.json()
                detail = error_data.get("detail", str(e))
                # Re-raise with detail if available
                raise Exception(f"{resp.status_code} Error: {detail}") from e
            except Exception:
                raise e

        if resp.status_code == 204:
            return None
        return resp.json()

    # --- Authentication ---

    async def login(self, username_or_email: str, password: str) -> str:
        """Login and obtain a JWT."""
        payload = {"username_or_email": username_or_email, "password": password}
        data = await self._request("POST", "auth/login", json=payload)
        self.token = data.get("access_token")
        return self.token

    async def verify_identity(self) -> Dict:
        """Verify current identity status."""
        return await self._request("GET", "auth/me")

    async def confirm_link_external(self) -> Dict:
        """Link an external identity to the local account."""
        return await self._request("POST", "auth/link/confirm")

    async def provision_api_key(self, rotate: bool = False, scopes: List[str] = ["read"]) -> Dict:
        """Provision an API key."""
        payload = {"rotate": rotate, "scopes": scopes}
        return await self._request("POST", "auth/api-keys/provision", json=payload)

    async def create_api_key(self, client_id: str, scopes: List[str] = ["read"], expires_in_days: Optional[int] = None) -> Dict:
        """Create a user-managed API key."""
        payload = {"client_id": client_id, "scopes": scopes, "expires_in_days": expires_in_days}
        return await self._request("POST", "auth/api-keys", json=payload)

    async def list_api_keys(self) -> List[Dict]:
        """List current API keys."""
        return await self._request("GET", "auth/api-keys")

    async def revoke_api_key(self, key_id: str) -> Dict:
        """Revoke an API key."""
        return await self._request("DELETE", f"auth/api-keys/{key_id}")

    # --- User Management ---

    async def create_user(self, email: str, name: Optional[str] = None, password: Optional[str] = None) -> Dict:
        """Create a new local user account."""
        payload = {"email": email, "name": name, "password": password}
        return await self._request("POST", "users/", json=payload)

    async def get_user_me(self) -> Dict:
        """Get profile details."""
        return await self._request("GET", "users/me")

    # --- Task Operations ---

    async def list_tasks(self, context: Optional[str] = None, active: Optional[bool] = None) -> List[Dict]:
        """List task definitions."""
        params = {}
        if context: params["context"] = context
        if active is not None: params["active"] = str(active).lower()
        return await self._request("GET", "tasks", params=params)

    async def get_task(self, task_id: str, target_date: Optional[Union[date, str]] = None) -> Dict:
        """Get task details."""
        params = {}
        if target_date:
            params["target_date"] = target_date.isoformat() if isinstance(target_date, date) else target_date
        return await self._request("GET", f"tasks/{task_id}", params=params)

    async def get_resolved_task(self, task_id: str, target_date: Union[date, str]) -> Dict:
        """
        Get task with exception overrides applied for a specific date.
        Returns the task with resolved times, load, and exception details.
        """
        date_str = target_date.isoformat() if isinstance(target_date, date) else target_date
        return await self._request("GET", f"tasks/{task_id}/resolved", params={"target_date": date_str})

    async def create_task(self, task_data: Dict) -> Dict:
        """Create a new task."""
        return await self._request("POST", "tasks", json=task_data)

    async def update_task(self, task_id: str, task_data: Dict, force_override: bool = False) -> Dict:
        """Update a task."""
        params = {"force_override": str(force_override).lower()}
        return await self._request("PUT", f"tasks/{task_id}", json=task_data, params=params)

    async def delete_task(self, task_id: str, force_override: bool = False) -> Dict:
        """Delete a task."""
        params = {"force_override": str(force_override).lower()}
        return await self._request("DELETE", f"tasks/{task_id}", params=params)

    async def bulk_delete_tasks(self, task_ids: List[str], force_override: bool = False) -> Dict:
        """Delete multiple tasks."""
        params = {"force_override": str(force_override).lower()}
        return await self._request("POST", "tasks/bulk-delete", json={"task_ids": task_ids}, params=params)

    async def bulk_update_active(self, task_ids: List[str], active: bool, force_override: bool = False) -> Dict:
        """Update active status for multiple tasks."""
        params = {"force_override": str(force_override).lower()}
        return await self._request("POST", "tasks/bulk-update-active", json={"task_ids": task_ids, "active": active}, params=params)

    async def toggle_task_completion(self, task_id: str, target_date: Union[date, str], status: Union[bool, TaskStatus] = TaskStatus.DONE) -> Dict:
        """Toggle task completion for a date."""
        date_str = target_date.isoformat() if isinstance(target_date, date) else target_date
        if isinstance(status, bool):
            status_val = TaskStatus.DONE if status else TaskStatus.TODO
        else:
            status_val = status
            
        return await self._request("POST", f"tasks/{task_id}/complete", json={
            "target_date": date_str, 
            "status": status_val.value if isinstance(status_val, TaskStatus) else status_val
        })

    async def get_task_history(self, task_id: str, start_date: Union[date, str], end_date: Union[date, str]) -> List[Dict]:
        """Get historical records for a task."""
        params = {
            "start_date": start_date.isoformat() if isinstance(start_date, date) else start_date,
            "end_date": end_date.isoformat() if isinstance(end_date, date) else end_date
        }
        return await self._request("GET", f"tasks/{task_id}/history", params=params)

    async def upload_csv(self, file_path: str) -> Dict:
        """Bulk import tasks via CSV file."""
        # Note: Multipart upload with httpx
        with open(file_path, 'rb') as f:
            files = {'file': (os.path.basename(file_path), f, 'text/csv')}
            # httpx handles boundary and content-type automatically for files
            if self._client:
                resp = await self._client.post("tasks/upload-csv", headers=self._get_headers(), files=files)
            else:
                async with httpx.AsyncClient(base_url=self.base_url, timeout=self.timeout) as client:
                    resp = await client.post("tasks/upload-csv", headers=self._get_headers(), files=files)
            resp.raise_for_status()
            return resp.json()

    # --- Load Analysis ---

    async def get_dashboard(self, start_date: Optional[Union[date, str]] = None) -> Dict:
        """Get summary dashboard."""
        params = {}
        if start_date:
            params["start_date"] = start_date.isoformat() if isinstance(start_date, date) else start_date
        return await self._request("GET", "dashboard", params=params)

    async def get_heatmap(self, start: Union[date, str], end: Union[date, str], statuses: Optional[List[Union[str, TaskStatus]]] = None) -> List[Dict]:
        """Get daily load distribution."""
        params = {
            "start": start.isoformat() if isinstance(start, date) else start,
            "end": end.isoformat() if isinstance(end, date) else end,
        }
        if statuses:
            params["status"] = [s.value if isinstance(s, TaskStatus) else s for s in statuses]
        return await self._request("GET", "heatmap", params=params)

    async def get_trends(self, weeks: int = 12, start_date: Optional[Union[date, str]] = None, statuses: Optional[List[Union[str, TaskStatus]]] = None) -> Dict:
        """Get prediction trends."""
        params = {"weeks": weeks}
        if statuses:
            params["status"] = [s.value if isinstance(s, TaskStatus) else s for s in statuses]
        if start_date:
            params["start_date"] = start_date.isoformat() if isinstance(start_date, date) else start_date
        return await self._request("GET", "trends", params=params)

    async def get_context_distribution(self, start: Union[date, str], end: Union[date, str], statuses: Optional[List[Union[str, TaskStatus]]] = None) -> Dict:
        """Get context load distribution."""
        params = {
            "start": start.isoformat() if isinstance(start, date) else start,
            "end": end.isoformat() if isinstance(end, date) else end,
        }
        if statuses:
            params["status"] = [s.value if isinstance(s, TaskStatus) else s for s in statuses]
        return await self._request("GET", "context-distribution", params=params)

    async def calculate_load(self, target_date: Union[date, str], statuses: Optional[List[Union[str, TaskStatus]]] = None) -> Dict:
        """Calculate raw load for a date."""
        target = target_date.isoformat() if isinstance(target_date, date) else target_date
        params = {}
        if statuses:
            params["status"] = [s.value if isinstance(s, TaskStatus) else s for s in statuses]
        return await self._request("GET", f"calculate/{target}", params=params)

    async def get_schedule(self, start_date: Union[date, str], end_date: Union[date, str]) -> List[Dict]:
        """Get daily schedule."""
        params = {
            "start_date": start_date.isoformat() if isinstance(start_date, date) else start_date,
            "end_date": end_date.isoformat() if isinstance(end_date, date) else end_date
        }
        return await self._request("GET", "schedule", params=params)

    async def force_expand(self, start_date: Union[date, str], end_date: Union[date, str]) -> Dict:
        """Force trigger task expansion."""
        params = {
            "start_date": start_date.isoformat() if isinstance(start_date, date) else start_date,
            "end_date": end_date.isoformat() if isinstance(end_date, date) else end_date
        }
        return await self._request("POST", "expand", params=params)

    async def create_exception(
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
        return await self._request("POST", "exceptions", json=payload, params=params)

    async def list_exceptions(
        self, 
        task_id: Optional[str] = None, 
        start_date: Optional[Union[date, str]] = None, 
        end_date: Optional[Union[date, str]] = None
    ) -> List[Dict]:
        """
        List task exceptions with optional filters.
        """
        params = {}
        if task_id:
            params["task_id"] = task_id
        if start_date:
            params["start_date"] = start_date.isoformat() if isinstance(start_date, date) else start_date
        if end_date:
            params["end_date"] = end_date.isoformat() if isinstance(end_date, date) else end_date
        return await self._request("GET", "exceptions", params=params)

    async def get_exception(self, exception_id: int) -> Dict:
        """Get a specific exception by ID."""
        return await self._request("GET", f"exceptions/{exception_id}")

    async def update_exception(
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
        return await self._request("PUT", f"exceptions/{exception_id}", json=payload, params=params)

    async def delete_exception(self, exception_id: int, force_override: bool = False) -> Dict:
        """Delete an exception by ID."""
        params = {"force_override": str(force_override).lower()}
        return await self._request("DELETE", f"exceptions/{exception_id}", params=params)

    async def update_condition(self, target_date: Union[date, str], cognitive_fatigue: int, note: Optional[str] = None) -> Dict:
        """Update daily condition."""
        date_str = target_date.isoformat() if isinstance(target_date, date) else target_date
        payload = {
            "date": date_str,
            "cognitive_fatigue": cognitive_fatigue,
            "note": note
        }
        return await self._request("POST", "conditions", json=payload)

    async def health_check(self) -> Dict:
        """System health check."""
        return await self._request("GET", "health")
