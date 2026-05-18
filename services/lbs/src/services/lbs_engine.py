from datetime import date, timedelta
from typing import List, Dict, Optional
from calendar import monthrange
import time
import logging

logger = logging.getLogger(__name__)

from ..models.database import Task, TaskException, LBSDailyCache, TaskExecution, TaskStatus

class LBSEngine:
    """User-scoped LBS calculation and expansion logic - Pure Version"""
    
    def __init__(self, config: Dict[str, float]):
        self.config = config
    
    def calculate_schedule(
        self, 
        user_id: str, 
        start_date: date, 
        end_date: date, 
        tasks: List[Task], 
        executions: Dict[tuple, TaskExecution], 
        exceptions: Dict[tuple, TaskException]
    ) -> List[LBSDailyCache]:
        """Calculate task rules into daily cache entries for the given date range"""
        start_time = time.time()
        
        cache_entries = []
        
        # Process recurrence
        for task in tasks:
            current_date = start_date
            # Optimization: for ONCE tasks, we only care about the due_date OR exceptions
            if task.rule_type == "ONCE":
                # Regular occurrence
                if task.due_date and start_date <= task.due_date <= end_date:
                    self._process_day(user_id, task, task.due_date, exceptions, cache_entries, executions)
                
                # Check for FORCE_DO or MANUAL_LOCK exceptions on other dates
                for (t_id, d), exc in exceptions.items():
                    if t_id == task.task_id and exc.exception_type in ["FORCE_DO", "MANUAL_LOCK"]:
                        if d != task.due_date: # Don't double process
                            self._process_day(user_id, task, d, exceptions, cache_entries, executions)
                continue

            # Recurring tasks
            while current_date <= end_date:
                occurs = self._should_task_occur(task, current_date)
                exception = exceptions.get((task.task_id, current_date))
                
                if occurs:
                    # Normal occurrence, check for SKIP
                    if not (exception and exception.exception_type == "SKIP"):
                        self._process_day(user_id, task, current_date, exceptions, cache_entries, executions)
                else:
                    # No normal occurrence, check for FORCE_DO or MANUAL_LOCK
                    if exception and exception.exception_type in ["FORCE_DO", "MANUAL_LOCK"]:
                        self._process_day(user_id, task, current_date, exceptions, cache_entries, executions)
                
                current_date += timedelta(days=1)
        
        # Update overflow flags in the results (note: this is now internal to the pure calculation)
        self._calculate_overflow_flags(user_id, start_date, end_date, cache_entries, tasks)
        
        logger.info(f"[LBS Engine] Calculated {len(cache_entries)} entries for user {user_id} in {time.time() - start_time:.3f}s")
        return cache_entries

    def _process_day(self, user_id, task, day_date, exceptions, cache_entries, executions):
        exception = exceptions.get((task.task_id, day_date))
        
        load = task.base_load_score
        if exception and exception.exception_type in ["OVERRIDE_LOAD", "MANUAL_LOCK"]:
            if exception.override_load_value is not None:
                load = exception.override_load_value
        elif exception and exception.exception_type == "FORCE_DO" and exception.override_load_value is not None:
             load = exception.override_load_value
        # RESCHEDULE type: doesn't change load, only allows time override (handled at output level)
            
        execution = executions.get((task.task_id, day_date))

        cache_entries.append(LBSDailyCache(
            user_id=user_id,
            target_date=day_date,
            task_id=task.task_id,
            calculated_load=load,
            status=execution.status if execution else TaskStatus.TODO
        ))

    def _should_task_occur(self, task: Task, target_date: date) -> bool:
        if task.start_date and target_date < task.start_date: return False
        if task.end_date and target_date > task.end_date: return False
        
        rule = task.rule_type
        if rule == "WEEKLY":
            weekday = target_date.weekday()
            flags = [task.mon, task.tue, task.wed, task.thu, task.fri, task.sat, task.sun]
            return flags[weekday]
        
        if rule == "EVERY_N_DAYS":
            if not task.anchor_date or not task.interval_days: return False
            diff = (target_date - task.anchor_date).days
            return diff >= 0 and diff % task.interval_days == 0
            
        if rule == "MONTHLY_DAY":
            if not task.month_day: return False
            _, last = monthrange(target_date.year, target_date.month)
            return target_date.day == min(task.month_day, last)
            
        if rule == "MONTHLY_NTH_WEEKDAY":
            if not task.nth_in_month or not task.weekday_mon1: return False
            target_weekday = (task.weekday_mon1 - 1) % 7
            if target_date.weekday() != target_weekday: return False
            occ = (target_date.day - 1) // 7 + 1
            if task.nth_in_month == -1:
                return (target_date + timedelta(days=7)).month != target_date.month
            return occ == task.nth_in_month
        
        return False

    def calculate_daily_load(
        self, 
        target_date: date, 
        cache_entries: List[LBSDailyCache], 
        tasks: List[Task], 
        filter_statuses: Optional[List[TaskStatus]] = None,
        cognitive_fatigue: int = 0,
        exceptions: Dict = None
    ) -> Dict:
        """Pure calculation of daily load from cache entries and task metadata with fatigue adjustment"""
        alpha = self.config["ALPHA"]
        beta = self.config["BETA"]
        switch_cost = self.config["SWITCH_COST"]
        cap = self.config["CAP"]
        
        if filter_statuses is None:
            filter_statuses = [TaskStatus.TODO, TaskStatus.DONE]
            
        # Filter entries for the target date and status
        day_entries = [e for e in cache_entries if e.target_date == target_date and e.status in filter_statuses]
            
        if not day_entries:
            # Even if there are no tasks, return the effective capacity
            effective_cap = cap * (1.0 - 0.1 * cognitive_fatigue)
            return {
                "date": target_date, 
                "base_load": 0.0,
                "task_count": 0, 
                "unique_contexts": 0,
                "adjusted_load": 0.0, 
                "count_penalty": 0.0,
                "context_penalty": 0.0,
                "level": "SAFE", 
                "cap": round(effective_cap, 2), 
                "base_cap": cap,
                "cognitive_fatigue": cognitive_fatigue,
                "tasks": []
            }
            
        base_load = sum(e.calculated_load for e in day_entries)
        task_count = len(day_entries)
        
        # Find unique contexts using pre-fetched tasks
        task_map = {t.task_id: t for t in tasks}
        current_tasks = [task_map[e.task_id] for e in day_entries if e.task_id in task_map]
        unique_contexts = len(set(t.context for t in current_tasks))
        
        count_penalty = alpha * (task_count ** beta)
        context_penalty = switch_cost * max(unique_contexts - 1, 0)
        
        # Apply fatigue adjustments (B+C Model)
        # Load: Effective = Base * (1.0 + 0.2 * Fc)
        # Cap:  Effective = Base * (1.0 - 0.1 * Fc)
        base_adjusted_load = base_load + count_penalty + context_penalty
        fatigue_load_factor = 1.0 + (0.2 * cognitive_fatigue)
        effective_load = base_adjusted_load * fatigue_load_factor
        
        effective_cap = cap * (1.0 - 0.1 * cognitive_fatigue)
        
        level = "SAFE"
        if effective_load > effective_cap: level = "CRITICAL"
        elif effective_load >= effective_cap * 0.8: level = "DANGER"
        elif effective_load >= effective_cap * 0.6: level = "WARNING"
        
        return {
            "date": target_date,
            "base_load": round(base_load, 2),
            "task_count": task_count,
            "unique_contexts": unique_contexts,
            "adjusted_load": round(effective_load, 2), # Return effective load as adjusted_load for UI consistency
            "raw_adjusted_load": round(base_adjusted_load, 2),
            "count_penalty": round(count_penalty, 2),
            "context_penalty": round(context_penalty, 2),
            "level": level,
            "cap": round(effective_cap, 2),
            "base_cap": cap,
            "cognitive_fatigue": cognitive_fatigue,
            "tasks": self._build_task_list(day_entries, task_map, target_date, exceptions)
        }

    def _build_task_list(self, day_entries, task_map, target_date, exceptions=None):
        """Build task list with exception time overrides applied"""
        result = []
        for e in day_entries:
            task = task_map.get(e.task_id)
            if not task:
                continue
            
            # Get base times from task
            start_time = task.start_time
            end_time = task.end_time
            has_exception = False
            exception_type = None
            
            # Apply exceptions if present
            is_locked = task.is_locked
            if exceptions:
                exception = exceptions.get((e.task_id, target_date))
                if exception:
                    has_exception = True
                    exception_type = exception.exception_type
                    is_locked = exception.is_locked # Exception lock overrides Task lock
                    if exception.start_time:
                        start_time = exception.start_time
                    if exception.end_time:
                        end_time = exception.end_time
            
            result.append({
                "task_id": e.task_id,
                "task_name": task.task_name,
                "context": task.context,
                "load": e.calculated_load,
                "status": e.status,
                "start_time": start_time,
                "end_time": end_time,
                "has_exception": has_exception,
                "exception_type": exception_type,
                "is_locked": is_locked
            })
        return result

    def _calculate_overflow_flags(self, user_id: str, start_date: date, end_date: date, cache_entries: List[LBSDailyCache], tasks: List[Task], conditions: Dict[date, int] = None) -> None:
        cap = self.config["CAP"]
        current = start_date
        while current <= end_date:
            fatigue = conditions.get(current, 0) if conditions else 0
            # Overflow calculation considers all scheduled tasks (including SKIPPED) 
            # to reflect total planned pressure vs capacity.
            statuses = [TaskStatus.TODO, TaskStatus.DONE, TaskStatus.SKIPPED]
            load_data = self.calculate_daily_load(current, cache_entries, tasks, filter_statuses=statuses, cognitive_fatigue=fatigue)
            is_overflow = load_data["adjusted_load"] > load_data["cap"]
            # Update all entries for this date in the list
            for e in cache_entries:
                if e.target_date == current:
                    e.is_overflow = is_overflow
            current += timedelta(days=1)

    def get_weekly_stats(self, start_date: date, cache_entries: List[LBSDailyCache], tasks: List[Task], filter_statuses: Optional[List[TaskStatus]] = None, conditions: Dict[date, int] = None) -> Dict:
        daily_loads = []
        for i in range(7):
            day = start_date + timedelta(days=i)
            fatigue = conditions.get(day, 0) if conditions else 0
            daily_loads.append(self.calculate_daily_load(day, cache_entries, tasks, filter_statuses=filter_statuses, cognitive_fatigue=fatigue)["adjusted_load"])
        
        avg = sum(daily_loads) / 7
        recovery_days = sum(1 for l in daily_loads if l < 4.0)
        return {
            "average_load": round(avg, 2),
            "recovery_rate": round((recovery_days / 7) * 100, 1)
        }

    def get_trend_data(self, weeks: int, start_date: date, end_date: date, cache_entries: List[LBSDailyCache], tasks: List[Task], filter_statuses: Optional[List[TaskStatus]] = None, conditions: Dict[date, int] = None) -> List[Dict]:
        trends = []
        current_week_start = start_date
        
        while current_week_start <= end_date:
            week_end = current_week_start + timedelta(days=6)
            week_loads = []
            
            curr = current_week_start
            while curr <= week_end and curr <= end_date:
                fatigue = conditions.get(curr, 0) if conditions else 0
                daily = self.calculate_daily_load(curr, cache_entries, tasks, filter_statuses=filter_statuses, cognitive_fatigue=fatigue)
                week_loads.append(daily["adjusted_load"])
                curr += timedelta(days=1)
                
            if week_loads:
                trends.append({
                    "date": str(current_week_start),
                    "average_load": round(sum(week_loads) / len(week_loads), 2),
                    "max_load": round(max(week_loads), 2),
                    "min_load": round(min(week_loads), 2)
                })
            current_week_start += timedelta(days=7)
            
        return trends

    def get_context_distribution(self, start: date, end: date, cache_entries: List[LBSDailyCache], tasks: List[Task], filter_statuses: Optional[List[TaskStatus]] = None) -> List[Dict]:
        distribution = {}
        task_map = {t.task_id: t for t in tasks}
        
        if filter_statuses is None:
            filter_statuses = [TaskStatus.TODO, TaskStatus.DONE]
            
        curr = start
        while curr <= end:
            day_entries = [e for e in cache_entries if e.target_date == curr and e.status in filter_statuses]
            
            if day_entries:
                date_str = str(curr)
                distribution[date_str] = {"date": date_str, "total_load": 0, "contexts": []}
                
                context_map = {}
                for entry in day_entries:
                    task = task_map.get(entry.task_id)
                    context = task.context if task else "unassigned"
                    context_map[context] = context_map.get(context, 0) + entry.calculated_load
                
                for ctx, load in context_map.items():
                    distribution[date_str]["contexts"].append({"context": ctx, "load": round(load, 2)})
                    distribution[date_str]["total_load"] += load
                
                distribution[date_str]["total_load"] = round(distribution[date_str]["total_load"], 2)
            
            curr += timedelta(days=1)
            
        return list(distribution.values())
