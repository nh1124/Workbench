/**
 * inboxBuilder.ts
 *
 * Pure functions for building Inbox rows from a flat task list.
 *
 * ════════════════════════════════════════════════════════════════
 * INBOX SPEC — DO NOT CHANGE without updating __tests__/inboxBuilder.test.ts
 *
 * Data source: taskList (all tasks from DB), keyed on dueDate.
 * NOT the LBS schedule API (LBS-based inbox was a regression in commit 84d408e).
 *
 * Display rules:
 *   1. done tasks        → doneRows,     sorted by dueDate DESC (newest first)
 *   2. todo, dueDate >= today → upcomingRows, sorted by dueDate ASC (nearest first)
 *   3. todo, dueDate <  today → upcomingRows (overdue), same ASC sort
 *   4. todo, no dueDate  → upcomingRows, sorted to the END (after all dated rows)
 * ════════════════════════════════════════════════════════════════
 */

import type { Task, TaskStatus } from "../types/models";

export interface InboxRow {
  key: string;
  taskId: string;
  /** dueDate in YYYY-MM-DD format, or "" when unscheduled */
  date: string;
  title: string;
  context: string;
  status: TaskStatus;
  load?: number;
  startTime?: string;
  endTime?: string;
  isLocked?: boolean;
}

export interface InboxRows {
  upcomingRows: InboxRow[];
  doneRows: InboxRow[];
}

/**
 * Build Inbox rows from a flat task list using dueDate as the occurrence reference.
 *
 * @param taskList - All tasks returned by the tasks API
 * @returns { upcomingRows, doneRows }
 */
export function buildInboxRows(taskList: Task[]): InboxRows {
  const upcomingRows: InboxRow[] = [];
  const doneRows: InboxRow[] = [];

  for (const task of taskList) {
    const row: InboxRow = {
      key: `inbox::${task.id}`,
      taskId: task.id,
      date: task.dueDate ?? "",
      title: task.title,
      context: task.contextName ?? task.context,
      status: task.status,
      load: task.baseLoadScore,
      startTime: task.startTime ?? undefined,
      endTime: task.endTime ?? undefined,
      isLocked: task.isLocked
    };

    if (task.status === "done") {
      doneRows.push(row);
    } else {
      upcomingRows.push(row);
    }
  }

  // Upcoming: overdue first → today/future next → no-date last (all ascending)
  upcomingRows.sort((a, b) => {
    const dA = a.date || "9999-12-31";
    const dB = b.date || "9999-12-31";
    return dA.localeCompare(dB);
  });

  // Done: newest dueDate first, no-date at end
  doneRows.sort((a, b) => {
    const dA = a.date || "";
    const dB = b.date || "";
    return dB.localeCompare(dA);
  });

  return { upcomingRows, doneRows };
}
