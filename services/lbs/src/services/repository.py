from datetime import date
from typing import List, Dict, Optional, Any
from sqlalchemy.orm import Session
from ..models.database import Task, TaskException, LBSDailyCache, SystemConfig, TaskExecution, TaskStatus, DailyCondition
from ..config import settings

class TaskRepository:
    def __init__(self, session: Session):
        self.session = session

    def get_system_config(self, user_id: str) -> Dict[str, float]:
        """Load user-specific or default configuration"""
        configs = self.session.query(SystemConfig).filter(SystemConfig.user_id == user_id).all()
        config_dict = {c.key: float(c.value) for c in configs}
        
        return {
            "ALPHA": config_dict.get("ALPHA", settings.DEFAULT_ALPHA),
            "BETA": config_dict.get("BETA", settings.DEFAULT_BETA),
            "CAP": config_dict.get("CAP", settings.DEFAULT_CAP),
            "SWITCH_COST": config_dict.get("SWITCH_COST", settings.DEFAULT_SWITCH_COST),
        }

    def get_active_tasks(self, user_id: str) -> List[Task]:
        """Get all active tasks for user"""
        return self.session.query(Task).filter(
            Task.user_id == user_id,
            Task.active == True
        ).all()

    def get_executions_in_range(self, user_id: str, start: date, end: date) -> Dict[tuple, TaskExecution]:
        """Load execution history in range as a dict keyed by (task_id, target_date)"""
        executions = self.session.query(TaskExecution).filter(
            TaskExecution.user_id == user_id,
            TaskExecution.target_date >= start,
            TaskExecution.target_date <= end
        ).all()
        return {(e.task_id, e.target_date): e for e in executions}

    def get_exceptions_in_range(self, user_id: str, start: date, end: date) -> Dict[tuple, TaskException]:
        """Load exceptions in range as a dict keyed by (task_id, target_date)"""
        exceptions = self.session.query(TaskException).filter(
            TaskException.user_id == user_id,
            TaskException.target_date >= start,
            TaskException.target_date <= end
        ).all()
        return {(exc.task_id, exc.target_date): exc for exc in exceptions}

    def get_daily_cache_in_range(self, user_id: str, start: date, end: date) -> List[LBSDailyCache]:
        """Get cache entries in range"""
        return self.session.query(LBSDailyCache).filter(
            LBSDailyCache.user_id == user_id,
            LBSDailyCache.target_date >= start,
            LBSDailyCache.target_date <= end
        ).all()

    def update_daily_cache(self, user_id: str, start: date, end: date, entries: List[LBSDailyCache]):
        """Delete existing cache and bulk save new entries"""
        self.session.query(LBSDailyCache).filter(
            LBSDailyCache.user_id == user_id,
            LBSDailyCache.target_date >= start,
            LBSDailyCache.target_date <= end
        ).delete()
        
        if entries:
            # SQLAlchemy might need these to be associated with the session if they aren't already
            self.session.bulk_save_objects(entries)

    # CRUD for Task
    def create_task(self, task: Task):
        self.session.add(task)

    def get_task(self, user_id: str, task_id: str) -> Optional[Task]:
        return self.session.query(Task).filter(Task.task_id == task_id, Task.user_id == user_id).first()

    def get_tasks_by_ids(self, user_id: str, task_ids: List[str]) -> List[Task]:
        return self.session.query(Task).filter(
            Task.task_id.in_(task_ids),
            Task.user_id == user_id
        ).all()

    def list_tasks(self, user_id: str, context: Optional[str] = None, active: Optional[bool] = None) -> List[Task]:
        query = self.session.query(Task).filter(Task.user_id == user_id)
        if active is not None:
            query = query.filter(Task.active == active)
        if context:
            query = query.filter(Task.context == context)
        return query.all()

    def delete_task(self, task: Task):
        self.session.delete(task)

    def bulk_create_tasks(self, tasks: List[Task]):
        self.session.bulk_save_objects(tasks)

    def bulk_update_active(self, user_id: str, task_ids: List[str], active: bool) -> List[Task]:
        tasks = self.session.query(Task).filter(
            Task.task_id.in_(task_ids),
            Task.user_id == user_id
        ).all()
        for t in tasks:
            t.active = active
        return tasks

    def bulk_delete_tasks(self, user_id: str, task_ids: List[str]) -> int:
        return self.session.query(Task).filter(
            Task.task_id.in_(task_ids),
            Task.user_id == user_id
        ).delete(synchronize_session='fetch')

    # CRUD for Execution
    def create_execution(self, execution: TaskExecution):
        self.session.add(execution)

    def get_execution(self, user_id: str, task_id: str, target_date: date) -> Optional[TaskExecution]:
        return self.session.query(TaskExecution).filter(
            TaskExecution.user_id == user_id,
            TaskExecution.task_id == task_id,
            TaskExecution.target_date == target_date
        ).first()

    def get_task_history(self, task_id: str, start_date: date, end_date: date) -> List[TaskExecution]:
        return self.session.query(TaskExecution).filter(
            TaskExecution.task_id == task_id,
            TaskExecution.target_date >= start_date,
            TaskExecution.target_date <= end_date
        ).order_by(TaskExecution.target_date.asc()).all()

    def delete_execution(self, execution: TaskExecution):
        self.session.delete(execution)

    # CRUD for Exception
    def create_exception(self, exception: TaskException):
        self.session.add(exception)

    def get_exception(self, user_id: str, exception_id: int) -> Optional[TaskException]:
        return self.session.query(TaskException).filter(
            TaskException.id == exception_id,
            TaskException.user_id == user_id
        ).first()

    def get_exception_for_task_date(self, user_id: str, task_id: str, target_date: date) -> Optional[TaskException]:
        return self.session.query(TaskException).filter(
            TaskException.user_id == user_id,
            TaskException.task_id == task_id,
            TaskException.target_date == target_date
        ).first()

    def list_exceptions(self, user_id: str, task_id: Optional[str] = None, start_date: Optional[date] = None, end_date: Optional[date] = None) -> List[TaskException]:
        query = self.session.query(TaskException).filter(TaskException.user_id == user_id)
        if task_id:
            query = query.filter(TaskException.task_id == task_id)
        if start_date:
            query = query.filter(TaskException.target_date >= start_date)
        if end_date:
            query = query.filter(TaskException.target_date <= end_date)
        return query.order_by(TaskException.target_date.asc()).all()

    def delete_exception(self, exception: TaskException):
        self.session.delete(exception)

    # CRUD for DailyCondition
    def get_condition(self, user_id: str, target_date: date) -> Optional[DailyCondition]:
        return self.session.query(DailyCondition).filter(
            DailyCondition.user_id == user_id,
            DailyCondition.target_date == target_date
        ).first()

    def get_conditions_in_range(self, user_id: str, start: date, end: date) -> Dict[date, DailyCondition]:
        conditions = self.session.query(DailyCondition).filter(
            DailyCondition.user_id == user_id,
            DailyCondition.target_date >= start,
            DailyCondition.target_date <= end
        ).all()
        return {c.target_date: c for c in conditions}

    def upsert_condition(self, condition: DailyCondition):
        existing = self.get_condition(condition.user_id, condition.target_date)
        if existing:
            existing.cognitive_fatigue = condition.cognitive_fatigue
            existing.physical_fatigue = condition.physical_fatigue
            existing.note = condition.note
        else:
            self.session.add(condition)
