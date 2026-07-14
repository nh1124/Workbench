/**
 * taskCalendarUtils.ts
 * Pure functions for building calendar and schedule display data.
 *
 * Extracted from TasksPageContainer useMemo blocks so they can be tested in
 * isolation without spinning up a React component.
 *
 * Dependency direction:
 *   tasks/lib/taskCalendarUtils → lib/taskRecurrenceUtils, lib/taskDateUtils, types/models
 */

import { toDateKey } from "../../lib/taskDateUtils";
import { taskOccursOnDate } from "../../lib/taskRecurrenceUtils";
import type { ScheduleCalendarItem, Task, TaskStatus } from "../../types/models";

export const INITIAL_MONTH_WINDOW_RADIUS = 6;
export const MONTH_WINDOW_BATCH_SIZE = 6;
export const MAX_RENDERED_MONTHS = 48;

export type MonthWindowDirection = "earlier" | "later";

export interface MonthWindowUpdate {
  months: Date[];
  addedMonthKeys: string[];
  droppedMonthKeys: string[];
}

export interface MonthWindowScrollState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  threshold?: number;
}

export function monthWindowDirectionForScroll({
  scrollTop,
  scrollHeight,
  clientHeight,
  threshold = 240,
}: MonthWindowScrollState): MonthWindowDirection | null {
  if (scrollTop < threshold) return "earlier";
  const remaining = scrollHeight - scrollTop - clientHeight;
  if (remaining < threshold) return "later";
  return null;
}

export function calendarMonthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function normalizedMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function shiftedMonth(date: Date, offset: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + offset, 1);
}

/** Build an inclusive month window around a center cursor. */
export function buildMonthWindow(
  center: Date,
  before = INITIAL_MONTH_WINDOW_RADIUS,
  after = INITIAL_MONTH_WINDOW_RADIUS
): Date[] {
  const normalizedCenter = normalizedMonth(center);
  const safeBefore = Math.max(0, Math.floor(before));
  const safeAfter = Math.max(0, Math.floor(after));
  return Array.from(
    { length: safeBefore + safeAfter + 1 },
    (_, index) => shiftedMonth(normalizedCenter, index - safeBefore)
  );
}

/**
 * Extend one edge of a chronological month window and cap its DOM size by
 * dropping months from the far edge. The returned added/dropped keys let the
 * caller preserve a visible scroll anchor after React commits the new window.
 */
export function extendMonthWindow(
  currentMonths: Date[],
  direction: MonthWindowDirection,
  batchSize = MONTH_WINDOW_BATCH_SIZE,
  maxMonths = MAX_RENDERED_MONTHS
): MonthWindowUpdate {
  if (currentMonths.length === 0) {
    const months = buildMonthWindow(new Date(), 0, 0);
    return { months, addedMonthKeys: months.map(calendarMonthKey), droppedMonthKeys: [] };
  }

  const normalized = currentMonths.map(normalizedMonth);
  const safeBatchSize = Math.max(1, Math.floor(batchSize));
  const safeMaxMonths = Math.max(1, Math.floor(maxMonths));
  const added = direction === "earlier"
    ? Array.from({ length: safeBatchSize }, (_, index) => shiftedMonth(normalized[0], index - safeBatchSize))
    : Array.from({ length: safeBatchSize }, (_, index) => shiftedMonth(normalized[normalized.length - 1], index + 1));
  const expanded = direction === "earlier" ? [...added, ...normalized] : [...normalized, ...added];
  const dropCount = Math.max(0, expanded.length - safeMaxMonths);
  const dropped = direction === "earlier"
    ? expanded.slice(expanded.length - dropCount)
    : expanded.slice(0, dropCount);
  const months = direction === "earlier"
    ? expanded.slice(0, expanded.length - dropCount)
    : expanded.slice(dropCount);

  return {
    months,
    addedMonthKeys: added.filter((month) => months.some((candidate) => calendarMonthKey(candidate) === calendarMonthKey(month))).map(calendarMonthKey),
    droppedMonthKeys: dropped.map(calendarMonthKey),
  };
}

// ── tasksByDate ────────────────────────────────────────────────────────────────

/**
 * Build a map of date-key → Task[] for each date in `visibleDates`.
 *
 * The date-key format is `"${year}-${month}-${day}"` (month is 0-indexed,
 * matching `Date.getMonth()`) — this matches the key used in the calendar
 * cell renderer.
 *
 * @param filteredTasks  Tasks already filtered/sorted for the active view.
 * @param visibleDates   Dates rendered in the current month/week grid.
 * @param calendarStatusMap  Optional per-date status overrides from the DB
 *                           (Maps dateKey → Map<taskId, TaskStatus>).
 */
export function buildTasksByDate(
  filteredTasks: Task[],
  visibleDates: Date[],
  calendarStatusMap: Map<string, Map<string, TaskStatus>>
): Map<string, Task[]> {
  const map = new Map<string, Task[]>();
  for (const date of visibleDates) {
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    const dateKey = toDateKey(date);
    const dateStatuses = calendarStatusMap.get(dateKey);
    const filtered = filteredTasks
      .filter((task) => taskOccursOnDate(task, date))
      .map((task) => {
        const status = dateStatuses?.get(task.id);
        return status !== undefined ? { ...task, status } : task;
      });
    map.set(key, filtered);
  }
  return map;
}

// ── Schedule item filtering ───────────────────────────────────────────────────

export interface ScheduleItemFilterOpts {
  /** "all" | "open" | "done" */
  calendarStatusFilter: string;
  /** If non-empty, keep only items whose context matches. */
  contextFilter: string;
}

/**
 * Filter a per-date schedule item map by status and context.
 * Returns the same map reference unchanged when no filters are active,
 * otherwise returns a new filtered map.
 */
export function filterScheduleItems(
  scheduleItemsByDate: Map<string, ScheduleCalendarItem[]>,
  opts: ScheduleItemFilterOpts
): Map<string, ScheduleCalendarItem[]> {
  const { calendarStatusFilter, contextFilter } = opts;
  if (!calendarStatusFilter && !contextFilter) return scheduleItemsByDate;

  const result = new Map<string, ScheduleCalendarItem[]>();
  for (const [date, items] of scheduleItemsByDate) {
    let filtered = items;
    if (calendarStatusFilter === "open")
      filtered = filtered.filter((i) => i.status !== "done" && i.status !== "skipped");
    if (calendarStatusFilter === "done")
      filtered = filtered.filter((i) => i.status === "done");
    if (contextFilter)
      filtered = filtered.filter((i) => i.context === contextFilter);
    if (filtered.length > 0 || scheduleItemsByDate.has(date)) result.set(date, filtered);
  }
  return result;
}
