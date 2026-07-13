import type {
  ConditionMap,
  ContextDistributionRow,
  DailyLoadResult,
  DateKey,
  ExceptionMap,
  ExecutionMap,
  LBSConfig,
  LBSDailyCache,
  LBSTask,
  TaskException,
  TaskStatus,
  TrendRow,
  WeeklyStats
} from "./types.js";

const DAY_MS = 86_400_000;
const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DEFAULT_STATUSES: readonly TaskStatus[] = ["todo", "done"];
const OVERFLOW_STATUSES: readonly TaskStatus[] = ["todo", "done", "skipped"];

function dateParts(value: DateKey): [number, number, number] {
  const match = DATE_KEY.exec(value);
  if (!match) {
    throw new Error(`Invalid date key: ${value}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function utcEpoch(value: DateKey): number {
  const [year, month, day] = dateParts(value);
  const epoch = Date.UTC(year, month - 1, day);
  const roundTrip = new Date(epoch).toISOString().slice(0, 10);
  if (roundTrip !== value) {
    throw new Error(`Invalid calendar date: ${value}`);
  }
  return epoch;
}

export function addUtcDays(value: DateKey, days: number): DateKey {
  return new Date(utcEpoch(value) + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetweenUtc(start: DateKey, end: DateKey): number {
  return Math.trunc((utcEpoch(end) - utcEpoch(start)) / DAY_MS);
}

export function weekdayMon0(value: DateKey): number {
  return (new Date(utcEpoch(value)).getUTCDay() + 6) % 7;
}

function daysInMonth(value: DateKey): number {
  const [year, month] = dateParts(value);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function inRange(value: DateKey, start: DateKey, end: DateKey): boolean {
  return value >= start && value <= end;
}

export function occurrenceKey(taskId: string, targetDate: DateKey): string {
  return `${taskId}\u0000${targetDate}`;
}

export function makeExceptionMap(exceptions: readonly TaskException[]): Map<string, TaskException> {
  return new Map(exceptions.map((exception) => [
    occurrenceKey(exception.task_id, exception.target_date),
    exception
  ]));
}

/** Python-style round-half-to-even over the exact IEEE-754 binary value. */
export function pythonRound(value: number, digits = 0): number {
  if (!Number.isFinite(value)) {
    return value;
  }
  if (!Number.isInteger(digits) || digits < 0) {
    throw new Error(`pythonRound only supports non-negative integer digits, received ${digits}`);
  }
  if (value === 0) {
    return value;
  }

  const absolute = Math.abs(value);
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, absolute, false);
  const high = view.getUint32(0, false);
  const low = view.getUint32(4, false);
  const exponentBits = (high >>> 20) & 0x7ff;
  const fractionBits = (BigInt(high & 0xfffff) << 32n) | BigInt(low);
  const mantissa = exponentBits === 0
    ? fractionBits
    : (1n << 52n) | fractionBits;
  const binaryExponent = exponentBits === 0
    ? -1074
    : exponentBits - 1023 - 52;

  // value * 10^digits = mantissa * 5^digits * 2^(binaryExponent + digits)
  let numerator = mantissa * (5n ** BigInt(digits));
  const scaledExponent = binaryExponent + digits;
  let roundedInteger: bigint;
  if (scaledExponent >= 0) {
    roundedInteger = numerator << BigInt(scaledExponent);
  } else {
    const denominator = 1n << BigInt(-scaledExponent);
    const quotient = numerator / denominator;
    const remainder = numerator % denominator;
    const doubledRemainder = remainder * 2n;
    roundedInteger = doubledRemainder > denominator
      || (doubledRemainder === denominator && quotient % 2n !== 0n)
      ? quotient + 1n
      : quotient;
  }
  const result = Number(roundedInteger) / (10 ** digits);
  return value < 0 ? -result : result;
}

export function shouldTaskOccur(task: LBSTask, targetDate: DateKey): boolean {
  if (task.start_date && targetDate < task.start_date) {
    return false;
  }
  if (task.end_date && targetDate > task.end_date) {
    return false;
  }

  switch (task.rule_type) {
    case "WEEKLY": {
      const flags = [task.mon, task.tue, task.wed, task.thu, task.fri, task.sat, task.sun];
      return flags[weekdayMon0(targetDate)] ?? false;
    }
    case "EVERY_N_DAYS": {
      if (!task.anchor_date || !task.interval_days) {
        return false;
      }
      const diff = daysBetweenUtc(task.anchor_date, targetDate);
      return diff >= 0 && diff % task.interval_days === 0;
    }
    case "MONTHLY_DAY":
      if (!task.month_day) {
        return false;
      }
      return dateParts(targetDate)[2] === Math.min(task.month_day, daysInMonth(targetDate));
    case "MONTHLY_NTH_WEEKDAY": {
      if (
        !task.nth_in_month
        || !task.weekday_mon1
        || task.weekday_mon1 < 1
        || task.weekday_mon1 > 7
      ) {
        return false;
      }
      const targetWeekday = (task.weekday_mon1 - 1) % 7;
      if (weekdayMon0(targetDate) !== targetWeekday) {
        return false;
      }
      if (task.nth_in_month === -1) {
        return dateParts(addUtcDays(targetDate, 7))[1] !== dateParts(targetDate)[1];
      }
      const occurrence = Math.floor((dateParts(targetDate)[2] - 1) / 7) + 1;
      return occurrence === task.nth_in_month;
    }
    case "ONCE":
      return false;
  }
}

export class LBSEngine {
  readonly config: Readonly<LBSConfig>;

  constructor(config: LBSConfig) {
    this.config = { ...config };
  }

  calculateSchedule(
    userId: string,
    startDate: DateKey,
    endDate: DateKey,
    tasks: readonly LBSTask[],
    executions: ExecutionMap,
    exceptions: ExceptionMap,
    conditions?: ConditionMap
  ): LBSDailyCache[] {
    const cacheEntries: LBSDailyCache[] = [];

    for (const task of tasks) {
      if (task.rule_type === "ONCE") {
        if (task.due_date && inRange(task.due_date, startDate, endDate)) {
          this.processDay(userId, task, task.due_date, exceptions, executions, cacheEntries);
        }
        for (const exception of exceptions.values()) {
          if (
            exception.task_id === task.task_id
            && (exception.exception_type === "FORCE_DO" || exception.exception_type === "MANUAL_LOCK")
            && exception.target_date !== task.due_date
            && inRange(exception.target_date, startDate, endDate)
          ) {
            this.processDay(userId, task, exception.target_date, exceptions, executions, cacheEntries);
          }
        }
        continue;
      }

      for (let current = startDate; current <= endDate; current = addUtcDays(current, 1)) {
        const occurs = shouldTaskOccur(task, current);
        const exception = exceptions.get(occurrenceKey(task.task_id, current));
        if (occurs) {
          if (exception?.exception_type !== "SKIP") {
            this.processDay(userId, task, current, exceptions, executions, cacheEntries);
          }
        } else if (exception?.exception_type === "FORCE_DO" || exception?.exception_type === "MANUAL_LOCK") {
          this.processDay(userId, task, current, exceptions, executions, cacheEntries);
        }
      }
    }

    this.calculateOverflowFlags(startDate, endDate, cacheEntries, tasks, conditions);
    return cacheEntries;
  }

  private processDay(
    userId: string,
    task: LBSTask,
    targetDate: DateKey,
    exceptions: ExceptionMap,
    executions: ExecutionMap,
    cacheEntries: LBSDailyCache[]
  ): void {
    const exception = exceptions.get(occurrenceKey(task.task_id, targetDate));
    let load = task.base_load_score;
    if (
      exception
      && (exception.exception_type === "OVERRIDE_LOAD" || exception.exception_type === "MANUAL_LOCK")
      && exception.override_load_value !== null
    ) {
      load = exception.override_load_value;
    } else if (
      exception?.exception_type === "FORCE_DO"
      && exception.override_load_value !== null
    ) {
      load = exception.override_load_value;
    }
    const execution = executions.get(occurrenceKey(task.task_id, targetDate));
    cacheEntries.push({
      user_id: userId,
      target_date: targetDate,
      task_id: task.task_id,
      calculated_load: load,
      status: execution?.status ?? "todo",
      is_overflow: false
    });
  }

  calculateDailyLoad(
    targetDate: DateKey,
    cacheEntries: readonly LBSDailyCache[],
    tasks: readonly LBSTask[],
    filterStatuses: readonly TaskStatus[] = DEFAULT_STATUSES,
    cognitiveFatigue = 0,
    exceptions?: ExceptionMap
  ): DailyLoadResult {
    const dayEntries = cacheEntries.filter((entry) =>
      entry.target_date === targetDate && filterStatuses.includes(entry.status)
    );
    const effectiveCap = this.config.CAP * (1 - 0.1 * cognitiveFatigue);

    if (dayEntries.length === 0) {
      return {
        date: targetDate,
        base_load: 0,
        task_count: 0,
        unique_contexts: 0,
        adjusted_load: 0,
        count_penalty: 0,
        context_penalty: 0,
        level: "SAFE",
        cap: pythonRound(effectiveCap, 2),
        base_cap: this.config.CAP,
        cognitive_fatigue: cognitiveFatigue,
        tasks: []
      };
    }

    const taskMap = new Map(tasks.map((task) => [task.task_id, task]));
    const baseLoad = dayEntries.reduce((sum, entry) => sum + entry.calculated_load, 0);
    const contexts = new Set<string>();
    for (const entry of dayEntries) {
      const task = taskMap.get(entry.task_id);
      if (task) {
        contexts.add(task.context);
      }
    }
    const taskCount = dayEntries.length;
    const countPenalty = this.config.ALPHA * taskCount ** this.config.BETA;
    const contextPenalty = this.config.SWITCH_COST * Math.max(contexts.size - 1, 0);
    const rawAdjustedLoad = baseLoad + countPenalty + contextPenalty;
    const effectiveLoad = rawAdjustedLoad * (1 + 0.2 * cognitiveFatigue);
    const level = effectiveLoad > effectiveCap
      ? "CRITICAL"
      : effectiveLoad >= effectiveCap * 0.8
        ? "DANGER"
        : effectiveLoad >= effectiveCap * 0.6
          ? "WARNING"
          : "SAFE";

    return {
      date: targetDate,
      base_load: pythonRound(baseLoad, 2),
      task_count: taskCount,
      unique_contexts: contexts.size,
      adjusted_load: pythonRound(effectiveLoad, 2),
      raw_adjusted_load: pythonRound(rawAdjustedLoad, 2),
      count_penalty: pythonRound(countPenalty, 2),
      context_penalty: pythonRound(contextPenalty, 2),
      level,
      cap: pythonRound(effectiveCap, 2),
      base_cap: this.config.CAP,
      cognitive_fatigue: cognitiveFatigue,
      tasks: dayEntries.flatMap((entry) => {
        const task = taskMap.get(entry.task_id);
        if (!task) {
          return [];
        }
        const exception = exceptions?.get(occurrenceKey(entry.task_id, targetDate));
        return [{
          task_id: entry.task_id,
          task_name: task.task_name,
          context: task.context,
          load: entry.calculated_load,
          status: entry.status,
          start_time: exception?.start_time || task.start_time,
          end_time: exception?.end_time || task.end_time,
          has_exception: Boolean(exception),
          exception_type: exception?.exception_type ?? null,
          is_locked: exception ? exception.is_locked : task.is_locked
        }];
      })
    };
  }

  calculateOverflowFlags(
    startDate: DateKey,
    endDate: DateKey,
    cacheEntries: LBSDailyCache[],
    tasks: readonly LBSTask[],
    conditions?: ConditionMap
  ): void {
    for (let current = startDate; current <= endDate; current = addUtcDays(current, 1)) {
      const fatigue = conditions?.get(current) ?? 0;
      const load = this.calculateDailyLoad(
        current,
        cacheEntries,
        tasks,
        OVERFLOW_STATUSES,
        fatigue
      );
      const overflow = load.adjusted_load > load.cap;
      for (const entry of cacheEntries) {
        if (entry.target_date === current) {
          entry.is_overflow = overflow;
        }
      }
    }
  }

  getWeeklyStats(
    startDate: DateKey,
    cacheEntries: readonly LBSDailyCache[],
    tasks: readonly LBSTask[],
    filterStatuses: readonly TaskStatus[] = DEFAULT_STATUSES,
    conditions?: ConditionMap
  ): WeeklyStats {
    const dailyLoads = Array.from({ length: 7 }, (_, index) => {
      const day = addUtcDays(startDate, index);
      return this.calculateDailyLoad(
        day,
        cacheEntries,
        tasks,
        filterStatuses,
        conditions?.get(day) ?? 0
      ).adjusted_load;
    });
    const recoveryDays = dailyLoads.filter((load) => load < 4).length;
    return {
      average_load: pythonRound(dailyLoads.reduce((sum, load) => sum + load, 0) / 7, 2),
      recovery_rate: pythonRound((recoveryDays / 7) * 100, 1)
    };
  }

  getTrendData(
    _weeks: number,
    startDate: DateKey,
    endDate: DateKey,
    cacheEntries: readonly LBSDailyCache[],
    tasks: readonly LBSTask[],
    filterStatuses: readonly TaskStatus[] = DEFAULT_STATUSES,
    conditions?: ConditionMap
  ): TrendRow[] {
    const trends: TrendRow[] = [];
    for (let weekStart = startDate; weekStart <= endDate; weekStart = addUtcDays(weekStart, 7)) {
      const weekLoads: number[] = [];
      const weekEnd = addUtcDays(weekStart, 6);
      for (let current = weekStart; current <= weekEnd && current <= endDate; current = addUtcDays(current, 1)) {
        weekLoads.push(this.calculateDailyLoad(
          current,
          cacheEntries,
          tasks,
          filterStatuses,
          conditions?.get(current) ?? 0
        ).adjusted_load);
      }
      if (weekLoads.length > 0) {
        trends.push({
          date: weekStart,
          average_load: pythonRound(weekLoads.reduce((sum, load) => sum + load, 0) / weekLoads.length, 2),
          max_load: pythonRound(Math.max(...weekLoads), 2),
          min_load: pythonRound(Math.min(...weekLoads), 2)
        });
      }
    }
    return trends;
  }

  getContextDistribution(
    startDate: DateKey,
    endDate: DateKey,
    cacheEntries: readonly LBSDailyCache[],
    tasks: readonly LBSTask[],
    filterStatuses: readonly TaskStatus[] = DEFAULT_STATUSES
  ): ContextDistributionRow[] {
    const taskMap = new Map(tasks.map((task) => [task.task_id, task]));
    const result: ContextDistributionRow[] = [];
    for (let current = startDate; current <= endDate; current = addUtcDays(current, 1)) {
      const entries = cacheEntries.filter((entry) =>
        entry.target_date === current && filterStatuses.includes(entry.status)
      );
      if (entries.length === 0) {
        continue;
      }
      const contextLoads = new Map<string, number>();
      for (const entry of entries) {
        const context = taskMap.get(entry.task_id)?.context ?? "unassigned";
        contextLoads.set(context, (contextLoads.get(context) ?? 0) + entry.calculated_load);
      }
      result.push({
        date: current,
        total_load: pythonRound([...contextLoads.values()].reduce((sum, load) => sum + load, 0), 2),
        contexts: [...contextLoads].map(([context, load]) => ({
          context,
          load: pythonRound(load, 2)
        }))
      });
    }
    return result;
  }
}
