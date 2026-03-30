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
