from datetime import date, timedelta, datetime, timezone
from typing import List, Dict, Optional, Any
from sqlalchemy.orm import Session
from .repository import TaskRepository
from .lbs_engine import LBSEngine
from ..models.database import Task, TaskExecution, TaskStatus, TaskException
from ..utils.timezone import get_local_today, shift_task_time

class LBSManager:
    def __init__(self, session: Session, user_id: str, tz_name: str = "UTC"):
        self.session = session
        self.user_id = user_id
        self.tz_name = tz_name
        self.repo = TaskRepository(session)
        config = self.repo.get_system_config(user_id)
        self.engine = LBSEngine(config)

    def refresh_schedule(self, start_date: date, end_date: date, force: bool = False):
        """Refresh the daily cache for the given range, with debouncing"""
        if not force:
            from ..config import settings
            
            debounce_seconds = max(0, settings.LBS_REFRESH_DEBOUNCE_SECONDS)
            if settings.LBS_REFRESH_DEBOUNCE_ENABLED and debounce_seconds > 0:
                # Check if we have recent cache entries to avoid redundant refreshes in high-concurrency reloads
                recent_entries = self.repo.get_daily_cache_in_range(self.user_id, start_date, end_date)
                if recent_entries:
                    latest_gen = max(e.generated_at for e in recent_entries)
                    # Ensure latest_gen is timezone aware before subtraction
                    if latest_gen.tzinfo is None:
                        latest_gen = latest_gen.replace(tzinfo=timezone.utc)
                    # If cache was generated in the last N seconds, skip the refresh
                    if datetime.now(timezone.utc) - latest_gen < timedelta(seconds=debounce_seconds):
                        return
                        
        tasks = self.repo.get_active_tasks(self.user_id)
        executions = self.repo.get_executions_in_range(self.user_id, start_date, end_date)
        exceptions = self.repo.get_exceptions_in_range(self.user_id, start_date, end_date)
        conditions = self.repo.get_conditions_in_range(self.user_id, start_date, end_date)
        
        # Convert DailyCondition dict to Dict[date, int] for cognitive_fatigue
        fatigue_map = {d: c.cognitive_fatigue for d, c in conditions.items()}
        
        cache_entries = self.engine.calculate_schedule(
            self.user_id, start_date, end_date, tasks, executions, exceptions
        )
        
        # Update overflow flags based on conditions
        self.engine._calculate_overflow_flags(self.user_id, start_date, end_date, cache_entries, tasks, conditions=fatigue_map)
        
        from sqlalchemy.exc import IntegrityError
        try:
            self.repo.update_daily_cache(self.user_id, start_date, end_date, cache_entries)
            self.session.commit()
        except IntegrityError:
            self.session.rollback()
            # If another thread already inserted the cache, we can just continue
            pass

    def get_schedule(self, start_date: date, end_date: date) -> List[Dict]:
        """Get the schedule from cache, refreshing if necessary (caller should ideally handle refresh logic or manager does it)"""
        # For simplicity in this logic, we always refresh to ensure it's up to date with task rules
        self.refresh_schedule(start_date, end_date)
        
        # Now query the refreshed cache with task info
        cache_entries = self.repo.get_daily_cache_in_range(self.user_id, start_date, end_date)
        
        # Join with tasks (we already have them from repo)
        tasks = self.repo.get_active_tasks(self.user_id)
        task_map = {t.task_id: t for t in tasks}
        
        # Load conditions in range
        conditions = self.repo.get_conditions_in_range(self.user_id, start_date, end_date)
        
        schedule_map = {}
        for entry in cache_entries:
            d = entry.target_date
            if d not in schedule_map:
                schedule_map[d] = {"date": d, "total_load": 0.0, "tasks": []}
            
            task = task_map.get(entry.task_id)
            if not task: continue 
            
            # Note: entry.calculated_load is the base load per task.
            # The fatigue adjustment is currently applied at the daily aggregation level in LBSEngine.
            schedule_map[d]["total_load"] += entry.calculated_load
            
            # Apply task timezone shift if defined differently from requested timezone
            start_time = task.start_time
            end_time = task.end_time
            if task.timezone and task.timezone != self.tz_name:
                _, start_time = shift_task_time(d, task.start_time, task.timezone, self.tz_name)
                _, end_time = shift_task_time(d, task.end_time, task.timezone, self.tz_name)
                
            schedule_map[d]["tasks"].append({
                "task_id": task.task_id,
                "task_name": task.task_name,
                "context": task.context,
                "status": entry.status,
                "load": entry.calculated_load,
                "start_time": start_time,
                "end_time": end_time
            })
            
        # Post-process schedule to include fatigue-adjusted values
        results = []
        
        # Fetch exceptions for the range
        exceptions = self.repo.get_exceptions_in_range(self.user_id, start_date, end_date)
        
        for d in sorted(schedule_map.keys()):
            cond = conditions.get(d)
            fatigue = cond.cognitive_fatigue if cond else 0
            
            # Use engine to get the full breakdown including fatigue and exception overrides
            day_data = self.engine.calculate_daily_load(d, cache_entries, tasks, cognitive_fatigue=fatigue, exceptions=exceptions)
            results.append({
                "date": d,
                "total_load": day_data["adjusted_load"],
                "base_load": day_data["base_load"],
                "cap": day_data["cap"],
                "level": day_data["level"],
                "cognitive_fatigue": fatigue,
                "tasks": day_data["tasks"]
            })
            
        return results

    def update_task_execution(
        self,
        task_id: str,
        target_date: date,
        status: TaskStatus,
        progress: int | None = None,
        actual_time: int | None = None
    ) -> Dict:
        """Update task execution and refresh the specific day's cache (Race-condition safe)"""
        from sqlalchemy.exc import IntegrityError
        
        # Max retries to prevent infinite loop in case of unusual DB errors
        max_retries = 3
        for attempt in range(max_retries):
            existing = self.repo.get_execution(self.user_id, task_id, target_date)
            
            try:
                if status == TaskStatus.TODO:
                    if existing:
                        self.repo.delete_execution(existing)
                else:
                    resolved_progress = progress if progress is not None else (100 if status == TaskStatus.DONE else 0)
                    if not existing:
                        existing = TaskExecution(
                            user_id=self.user_id,
                            task_id=task_id,
                            target_date=target_date,
                            status=status,
                            progress=resolved_progress,
                            actual_time=actual_time
                        )
                        self.repo.create_execution(existing)
                    else:
                        existing.status = status
                        existing.progress = resolved_progress
                        if actual_time is not None:
                            existing.actual_time = actual_time
                
                self.session.commit()
                break # Success
            except IntegrityError:
                self.session.rollback()
                if attempt == max_retries - 1:
                    raise # Re-raise if we've exhausted retries
                # In case of IntegrityError, another request likely created the record.
                # Loop back, get_execution will find it, and we proceed to update.
                continue

        # Re-calculate and refresh for the specific day
        self.refresh_schedule(target_date, target_date, force=True)
        
        return {"message": f"Task execution updated: {status}", "status": status}

    def get_dashboard(self, start_date: date) -> Dict:
        """Get dashboard stats using Repository and Engine"""
        # Ensure cache is fresh for the week
        self.refresh_schedule(start_date, start_date + timedelta(days=6))
        
        cache_entries = self.repo.get_daily_cache_in_range(self.user_id, start_date, start_date + timedelta(days=6))
        tasks = self.repo.get_active_tasks(self.user_id) # Manager prefers Repo for entities
        
        # Load conditions for the week
        conditions = self.repo.get_conditions_in_range(self.user_id, start_date, start_date + timedelta(days=6))
        
        # Convert DailyCondition dict to Dict[date, int] for cognitive_fatigue
        fatigue_map = {d: c.cognitive_fatigue for d, c in conditions.items()}
        
        today = get_local_today(self.tz_name)
        today_cond = conditions.get(today)
        today_fatigue = today_cond.cognitive_fatigue if today_cond else 0
        
        # Dashboard defaults to showing TODO + SKIPPED + DONE
        filter_statuses = [TaskStatus.TODO, TaskStatus.SKIPPED, TaskStatus.DONE]
        
        today_data = self.engine.calculate_daily_load(today, cache_entries, tasks, filter_statuses=filter_statuses, cognitive_fatigue=today_fatigue)
        weekly_stats = self.engine.get_weekly_stats(start_date, cache_entries, tasks, filter_statuses=filter_statuses, conditions=fatigue_map)
        
        daily_breakdown = []
        for i in range(7):
            day = start_date + timedelta(days=i)
            day_cond = conditions.get(day)
            day_fatigue = day_cond.cognitive_fatigue if day_cond else 0
            daily_breakdown.append(self.engine.calculate_daily_load(day, cache_entries, tasks, filter_statuses=filter_statuses, cognitive_fatigue=day_fatigue))
            
        return {
            "today": today_data,
            "weekly": weekly_stats,
            "daily_breakdown": daily_breakdown,
            "config": self.engine.config
        }

    def get_trends(self, weeks: int, start_date: Optional[date] = None, status: List[TaskStatus] = [TaskStatus.TODO, TaskStatus.DONE]) -> List[Dict]:
        if not start_date:
            end_date = get_local_today(self.tz_name)
            start_date = end_date - timedelta(weeks=weeks)
        else:
            end_date = start_date + timedelta(weeks=weeks)
            
        # Ensure cache for trend range
        self.refresh_schedule(start_date, end_date)
        
        cache_entries = self.repo.get_daily_cache_in_range(self.user_id, start_date, end_date)
        tasks = self.repo.get_active_tasks(self.user_id)
        conditions = self.repo.get_conditions_in_range(self.user_id, start_date, end_date)
        fatigue_map = {d: c.cognitive_fatigue for d, c in conditions.items()}
        
        return self.engine.get_trend_data(weeks, start_date, end_date, cache_entries, tasks, filter_statuses=status, conditions=fatigue_map)

    def get_context_distribution(self, start: date, end: date, status: List[TaskStatus] = [TaskStatus.TODO, TaskStatus.DONE]) -> List[Dict]:
        self.refresh_schedule(start, end)
        cache_entries = self.repo.get_daily_cache_in_range(self.user_id, start, end)
        tasks = self.repo.get_active_tasks(self.user_id)
        
        return self.engine.get_context_distribution(start, end, cache_entries, tasks, filter_statuses=status)

    def list_tasks(self, context: Optional[str] = None, active: Optional[bool] = None) -> List[Task]:
        return self.repo.list_tasks(self.user_id, context, active)

    def get_task(self, task_id: str) -> Optional[Task]:
        return self.repo.get_task(self.user_id, task_id)

    def create_task(self, task: Task) -> Task:
        self.repo.create_task(task)
        self.session.commit()
        self.session.refresh(task)
        
        # Trigger refresh
        expand_start = task.start_date or get_local_today(self.tz_name)
        expand_end = task.end_date or (get_local_today(self.tz_name) + timedelta(days=90))
        self.refresh_schedule(expand_start, expand_end, force=True)
        return task

    def bulk_create_tasks(self, tasks: List[Task], start: date, end: date):
        self.repo.bulk_create_tasks(tasks)
        self.session.commit()
        self.refresh_schedule(start, end, force=True)

    def _check_permission(self, task: Task, exception: Optional[TaskException] = None, force_override: bool = False):
        """Unified lock enforcement following V2.1 Child Priority Matrix"""
        if force_override:
            return
            
        # Logic: Exception exists ? Exc.Lock : Task.Lock
        is_locked = exception.is_locked if exception else task.is_locked
        
        if is_locked:
            name = exception.exception_type if exception else task.task_name
            raise ValueError(f"Action blocked: '{name}' is locked. Use force_override=true to modify.")

    def update_task(self, task_id: str, update_data: Dict[str, Any], force_override: bool = False) -> Optional[Task]:
        task = self.repo.get_task(self.user_id, task_id)
        if not task:
            return None
        
        # Lock check (V2.1 Section A: Task def only depends on Task.is_locked)
        self._check_permission(task, force_override=force_override)

        for field, value in update_data.items():
            setattr(task, field, value)
        
        from datetime import datetime
        task.updated_at = datetime.now(timezone.utc)
        self.session.commit()
        self.session.refresh(task)
        
        expand_start = task.start_date or get_local_today(self.tz_name)
        expand_end = task.end_date or (get_local_today(self.tz_name) + timedelta(days=90))
        self.refresh_schedule(expand_start, expand_end, force=True)
        return task

    def delete_task(self, task_id: str, force_override: bool = False) -> bool:
        task = self.repo.get_task(self.user_id, task_id)
        if not task:
            return False
        
        # Lock check (V2.1 Section A: Task def only depends on Task.is_locked)
        self._check_permission(task, force_override=force_override)
        
        self.repo.delete_task(task)
        self.session.commit()
        today = get_local_today(self.tz_name)
        self.refresh_schedule(today, today + timedelta(days=90), force=True)
        return True

    def bulk_delete_tasks(self, task_ids: List[str], force_override: bool = False) -> int:
        if not force_override:
            tasks = self.repo.get_tasks_by_ids(self.user_id, task_ids)
            for t in tasks:
                self._check_permission(t, force_override=force_override)

        count = self.repo.bulk_delete_tasks(self.user_id, task_ids)
        if count > 0:
            self.session.commit()
            today = get_local_today(self.tz_name)
            self.refresh_schedule(today, today + timedelta(days=90), force=True)
        return count

    def bulk_update_active(self, task_ids: List[str], active: bool, force_override: bool = False) -> int:
        if not force_override:
            tasks = self.repo.get_tasks_by_ids(self.user_id, task_ids)
            for t in tasks:
                self._check_permission(t, force_override=force_override)

        updated = self.repo.bulk_update_active(self.user_id, task_ids, active)
        if updated:
            from datetime import datetime
            for t in updated:
                t.updated_at = datetime.now(timezone.utc)
            self.session.commit()
            today = get_local_today(self.tz_name)
            self.refresh_schedule(today, today + timedelta(days=90), force=True)
        return len(updated)

    def get_task_history(self, task_id: str, start_date: date, end_date: date) -> List[TaskExecution]:
        return self.repo.get_task_history(task_id, start_date, end_date)

    def create_exception(self, exception_data: Dict[str, Any], force_override: bool = False) -> TaskException:
        from ..models.database import TaskException
        
        # Lock check (V2.1 Section B: Create uses Task.is_locked as fallback)
        task = self.repo.get_task(self.user_id, exception_data["task_id"])
        if not task:
            raise ValueError("Task not found")
        self._check_permission(task, force_override=force_override)

        new_exc = TaskException(
            **exception_data,
            user_id=self.user_id
        )
        self.repo.create_exception(new_exc)
        self.session.commit()
        self.session.refresh(new_exc)
        self.refresh_schedule(new_exc.target_date, new_exc.target_date, force=True)
        return new_exc

    def get_exception(self, exception_id: int):
        return self.repo.get_exception(self.user_id, exception_id)

    def list_exceptions(self, task_id: Optional[str] = None, start_date: Optional[date] = None, end_date: Optional[date] = None):
        return self.repo.list_exceptions(self.user_id, task_id, start_date, end_date)

    def update_exception(self, exception_id: int, update_data: Dict[str, Any], force_override: bool = False):
        exc = self.repo.get_exception(self.user_id, exception_id)
        if not exc:
            return None
        
        # Lock check (V2.1 Section B: Update uses Exc.is_locked priority)
        task = self.repo.get_task(self.user_id, exc.task_id)
        self._check_permission(task, exception=exc, force_override=force_override)

        for field, value in update_data.items():
            setattr(exc, field, value)
        
        self.session.commit()
        self.session.refresh(exc)
        self.refresh_schedule(exc.target_date, exc.target_date, force=True)
        return exc

    def delete_exception(self, exception_id: int, force_override: bool = False) -> bool:
        exc = self.repo.get_exception(self.user_id, exception_id)
        if not exc:
            return False
        
        # Lock check (V2.1 Section B: Delete uses Exc.is_locked priority)
        task = self.repo.get_task(self.user_id, exc.task_id)
        self._check_permission(task, exception=exc, force_override=force_override)
        
        target_date = exc.target_date
        self.repo.delete_exception(exc)
        self.session.commit()
        self.refresh_schedule(target_date, target_date, force=True)
        return True

    def get_resolved_task(self, task_id: str, target_date: date) -> Optional[Dict]:
        """
        Get a task resolved with any exception overrides for a specific date.
        Returns task data with exception-adjusted values if an exception exists.
        """
        task = self.repo.get_task(self.user_id, task_id)
        if not task:
            return None
        
        # Get exception for this task on the target date
        exception = self.repo.get_exception_for_task_date(self.user_id, task_id, target_date)
        
        # Get cached entry for load
        cache_entries = self.repo.get_daily_cache_in_range(self.user_id, target_date, target_date)
        cache_entry = next((e for e in cache_entries if e.task_id == task_id), None)
        
        # Build resolved task
        resolved = {
            "task_id": task.task_id,
            "task_name": task.task_name,
            "context": task.context,
            "base_load_score": task.base_load_score,
            "active": task.active,
            "rule_type": task.rule_type,
            "is_locked": exception.is_locked if exception else task.is_locked,
            "target_date": target_date,
            # Times - apply exception overrides if present
            "start_time": exception.start_time if exception and exception.start_time else task.start_time,
            "end_time": exception.end_time if exception and exception.end_time else task.end_time,
            # Load - apply exception override if present
            "load": cache_entry.calculated_load if cache_entry else task.base_load_score,
            "status": cache_entry.status if cache_entry else None,
            # Exception info
            "has_exception": exception is not None,
            "exception": {
                "id": exception.id,
                "exception_type": exception.exception_type,
                "override_load_value": exception.override_load_value,
                "start_time": exception.start_time,
                "end_time": exception.end_time,
                "notes": exception.notes,
                "is_locked": exception.is_locked
            } if exception else None
        }
        
        return resolved
