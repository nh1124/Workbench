import {
  addUtcDays,
  LBSEngine,
  makeExceptionMap,
  occurrenceKey
} from "./engine.js";
import type {
  ConditionMap,
  DailyLoadResult,
  DateKey,
  ExceptionMap,
  ExecutionMap,
  LBSConfig,
  LBSDailyCache,
  LBSFixtureInput,
  LBSTask,
  TaskException,
  TaskExecution,
  TaskStatus
} from "./types.js";

const ALL_STATUSES: readonly TaskStatus[] = ["todo", "done", "skipped"];

export const PYTHON_FIXTURE_TASK_ORDER = [
  "T-ONCE-001",
  "T-WEEK-MWF",
  "T-WEEK-WEEKEND",
  "T-WEEK-TUTH",
  "T-WEEK-NONE",
  "T-EVERY-003",
  "T-MONTH-31",
  "T-NTH-LAST-SUN",
  "T-NTH-SECOND-TUE",
  "T-INACTIVE-ONCE"
] as const;

export function configFromRows(fixture: LBSFixtureInput): LBSConfig {
  const values = new Map(fixture.system_config.map((row) => [row.key, Number(row.value)]));
  const required = (key: keyof LBSConfig): number => {
    const value = values.get(key);
    if (value === undefined || !Number.isFinite(value)) {
      throw new Error(`Missing or invalid LBS config: ${key}`);
    }
    return value;
  };
  return {
    ALPHA: required("ALPHA"),
    BETA: required("BETA"),
    SWITCH_COST: required("SWITCH_COST"),
    CAP: required("CAP")
  };
}

export function orderTasks(
  tasks: readonly LBSTask[],
  taskOrder: readonly string[] = PYTHON_FIXTURE_TASK_ORDER
): LBSTask[] {
  const rank = new Map(taskOrder.map((taskId, index) => [taskId, index]));
  return [...tasks].sort((left, right) =>
    (rank.get(left.task_id) ?? Number.MAX_SAFE_INTEGER)
    - (rank.get(right.task_id) ?? Number.MAX_SAFE_INTEGER)
  );
}

function executionMap(executions: readonly TaskExecution[]): ExecutionMap {
  return new Map(executions.map((execution) => [
    occurrenceKey(execution.task_id, execution.target_date),
    execution
  ]));
}

function conditionMap(fixture: LBSFixtureInput): ConditionMap {
  return new Map(fixture.daily_conditions.map((condition) => [
    condition.target_date,
    condition.cognitive_fatigue
  ]));
}

function shapeTask(task: LBSTask): Record<string, unknown> {
  const {
    user_id: _userId,
    created_at: _createdAt,
    updated_at: _updatedAt,
    ...response
  } = task;
  return response;
}

function shapeScheduleTask(
  task: DailyLoadResult["tasks"][number]
): Record<string, unknown> {
  return {
    ...task,
    // ScheduleTask's Pydantic default supplies UTC because manager.py omits this key.
    timezone: "UTC"
  };
}

export class LBSResponseShapes {
  readonly engine: LBSEngine;
  readonly tasks: readonly LBSTask[];
  readonly activeTasks: readonly LBSTask[];
  readonly exceptions: ExceptionMap;
  readonly executions: ExecutionMap;
  readonly conditions: ConditionMap;

  constructor(readonly fixture: LBSFixtureInput, taskOrder = PYTHON_FIXTURE_TASK_ORDER) {
    this.tasks = orderTasks(fixture.tasks, taskOrder);
    this.activeTasks = this.tasks.filter((task) => task.active);
    this.exceptions = makeExceptionMap(fixture.task_exceptions);
    this.executions = executionMap(fixture.task_executions);
    this.conditions = conditionMap(fixture);
    this.engine = new LBSEngine(configFromRows(fixture));
  }

  listTasks(active?: boolean): Array<Record<string, unknown>> {
    return this.tasks
      .filter((task) => active === undefined || task.active === active)
      .map(shapeTask);
  }

  getTask(taskId: string): Record<string, unknown> | undefined {
    const task = this.tasks.find((candidate) => candidate.task_id === taskId);
    return task ? shapeTask(task) : undefined;
  }

  listExceptions(start?: DateKey, end?: DateKey): TaskException[] {
    return this.fixture.task_exceptions
      .filter((exception) => (!start || exception.target_date >= start) && (!end || exception.target_date <= end))
      .sort((left, right) => left.target_date.localeCompare(right.target_date));
  }

  getHistory(taskId: string, start: DateKey, end: DateKey): Array<Pick<TaskExecution, "target_date" | "status">> {
    return this.fixture.task_executions
      .filter((execution) =>
        execution.task_id === taskId
        && execution.target_date >= start
        && execution.target_date <= end
      )
      .sort((left, right) => left.target_date.localeCompare(right.target_date))
      .map(({ target_date, status }) => ({ target_date, status }));
  }

  private scheduleCache(start: DateKey, end: DateKey): LBSDailyCache[] {
    return this.engine.calculateSchedule(
      this.fixture.reference_user_id,
      start,
      end,
      this.activeTasks,
      this.executions,
      this.exceptions,
      this.conditions
    );
  }

  schedule(start: DateKey, end: DateKey): Array<Record<string, unknown>> {
    const cache = this.scheduleCache(start, end);
    const dates = [...new Set(cache.map((entry) => entry.target_date))].sort();
    return dates.map((date) => {
      const load = this.engine.calculateDailyLoad(
        date,
        cache,
        this.activeTasks,
        undefined,
        this.conditions.get(date) ?? 0,
        this.exceptions
      );
      return {
        date,
        total_load: load.adjusted_load,
        tasks: load.tasks.map(shapeScheduleTask)
      };
    });
  }

  calculate(targetDate: DateKey, statuses?: readonly TaskStatus[]): DailyLoadResult {
    const cache = this.scheduleCache(targetDate, targetDate);
    return this.engine.calculateDailyLoad(
      targetDate,
      cache,
      this.activeTasks,
      statuses,
      this.conditions.get(targetDate) ?? 0
    );
  }

  dashboard(startDate: DateKey, todayDate = this.fixture.ref_today): Record<string, unknown> {
    const endDate = addUtcDays(startDate, 6);
    const cache = this.scheduleCache(startDate, endDate);
    const dailyBreakdown = Array.from({ length: 7 }, (_, index) => {
      const date = addUtcDays(startDate, index);
      return this.engine.calculateDailyLoad(
        date,
        cache,
        this.activeTasks,
        ALL_STATUSES,
        this.conditions.get(date) ?? 0
      );
    });
    return {
      today: this.engine.calculateDailyLoad(
        todayDate,
        cache,
        this.activeTasks,
        ALL_STATUSES,
        this.conditions.get(todayDate) ?? 0
      ),
      weekly: this.engine.getWeeklyStats(
        startDate,
        cache,
        this.activeTasks,
        ALL_STATUSES,
        this.conditions
      ),
      daily_breakdown: dailyBreakdown,
      config: this.engine.config
    };
  }

  heatmap(start: DateKey, end: DateKey, statuses: readonly TaskStatus[]): Array<Record<string, unknown>> {
    const cache = this.scheduleCache(start, end);
    const result: Array<Record<string, unknown>> = [];
    for (let date = start; date <= end; date = addUtcDays(date, 1)) {
      const fatigue = this.conditions.get(date) ?? 0;
      const load = this.engine.calculateDailyLoad(date, cache, this.activeTasks, statuses, fatigue);
      result.push({
        date,
        adjusted_load: load.adjusted_load,
        level: load.level,
        task_count: load.task_count,
        cap: load.cap,
        cognitive_fatigue: fatigue
      });
    }
    return result;
  }

  trends(weeks: number, startDate: DateKey, statuses: readonly TaskStatus[]): Record<string, unknown> {
    const endDate = addUtcDays(startDate, weeks * 7);
    const cache = this.scheduleCache(startDate, endDate);
    return {
      trends: this.engine.getTrendData(
        weeks,
        startDate,
        endDate,
        cache,
        this.activeTasks,
        statuses,
        this.conditions
      )
    };
  }

  contextDistribution(
    start: DateKey,
    end: DateKey,
    statuses: readonly TaskStatus[]
  ): Record<string, unknown> {
    const cache = this.scheduleCache(start, end);
    return {
      distribution: this.engine.getContextDistribution(start, end, cache, this.activeTasks, statuses)
    };
  }

  resolvedTask(taskId: string, targetDate: DateKey): Record<string, unknown> | undefined {
    const task = this.tasks.find((candidate) => candidate.task_id === taskId);
    if (!task) {
      return undefined;
    }
    const exception = this.exceptions.get(occurrenceKey(taskId, targetDate));
    const cache = task.active ? this.scheduleCache(targetDate, targetDate) : [];
    const entry = cache.find((candidate) => candidate.task_id === taskId);
    return {
      task_id: task.task_id,
      task_name: task.task_name,
      context: task.context,
      base_load_score: task.base_load_score,
      active: task.active,
      rule_type: task.rule_type,
      is_locked: exception ? exception.is_locked : task.is_locked,
      target_date: targetDate,
      start_time: exception?.start_time || task.start_time,
      end_time: exception?.end_time || task.end_time,
      load: entry?.calculated_load ?? task.base_load_score,
      status: entry?.status ?? null,
      has_exception: Boolean(exception),
      exception: exception ? {
        id: exception.id,
        exception_type: exception.exception_type,
        override_load_value: exception.override_load_value,
        start_time: exception.start_time,
        end_time: exception.end_time,
        notes: exception.notes,
        is_locked: exception.is_locked
      } : null
    };
  }
}
