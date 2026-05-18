from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Header
from sqlalchemy.orm import Session
from datetime import date, timedelta, datetime
from typing import List, Optional
import uuid
import csv
import io
import logging

logger = logging.getLogger(__name__)

from ..models.database import get_db, Task, TaskException, TaskStatus, TaskExecution
from ..services.manager import LBSManager
from ..utils.timezone import get_local_today
from ..auth import require_user_identity, Identity
from .schemas import (
    TaskCreate, 
    TaskUpdate, 
    TaskResponse, 
    DashboardResponse,
    TaskBulkDelete,
    TaskBulkActiveUpdate,
    TaskExecutionRequest,
    TaskExecutionResponse,
    DailySchedule,
    ExceptionCreate,
    ExceptionUpdate,
    ExceptionResponse
)

router = APIRouter(tags=["LBS"])

@router.get("/health")
def health_check():
    return {"status": "healthy", "service": "lbs-api"}

@router.get("/schedule", response_model=List[DailySchedule])
def get_schedule(
    start_date: date,
    end_date: date,
    identity: Identity = Depends(require_user_identity),
    db: Session = Depends(get_db),
    x_timezone: str = Header("UTC")
):
    """Unified schedule API via Manager"""
    manager = LBSManager(db, identity.user_id, tz_name=x_timezone)
    return manager.get_schedule(start_date, end_date)

@router.get("/dashboard", response_model=DashboardResponse)
def get_dashboard(
    start_date: Optional[date] = None,
    identity: Identity = Depends(require_user_identity),
    db: Session = Depends(get_db),
    x_timezone: str = Header("UTC")
):
    if not start_date:
        start_date = get_local_today(x_timezone) - timedelta(days=get_local_today(x_timezone).weekday())
    
    manager = LBSManager(db, identity.user_id, tz_name=x_timezone)
    dash = manager.get_dashboard(start_date)
    return {
        **dash,
        "warnings": identity.warnings
    }

@router.post("/tasks", response_model=TaskResponse)
def create_task(
    task_in: TaskCreate,
    identity: Identity = Depends(require_user_identity),
    db: Session = Depends(get_db),
    x_timezone: str = Header("UTC")
):
    manager = LBSManager(db, identity.user_id, tz_name=x_timezone)
    task_id = f"T-{uuid.uuid4().hex[:8].upper()}"
    try:
        db_task = Task(
            **task_in.model_dump(exclude={'status'}),
            task_id=task_id,
            user_id=identity.user_id
        )
        return manager.create_task(db_task)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/tasks", response_model=List[TaskResponse])
def list_tasks(
    context: Optional[str] = None,
    active: Optional[bool] = Query(None),
    identity: Identity = Depends(require_user_identity),
    db: Session = Depends(get_db),
    x_timezone: str = Header("UTC")
):
    manager = LBSManager(db, identity.user_id, tz_name=x_timezone)
    return manager.list_tasks(context=context, active=active)

@router.get("/tasks/{task_id}", response_model=TaskResponse)
def get_task_detail(
    task_id: str,
    identity: Identity = Depends(require_user_identity),
    db: Session = Depends(get_db),
    x_timezone: str = Header("UTC")
):
    manager = LBSManager(db, identity.user_id, tz_name=x_timezone)
    task = manager.repo.get_task(identity.user_id, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task

@router.get("/tasks/{task_id}/history", response_model=List[TaskExecutionResponse])
def get_task_history(
    task_id: str,
    start_date: date,
    end_date: date,
    identity: Identity = Depends(require_user_identity),
    db: Session = Depends(get_db),
    x_timezone: str = Header("UTC")
):
    manager = LBSManager(db, identity.user_id, tz_name=x_timezone)
    task = manager.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
        
    return manager.get_task_history(task_id, start_date, end_date)

@router.get("/tasks/{task_id}/resolved")
def get_resolved_task(
    task_id: str,
    target_date: date,
    identity: Identity = Depends(require_user_identity),
    db: Session = Depends(get_db),
    x_timezone: str = Header("UTC")
):
    """
    Get a task with any exception overrides applied for a specific date.
    Returns the task with resolved times, load, and exception details.
    """
    manager = LBSManager(db, identity.user_id, tz_name=x_timezone)
    resolved = manager.get_resolved_task(task_id, target_date)
    if not resolved:
        raise HTTPException(status_code=404, detail="Task not found")
    return resolved

@router.put("/tasks/{task_id}", response_model=TaskResponse)
def update_task(
    task_id: str,
    task_in: TaskUpdate,
    force_override: bool = Query(False),
    identity: Identity = Depends(require_user_identity),
    db: Session = Depends(get_db),
    x_timezone: str = Header("UTC")
):
    manager = LBSManager(db, identity.user_id, tz_name=x_timezone)
    update_data = task_in.model_dump(exclude_unset=True)
    try:
        updated_task = manager.update_task(task_id, update_data, force_override=force_override)
        if not updated_task:
            raise HTTPException(status_code=404, detail="Task not found")
        return updated_task
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e))

@router.post("/tasks/upload-csv")
def upload_tasks_csv(
    file: UploadFile = File(...),
    identity: Identity = Depends(require_user_identity),
    db: Session = Depends(get_db),
    x_timezone: str = Header("UTC")
):
    if not file.filename.endswith('.csv'):
        raise HTTPException(status_code=400, detail="Only CSV files are allowed")
    
    manager = LBSManager(db, identity.user_id, tz_name=x_timezone)
    contents = file.file.read().decode('utf-8')
    reader = csv.DictReader(io.StringIO(contents))
    
    tasks_to_create = []
    min_start = get_local_today(x_timezone)
    max_end = get_local_today(x_timezone) + timedelta(days=90)

    for row in reader:
        try:
            task_id = f"T-{uuid.uuid4().hex[:8].upper()}"
            def to_bool(val):
                if not val: return False
                return str(val).lower() in ('true', '1', 'yes', 'y', 't')

            rule_type = row.get('rule_type', 'WEEKLY').upper()
            db_task = Task(
                task_id=task_id,
                user_id=identity.user_id,
                task_name=row.get('task_name', 'Untitled Task'),
                context=row.get('context', 'work').lower(),
                base_load_score=float(row.get('base_load_score', 2.0)),
                active=to_bool(row.get('active', 'true')),
                rule_type=rule_type,
                due_date=date.fromisoformat(row['due_date']) if row.get('due_date') and row['due_date'].strip() else None,
                mon=to_bool(row.get('mon', 'false')),
                tue=to_bool(row.get('tue', 'false')),
                wed=to_bool(row.get('wed', 'false')),
                thu=to_bool(row.get('thu', 'false')),
                fri=to_bool(row.get('fri', 'false')),
                sat=to_bool(row.get('sat', 'false')),
                sun=to_bool(row.get('sun', 'false')),
                interval_days=int(row['interval_days']) if row.get('interval_days') and row['interval_days'].strip() else None,
                anchor_date=date.fromisoformat(row['anchor_date']) if row.get('anchor_date') and row['anchor_date'].strip() else None,
                month_day=int(row['month_day']) if row.get('month_day') and row['month_day'].strip() else None,
                nth_in_month=int(row['nth_in_month']) if row.get('nth_in_month') and row['nth_in_month'].strip() else None,
                weekday_mon1=int(row['weekday_mon1']) if row.get('weekday_mon1') and row['weekday_mon1'].strip() else None,
                start_date=date.fromisoformat(row['start_date']) if row.get('start_date') and row['start_date'].strip() else None,
                end_date=date.fromisoformat(row['end_date']) if row.get('end_date') and row['end_date'].strip() else None,
                notes=row.get('notes'),
                external_sync_id=row.get('external_sync_id'),
                timezone=row.get('timezone', x_timezone)
            )
            if db_task.start_date and db_task.start_date < min_start: min_start = db_task.start_date
            if db_task.end_date and db_task.end_date > max_end: max_end = db_task.end_date
            tasks_to_create.append(db_task)
        except Exception as e:
            logger.warning(f"Error parsing row: {e}")
            continue

    if tasks_to_create:
        manager.bulk_create_tasks(tasks_to_create, min_start, max_end)
        
    return {
        "message": f"Successfully imported {len(tasks_to_create)} tasks",
        "imported": len(tasks_to_create)
    }

@router.delete("/tasks/{task_id}")
def delete_task(
    task_id: str,
    force_override: bool = Query(False),
    identity: Identity = Depends(require_user_identity),
    db: Session = Depends(get_db),
    x_timezone: str = Header("UTC")
):
    manager = LBSManager(db, identity.user_id, tz_name=x_timezone)
    try:
        if not manager.delete_task(task_id, force_override=force_override):
            raise HTTPException(status_code=404, detail="Task not found")
        return {"message": "Task deleted successfully"}
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e))

@router.post("/tasks/bulk-delete")
def bulk_delete_tasks(
    bulk_in: TaskBulkDelete,
    force_override: bool = Query(False),
    identity: Identity = Depends(require_user_identity),
    db: Session = Depends(get_db),
    x_timezone: str = Header("UTC")
):
    manager = LBSManager(db, identity.user_id, tz_name=x_timezone)
    try:
        count = manager.bulk_delete_tasks(bulk_in.task_ids, force_override=force_override)
        if count == 0:
            return {"message": "No tasks found to delete"}
        return {"message": f"Successfully deleted {count} tasks"}
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e))

@router.post("/tasks/bulk-update-active")
def bulk_update_active(
    bulk_in: TaskBulkActiveUpdate,
    force_override: bool = Query(False),
    identity: Identity = Depends(require_user_identity),
    db: Session = Depends(get_db),
    x_timezone: str = Header("UTC")
):
    manager = LBSManager(db, identity.user_id, tz_name=x_timezone)
    try:
        count = manager.bulk_update_active(bulk_in.task_ids, bulk_in.active, force_override=force_override)
        if count == 0:
            return {"message": "No tasks found to update"}
        return {"message": f"Successfully updated active status for {count} tasks"}
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e))

@router.post("/tasks/{task_id}/complete")
def handle_task_completion(
    task_id: str,
    req: TaskExecutionRequest,
    identity: Identity = Depends(require_user_identity),
    db: Session = Depends(get_db),
    x_timezone: str = Header("UTC")
):
    manager = LBSManager(db, identity.user_id, tz_name=x_timezone)
    task = manager.repo.get_task(identity.user_id, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    return manager.update_task_execution(
        task_id,
        req.target_date,
        req.status,
        progress=req.progress,
        actual_time=req.actual_time
    )

@router.post("/exceptions", response_model=ExceptionResponse)
def create_exception(
    exc: ExceptionCreate,
    force_override: bool = Query(False),
    identity: Identity = Depends(require_user_identity),
    db: Session = Depends(get_db),
    x_timezone: str = Header("UTC")
):
    manager = LBSManager(db, identity.user_id, tz_name=x_timezone)
    task = manager.get_task(exc.task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    try:
        created = manager.create_exception(exc.model_dump(), force_override=force_override)
        return created
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e))

@router.get("/exceptions")
def list_exceptions(
    task_id: Optional[str] = None,
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
    identity: Identity = Depends(require_user_identity),
    db: Session = Depends(get_db),
    x_timezone: str = Header("UTC")
):
    manager = LBSManager(db, identity.user_id, tz_name=x_timezone)
    return manager.list_exceptions(task_id, start_date, end_date)

@router.get("/exceptions/{exception_id}", response_model=ExceptionResponse)
def get_exception(
    exception_id: int,
    identity: Identity = Depends(require_user_identity),
    db: Session = Depends(get_db),
    x_timezone: str = Header("UTC")
):
    manager = LBSManager(db, identity.user_id, tz_name=x_timezone)
    exc = manager.get_exception(exception_id)
    if not exc:
        raise HTTPException(status_code=404, detail="Exception not found")
    return exc

@router.put("/exceptions/{exception_id}", response_model=ExceptionResponse)
def update_exception(
    exception_id: int,
    exc_update: ExceptionUpdate,
    force_override: bool = Query(False),
    identity: Identity = Depends(require_user_identity),
    db: Session = Depends(get_db),
    x_timezone: str = Header("UTC")
):
    manager = LBSManager(db, identity.user_id, tz_name=x_timezone)
    try:
        updated = manager.update_exception(exception_id, exc_update.model_dump(exclude_unset=True), force_override=force_override)
        if not updated:
            raise HTTPException(status_code=404, detail="Exception not found")
        return updated
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e))

@router.delete("/exceptions/{exception_id}")
def delete_exception(
    exception_id: int,
    force_override: bool = Query(False),
    identity: Identity = Depends(require_user_identity),
    db: Session = Depends(get_db),
    x_timezone: str = Header("UTC")
):
    manager = LBSManager(db, identity.user_id, tz_name=x_timezone)
    try:
        if not manager.delete_exception(exception_id, force_override=force_override):
            raise HTTPException(status_code=404, detail="Exception not found")
        return {"message": "Exception deleted successfully"}
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e))

@router.get("/calculate/{target_date}")
def calculate_load(
    target_date: date,
    status: List[TaskStatus] = Query(default=[TaskStatus.TODO, TaskStatus.DONE]),
    identity: Identity = Depends(require_user_identity),
    db: Session = Depends(get_db),
    x_timezone: str = Header("UTC")
):
    manager = LBSManager(db, identity.user_id, tz_name=x_timezone)
    # Ensure cache is fresh for the day
    manager.refresh_schedule(target_date, target_date)
    cache_entries = manager.repo.get_daily_cache_in_range(identity.user_id, target_date, target_date)
    tasks = manager.repo.get_active_tasks(identity.user_id)
    
    # Fetch condition
    cond = manager.repo.get_condition(identity.user_id, target_date)
    fatigue = cond.cognitive_fatigue if cond else 0
    
    return manager.engine.calculate_daily_load(target_date, cache_entries, tasks, filter_statuses=status, cognitive_fatigue=fatigue)

@router.post("/expand")
def expand_tasks(
    start_date: date,
    end_date: date,
    identity: Identity = Depends(require_user_identity),
    db: Session = Depends(get_db),
    x_timezone: str = Header("UTC")
):
    manager = LBSManager(db, identity.user_id, tz_name=x_timezone)
    manager.refresh_schedule(start_date, end_date)
    return {"message": "Expansion complete"}

@router.get("/heatmap")
def get_heatmap(
    start: date,
    end: date,
    status: List[TaskStatus] = Query(default=[TaskStatus.TODO, TaskStatus.DONE]),
    identity: Identity = Depends(require_user_identity),
    db: Session = Depends(get_db),
    x_timezone: str = Header("UTC")
):
    manager = LBSManager(db, identity.user_id, tz_name=x_timezone)
    manager.refresh_schedule(start, end)
    
    cache_entries = manager.repo.get_daily_cache_in_range(identity.user_id, start, end)
    tasks = manager.repo.get_active_tasks(identity.user_id)
    
    # Fetch conditions for the range
    conditions = manager.repo.get_conditions_in_range(identity.user_id, start, end)
    
    data = []
    curr = start
    while curr <= end:
        cond = conditions.get(curr)
        fatigue = cond.cognitive_fatigue if cond else 0
        
        load = manager.engine.calculate_daily_load(curr, cache_entries, tasks, filter_statuses=status, cognitive_fatigue=fatigue)
        data.append({
            "date": str(curr),
            "adjusted_load": load["adjusted_load"],
            "level": load["level"],
            "task_count": load["task_count"],
            "cap": load["cap"],
            "cognitive_fatigue": fatigue
        })
        curr += timedelta(days=1)
    return data

@router.get("/trends")
def get_trends(
    weeks: int = 12,
    start_date: Optional[date] = None,
    status: List[TaskStatus] = Query(default=[TaskStatus.TODO, TaskStatus.DONE]),
    identity: Identity = Depends(require_user_identity),
    db: Session = Depends(get_db),
    x_timezone: str = Header("UTC")
):
    manager = LBSManager(db, identity.user_id, tz_name=x_timezone)
    
    return {"trends": manager.get_trends(weeks, start_date, status)}

@router.get("/context-distribution")
def get_context_distribution(
    start: date,
    end: date,
    status: List[TaskStatus] = Query(default=[TaskStatus.TODO, TaskStatus.DONE]),
    identity: Identity = Depends(require_user_identity),
    db: Session = Depends(get_db),
    x_timezone: str = Header("UTC")
):
    manager = LBSManager(db, identity.user_id, tz_name=x_timezone)
    
    return {"distribution": manager.get_context_distribution(start, end, status)}
