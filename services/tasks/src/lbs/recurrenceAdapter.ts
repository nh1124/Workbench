import type { Task } from "../types.js";
import { addUtcDays, shouldTaskOccur } from "./engine.js";
import type { DateKey, LBSTask } from "./types.js";

const DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;

function dateKeyFromValue(value?: string): DateKey | null {
  if (!value) return null;
  const match = DATE_PREFIX.exec(value);
  if (!match) return null;
  const dateKey = `${match[1]}-${match[2]}-${match[3]}`;
  const epoch = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(epoch).toISOString().slice(0, 10) === dateKey ? dateKey : null;
}

function engineWeekdayFromJs(weekday: number): number {
  return weekday === 0 ? 7 : weekday;
}

function toEngineTask(task: Task): LBSTask {
  let mon = Boolean(task.mon);
  let tue = Boolean(task.tue);
  let wed = Boolean(task.wed);
  let thu = Boolean(task.thu);
  let fri = Boolean(task.fri);
  let sat = Boolean(task.sat);
  let sun = Boolean(task.sun);

  if (task.recurrence === "WEEKLY" && ![mon, tue, wed, thu, fri, sat, sun].some(Boolean)) {
    const fallback = dateKeyFromValue(task.activeFrom) ?? dateKeyFromValue(task.dueDate);
    if (fallback) {
      [mon, tue, wed, thu, fri, sat, sun] = Array.from(
        { length: 7 },
        (_, index) => index === (new Date(`${fallback}T00:00:00Z`).getUTCDay() + 6) % 7
      );
    }
  }

  const nthInMonth = task.nthInMonth === -1
    ? -1
    : Math.min(5, Math.max(1, task.nthInMonth ?? 1));
  const jsWeekday = Math.min(6, Math.max(0, task.weekdayMon1 ?? 0));

  return {
    task_id: task.id,
    user_id: "",
    task_name: task.title,
    context: task.context,
    base_load_score: task.baseLoadScore,
    active: task.active,
    rule_type: task.recurrence,
    due_date: dateKeyFromValue(task.dueDate),
    mon,
    tue,
    wed,
    thu,
    fri,
    sat,
    sun,
    interval_days: Math.max(1, task.intervalDays ?? 1),
    anchor_date:
      dateKeyFromValue(task.anchorDate)
      ?? dateKeyFromValue(task.activeFrom)
      ?? dateKeyFromValue(task.createdAt),
    month_day: Math.min(31, Math.max(1, task.monthDay ?? 1)),
    nth_in_month: nthInMonth,
    weekday_mon1: engineWeekdayFromJs(jsWeekday),
    start_date: dateKeyFromValue(task.activeFrom),
    end_date: dateKeyFromValue(task.activeUntil),
    start_time: task.startTime ?? null,
    end_time: task.endTime ?? null,
    notes: task.notes,
    external_sync_id: null,
    timezone: task.timezone ?? null,
    is_locked: task.isLocked,
    created_at: task.createdAt,
    updated_at: task.updatedAt
  };
}

export function listDateKeys(startDate: string, endDate: string): string[] {
  const start = dateKeyFromValue(startDate);
  const end = dateKeyFromValue(endDate);
  if (!start || !end || start > end) return [];

  const keys: string[] = [];
  for (let cursor = start; cursor <= end; cursor = addUtcDays(cursor, 1)) {
    keys.push(cursor);
  }
  return keys;
}

export function taskOccursOnDateKey(task: Task, dateKey: string): boolean {
  const targetDate = dateKeyFromValue(dateKey);
  if (!targetDate || targetDate !== dateKey) return false;

  if (task.recurrence === "ONCE") {
    return dateKeyFromValue(task.dueDate) === targetDate;
  }
  if (task.active === false) return false;

  return shouldTaskOccur(toEngineTask(task), targetDate);
}
