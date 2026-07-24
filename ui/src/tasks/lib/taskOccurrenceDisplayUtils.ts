/**
 * taskOccurrenceDisplayUtils.ts
 * Pure functions for transforming occurrence row lists into display-ready
 * structures (sorted lists, project group arrays).
 *
 * These are extracted from TasksPageContainer useMemo blocks so they can be
 * tested in isolation and reused across views without touching React.
 *
 * Dependency direction:
 *   tasks/lib/taskOccurrenceDisplayUtils → tasks/types, types/models
 */

import type { Task } from "../../types/models";
import type { QuickFilter, TaskOccurrenceRow } from "../types";

/** Hide terminal rows from views that only represent outstanding work. */
export function filterOccurrenceRowsForQuickFilter(
  rows: TaskOccurrenceRow[],
  quickFilter: QuickFilter
): TaskOccurrenceRow[] {
  if (quickFilter !== "planned" && quickFilter !== "overdue") return rows;
  return rows.filter((row) => row.status !== "done" && row.status !== "skipped");
}

// ── Sorting ───────────────────────────────────────────────────────────────────

/**
 * Sort occurrence rows for list display:
 * - done rows last
 * - within same done-group: by startTime ascending (no startTime sorts first,
 *   since an empty string compares before any "HH:MM" value)
 *
 * Returns a new array; the input is not mutated.
 */
export function sortOccurrenceRows(rows: TaskOccurrenceRow[]): TaskOccurrenceRow[] {
  return rows.slice().sort((a, b) => {
    const doneA = a.status === "done" ? 1 : 0;
    const doneB = b.status === "done" ? 1 : 0;
    if (doneA !== doneB) return doneA - doneB;
    return (a.startTime || "").localeCompare(b.startTime || "");
  });
}

// ── Project grouping ──────────────────────────────────────────────────────────

export interface OccurrenceProjectGroup {
  context: string;
  contextName: string;
  rows: TaskOccurrenceRow[];
}

/**
 * Group occurrence rows by their context (project), resolving the display name
 * from the project name map or from the master task's contextName field.
 *
 * Group order follows insertion order of first occurrence in `rows`.
 */
export function groupOccurrencesByProject(
  rows: TaskOccurrenceRow[],
  tasks: Task[],
  projectNameMap: Map<string, string>
): OccurrenceProjectGroup[] {
  const map = new Map<string, TaskOccurrenceRow[]>();
  for (const row of rows) {
    const list = map.get(row.context) ?? [];
    list.push(row);
    map.set(row.context, list);
  }
  return Array.from(map.entries()).map(([context, groupRows]) => {
    const masterTask = tasks.find((t) => t.context === context);
    const contextName =
      projectNameMap.get(context) || masterTask?.contextName || context;
    return { context, contextName, rows: groupRows };
  });
}
