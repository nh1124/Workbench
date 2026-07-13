/**
 * taskRecurrenceUtils.ts
 * Pure recurrence-matching helpers for the Tasks domain.
 * No React, no API calls, no side-effects.
 */

import type { Task } from "../types/models";
import { DAY_MS, isSameDay, parseDateOnly, startOfDay } from "./taskDateUtils";

function engineWeekdayFromJs(weekday: number): number {
  return weekday === 0 ? 7 : weekday;
}

function weekdayMon0(date: Date): number {
  return (date.getDay() + 6) % 7;
}

function daysInMonth(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

/** Returns true if `date` falls within the task's active period. */
export function taskWithinActivePeriod(task: Task, date: Date): boolean {
  if (task.recurrence === "ONCE") return true;
  if (task.active === false) return false;
  const from = parseDateOnly(task.activeFrom);
  const until = parseDateOnly(task.activeUntil);
  if (from && date < from) return false;
  if (until && date > until) return false;
  return true;
}

/** Returns true if the task has a recurrence occurrence on `date`. */
export function taskOccursOnDate(task: Task, date: Date): boolean {
  const day = startOfDay(date);

  if (task.recurrence === "ONCE") {
    const due = parseDateOnly(task.dueDate);
    return !!due && isSameDay(due, day);
  }

  if (!taskWithinActivePeriod(task, day)) return false;

  if (task.recurrence === "WEEKLY") {
    const selectedDays = [
      task.sun, task.mon, task.tue, task.wed, task.thu, task.fri, task.sat
    ].map(Boolean);
    if (selectedDays.some(Boolean)) return selectedDays[day.getDay()];
    const fallback =
      parseDateOnly(task.activeFrom) || parseDateOnly(task.dueDate);
    return fallback ? fallback.getDay() === day.getDay() : false;
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
    return day.getDate() === Math.min(dayOfMonth, daysInMonth(day));
  }

  if (task.recurrence === "MONTHLY_NTH_WEEKDAY") {
    const nthInMonth = task.nthInMonth === -1
      ? -1
      : Math.min(5, Math.max(1, task.nthInMonth ?? 1));
    const jsWeekday = Math.min(6, Math.max(0, task.weekdayMon1 ?? 0));
    const engineWeekday = engineWeekdayFromJs(jsWeekday) - 1;
    if (weekdayMon0(day) !== engineWeekday) return false;
    if (nthInMonth === -1) {
      const nextOccurrence = new Date(day);
      nextOccurrence.setDate(nextOccurrence.getDate() + 7);
      return nextOccurrence.getMonth() !== day.getMonth();
    }
    const weekIndex = Math.floor((day.getDate() - 1) / 7) + 1;
    return weekIndex === nthInMonth;
  }

  return false;
}
