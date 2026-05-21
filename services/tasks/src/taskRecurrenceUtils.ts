import type { Task } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDateOnly(value?: string): Date | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!year || !month || !day) return undefined;
  return new Date(Date.UTC(year, month - 1, day));
}

function toDateKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function taskWithinActivePeriod(task: Task, date: Date): boolean {
  if (task.recurrence === "ONCE") return true;
  if (task.active === false) return false;
  const from = parseDateOnly(task.activeFrom);
  const until = parseDateOnly(task.activeUntil);
  if (from && date < from) return false;
  if (until && date > until) return false;
  return true;
}

export function listDateKeys(startDate: string, endDate: string): string[] {
  const start = parseDateOnly(startDate);
  const end = parseDateOnly(endDate);
  if (!start || !end || start > end) return [];

  const keys: string[] = [];
  for (let cursor = start; cursor <= end; cursor = new Date(cursor.getTime() + DAY_MS)) {
    keys.push(toDateKey(cursor));
  }
  return keys;
}

export function taskOccursOnDateKey(task: Task, dateKey: string): boolean {
  const day = parseDateOnly(dateKey);
  if (!day) return false;

  if (task.recurrence === "ONCE") {
    const due = parseDateOnly(task.dueDate);
    return !!due && toDateKey(due) === dateKey;
  }

  if (!taskWithinActivePeriod(task, day)) return false;

  if (task.recurrence === "WEEKLY") {
    const selectedDays = [
      task.sun, task.mon, task.tue, task.wed, task.thu, task.fri, task.sat
    ].map(Boolean);
    if (selectedDays.some(Boolean)) return selectedDays[day.getUTCDay()];
    const fallback = parseDateOnly(task.activeFrom) || parseDateOnly(task.dueDate);
    return fallback ? fallback.getUTCDay() === day.getUTCDay() : false;
  }

  if (task.recurrence === "EVERY_N_DAYS") {
    const interval = Math.max(1, task.intervalDays ?? 1);
    const anchor =
      parseDateOnly(task.anchorDate) ||
      parseDateOnly(task.activeFrom) ||
      parseDateOnly(task.createdAt);
    if (!anchor) return false;
    const diff = Math.floor((day.getTime() - anchor.getTime()) / DAY_MS);
    return diff >= 0 && diff % interval === 0;
  }

  if (task.recurrence === "MONTHLY_DAY") {
    const dayOfMonth = Math.min(31, Math.max(1, task.monthDay ?? 1));
    return day.getUTCDate() === dayOfMonth;
  }

  if (task.recurrence === "MONTHLY_NTH_WEEKDAY") {
    const nthInMonth = Math.min(5, Math.max(1, task.nthInMonth ?? 1));
    const weekday = Math.min(6, Math.max(0, task.weekdayMon1 ?? 0));
    const weekIndex = Math.floor((day.getUTCDate() - 1) / 7) + 1;
    return day.getUTCDay() === weekday && weekIndex === nthInMonth;
  }

  return false;
}
