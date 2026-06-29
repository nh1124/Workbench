/**
 * taskFilterUtils.ts
 * Pure functions for filtering and sorting task lists.
 *
 * All functions are free of side effects and React hooks — they take data in
 * and return data out, making them trivially unit-testable.
 *
 * Dependency direction:
 *   tasks/lib/taskFilterUtils → lib/taskRecurrenceUtils, tasks/types, types/models
 */

import type { Task } from "../../types/models";
import type {
  CalendarStatusFilter, QuickFilter, SidebarMode, SortMode
} from "../types";

// ── Task filter ───────────────────────────────────────────────────────────────

export interface FilterTasksOpts {
  sidebarMode: SidebarMode;
  calendarStatusFilter: CalendarStatusFilter;
  quickFilter: QuickFilter;
  todayMembershipKeys: Set<string>;
  todayTaskIds: Set<string>;
  today: Date;
}

function hasTodayMembershipForTask(todayMembershipKeys: Set<string>, taskId: string): boolean {
  const prefix = `occurrence:${encodeURIComponent(taskId)}:`;
  return Array.from(todayMembershipKeys).some((key) => key.startsWith(prefix));
}

/**
 * Apply view-mode filter to a task list.
 * Does NOT sort — call sortTasks() separately.
 */
export function filterTasksByMode(tasks: Task[], opts: FilterTasksOpts): Task[] {
  const {
    sidebarMode, calendarStatusFilter,
    quickFilter, todayMembershipKeys
  } = opts;

  if (sidebarMode === "calendar") {
    if (calendarStatusFilter === "open") return tasks.filter((t) => t.status === "todo");
    if (calendarStatusFilter === "done") return tasks.filter((t) => t.status === "done");
    return tasks;
  }

  // list / schedule mode
  if (quickFilter === "today") {
    return todayMembershipKeys.size > 0
      ? tasks.filter((t) => hasTodayMembershipForTask(todayMembershipKeys, t.id))
      : [];
  }
  if (quickFilter === "myday") {
    return tasks.filter((t) => t.isPinned === true);
  }
  return tasks;
}

// ── Task sort ─────────────────────────────────────────────────────────────────

const doneOrder = (t: Task) => (t.status === "done" ? 1 : 0);

/**
 * Sort a task list by the given sort mode.
 * Returns a new array — the input is not mutated.
 */
export function sortTasks(tasks: Task[], sortMode: SortMode): Task[] {
  const copy = tasks.slice();
  if (sortMode === "load") {
    return copy.sort((a, b) => {
      const d = doneOrder(a) - doneOrder(b);
      return d !== 0 ? d : b.baseLoadScore - a.baseLoadScore;
    });
  }
  if (sortMode === "due") {
    return copy.sort((a, b) => {
      const d = doneOrder(a) - doneOrder(b);
      if (d !== 0) return d;
      const dA = a.dueDate || "9999-12-31", dB = b.dueDate || "9999-12-31";
      if (dA !== dB) return dA.localeCompare(dB);
      return (a.startTime || "").localeCompare(b.startTime || "");
    });
  }
  if (sortMode === "project") {
    return copy.sort((a, b) => {
      const d = doneOrder(a) - doneOrder(b);
      if (d !== 0) return d;
      const pA = (a.contextName || a.context || "").toLowerCase();
      const pB = (b.contextName || b.context || "").toLowerCase();
      if (pA !== pB) return pA.localeCompare(pB);
      return (a.dueDate || "9999-12-31").localeCompare(b.dueDate || "9999-12-31");
    });
  }
  return copy;
}

/**
 * Combined filter + sort — convenience wrapper used in useMemo.
 */
export function filterAndSortTasks(
  tasks: Task[],
  opts: FilterTasksOpts & { sortMode: SortMode }
): Task[] {
  const { sortMode, ...filterOpts } = opts;
  const filtered = filterTasksByMode(tasks, filterOpts);
  return sortTasks(filtered, sortMode);
}

// ── Task counters ─────────────────────────────────────────────────────────────

export interface TaskCounterOpts {
  todayMembershipKeys: Set<string>;
  todayTaskIds: Set<string>;
  today: Date;
  plannedCount: number;
  overdueCount: number;
  inboxUpcomingCount: number;
}

export interface TaskCounters {
  today: number;
  myday: number;
  planned: number;
  overdue: number;
  inbox: number;
}

/**
 * Compute sidebar badge counters from the current task list.
 */
export function computeTaskCounters(
  tasks: Task[],
  opts: TaskCounterOpts
): TaskCounters {
  const { todayMembershipKeys, plannedCount, overdueCount, inboxUpcomingCount } = opts;
  return {
    today: todayMembershipKeys.size,
    myday: tasks.filter((t) => t.isPinned === true).length,
    planned: plannedCount,
    overdue: overdueCount,
    inbox: inboxUpcomingCount,
  };
}
