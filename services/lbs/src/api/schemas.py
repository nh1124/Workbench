from pydantic import BaseModel, Field
from typing import List, Optional
from datetime import date, datetime, time
from ..models.database import TaskStatus

class UserCreate(BaseModel):
    email: str
    name: Optional[str] = None
    password: Optional[str] = None

class UserResponse(BaseModel):
    user_id: str
    email: str
    name: Optional[str] = None
    is_active: bool
    created_at: datetime
    class Config: from_attributes = True

class TaskBase(BaseModel):
    task_name: str
    context: str
    base_load_score: float
    rule_type: str
    due_date: Optional[date] = None
    mon: bool = False
    tue: bool = False
    wed: bool = False
    thu: bool = False
    fri: bool = False
    sat: bool = False
    sun: bool = False
    interval_days: Optional[int] = None
    anchor_date: Optional[date] = None
    month_day: Optional[int] = None
    nth_in_month: Optional[int] = None
    weekday_mon1: Optional[int] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    start_time: Optional[time] = None
    end_time: Optional[time] = None
    notes: Optional[str] = None
    external_sync_id: Optional[str] = None
    is_locked: Optional[bool] = False
    timezone: Optional[str] = 'UTC'

class TaskCreate(TaskBase):
    pass

class TaskUpdate(BaseModel):
    task_name: Optional[str] = None
    context: Optional[str] = None
    base_load_score: Optional[float] = None
    active: Optional[bool] = None
    rule_type: Optional[str] = None
    due_date: Optional[date] = None
    mon: Optional[bool] = None
    tue: Optional[bool] = None
    wed: Optional[bool] = None
    thu: Optional[bool] = None
    fri: Optional[bool] = None
    sat: Optional[bool] = None
    sun: Optional[bool] = None
    interval_days: Optional[int] = None
    anchor_date: Optional[date] = None
    month_day: Optional[int] = None
    nth_in_month: Optional[int] = None
    weekday_mon1: Optional[int] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    start_time: Optional[time] = None
    end_time: Optional[time] = None
    notes: Optional[str] = None
    external_sync_id: Optional[str] = None
    is_locked: Optional[bool] = None
    timezone: Optional[str] = None

class TaskBulkDelete(BaseModel):
    task_ids: List[str]

class TaskBulkActiveUpdate(BaseModel):
    task_ids: List[str]
    active: bool

class TaskExecutionRequest(BaseModel):
    target_date: date
    status: TaskStatus = TaskStatus.DONE
    progress: Optional[int] = Field(None, ge=0, le=100)
    actual_time: Optional[int] = Field(None, ge=0)

class TaskExecutionResponse(BaseModel):
    target_date: date
    status: TaskStatus
    class Config: from_attributes = True

class TaskResponse(TaskBase):
    task_id: str
    active: bool
    is_locked: bool = False
    class Config: from_attributes = True

class ScheduleTask(BaseModel):
    task_id: str
    task_name: str
    context: str
    status: TaskStatus
    load: float = Field(..., description="Calculated load (including exceptions)")
    start_time: Optional[time] = None
    end_time: Optional[time] = None
    has_exception: bool = False
    exception_type: Optional[str] = None
    is_locked: bool = False
    timezone: str = 'UTC'
    
    class Config: from_attributes = True

class DailySchedule(BaseModel):
    date: date
    total_load: float
    tasks: List[ScheduleTask]

class TaskDetail(TaskResponse):
    created_at: datetime
    updated_at: datetime

class ExceptionCreate(BaseModel):
    task_id: str
    target_date: date
    exception_type: str  # SKIP, OVERRIDE_LOAD, FORCE_DO
    override_load_value: Optional[float] = None
    start_time: Optional[time] = None
    end_time: Optional[time] = None
    notes: Optional[str] = None
    is_locked: bool = False

class ExceptionUpdate(BaseModel):
    exception_type: Optional[str] = None
    override_load_value: Optional[float] = None
    start_time: Optional[time] = None
    end_time: Optional[time] = None
    notes: Optional[str] = None
    is_locked: Optional[bool] = None

class ExceptionResponse(BaseModel):
    id: int
    task_id: str
    target_date: date
    exception_type: str
    override_load_value: Optional[float] = None
    start_time: Optional[time] = None
    end_time: Optional[time] = None
    notes: Optional[str] = None
    is_locked: bool = False
    created_at: datetime
    
    class Config: from_attributes = True

class ConditionUpdate(BaseModel):
    date: date
    cognitive_fatigue: int = Field(0, ge=0, le=5)
    physical_fatigue: Optional[int] = Field(0, ge=0, le=5)
    note: Optional[str] = None

class ConditionResponse(BaseModel):
    user_id: str
    target_date: date
    cognitive_fatigue: int
    physical_fatigue: int
    note: Optional[str]
    updated_at: datetime

    class Config:
        from_attributes = True

class DashboardResponse(BaseModel):
    today: dict
    weekly: dict
    daily_breakdown: List[dict]
    config: dict

class TrendResponse(BaseModel):
    trends: List[dict]

class ContextDistributionResponse(BaseModel):
    distribution: List[dict]

class LinkRequest(BaseModel):
    username_or_email: str
    password: str

class LoginRequest(BaseModel):
    username_or_email: str
    password: str

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"

class LinkConfirmRequest(BaseModel):
    external_jwt: str

class LinkedUserResponse(BaseModel):
    user_id: str
    username: str
    email: str
    issuer: str
    subject: str

class ProvisionRequest(BaseModel):
    rotate: bool = False
    scopes: List[str] = ["read"]

class ProvisionResponse(BaseModel):
    client_id: str
    already_exists: bool = False
    api_key: Optional[str] = None # Only once

class APIKeyCreate(BaseModel):
    client_id: str
    scopes: List[str] = ["read"]
    expires_in_days: Optional[int] = None

class APIKeyMetaResponse(BaseModel):
    id: str
    client_id: str
    scopes: List[str]
    is_active: bool
    created_at: datetime
    last_used_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    revoked_at: Optional[datetime] = None

    class Config: from_attributes = True

class APIKeyResponse(BaseModel):
    id: str
    client_id: str
    scopes: List[str]
    is_active: bool
    created_at: datetime
    last_used_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    revoked_at: Optional[datetime] = None
    api_key: Optional[str] = None # Plaintext once

    class Config: from_attributes = True
