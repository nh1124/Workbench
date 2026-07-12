import type { TaskStatus } from "../../types/models";
import type { TaskOccurrenceRow } from "../types";

export interface TaskOccurrenceCollections {
  todayRows: TaskOccurrenceRow[];
  occurrenceRows: TaskOccurrenceRow[];
  inboxUpcomingRows: TaskOccurrenceRow[];
  inboxDoneRows: TaskOccurrenceRow[];
}

export interface TaskOccurrenceCollectionSetters {
  setTodayRows: React.Dispatch<React.SetStateAction<TaskOccurrenceRow[]>>;
  setOccurrenceRows: React.Dispatch<React.SetStateAction<TaskOccurrenceRow[]>>;
  setInboxUpcomingRows: React.Dispatch<React.SetStateAction<TaskOccurrenceRow[]>>;
  setInboxDoneRows: React.Dispatch<React.SetStateAction<TaskOccurrenceRow[]>>;
}

function applyOptimisticOccurrenceStatus(
  current: TaskOccurrenceCollections,
  selectedRows: TaskOccurrenceRow[],
  status: TaskStatus,
  setters: TaskOccurrenceCollectionSetters
): void {
  const affectedKeys = new Set(selectedRows.map((row) => row.key));
  const currentInboxKeys = new Set(
    [...current.inboxUpcomingRows, ...current.inboxDoneRows].map((row) => row.key)
  );
  const movedInboxRows = Array.from(
    new Map(
      selectedRows
        .filter((row) => currentInboxKeys.has(row.key))
        .map((row) => [row.key, { ...row, status }])
    ).values()
  );
  const updateRows = (rows: TaskOccurrenceRow[]) =>
    rows.map((row) => affectedKeys.has(row.key) ? { ...row, status } : row);
  const updateInboxRows = (rows: TaskOccurrenceRow[], isTarget: boolean) => {
    const next = rows.filter((row) => !affectedKeys.has(row.key));
    if (!isTarget) return next;
    const existingKeys = new Set(next.map((row) => row.key));
    for (const row of movedInboxRows) {
      if (existingKeys.has(row.key)) continue;
      next.push(row);
      existingKeys.add(row.key);
    }
    return next;
  };

  setters.setTodayRows(updateRows);
  setters.setOccurrenceRows(updateRows);
  setters.setInboxUpcomingRows((rows) => updateInboxRows(rows, status !== "done"));
  setters.setInboxDoneRows((rows) => updateInboxRows(rows, status === "done"));
}

function restoreRowsFromSnapshot(
  current: TaskOccurrenceRow[],
  snapshot: TaskOccurrenceRow[],
  rollbackKeys: Set<string>
): TaskOccurrenceRow[] {
  const currentByKey = new Map(current.map((row) => [row.key, row]));
  const restored = snapshot.map((row) => (
    rollbackKeys.has(row.key) ? row : currentByKey.get(row.key) ?? row
  ));
  const snapshotKeys = new Set(snapshot.map((row) => row.key));
  restored.push(...current.filter((row) => !snapshotKeys.has(row.key) && !rollbackKeys.has(row.key)));
  return restored;
}

/**
 * Apply a status mutation before starting the request and restore its snapshot
 * on failure. The rollback predicate prevents an older request from replacing
 * a newer optimistic update for the same row.
 */
export async function runOptimisticOccurrenceMutation(options: {
  current: TaskOccurrenceCollections;
  selectedRows: TaskOccurrenceRow[];
  status: TaskStatus;
  setters: TaskOccurrenceCollectionSetters;
  mutate: () => Promise<unknown>;
  shouldRollback?: (rowKey: string) => boolean;
}): Promise<void> {
  const { current, selectedRows, status, setters, mutate, shouldRollback } = options;
  applyOptimisticOccurrenceStatus(current, selectedRows, status, setters);

  try {
    await mutate();
  } catch (error) {
    const rollbackKeys = new Set(
      selectedRows
        .map((row) => row.key)
        .filter((key) => shouldRollback?.(key) ?? true)
    );
    setters.setTodayRows((rows) => restoreRowsFromSnapshot(rows, current.todayRows, rollbackKeys));
    setters.setOccurrenceRows((rows) => restoreRowsFromSnapshot(rows, current.occurrenceRows, rollbackKeys));
    setters.setInboxUpcomingRows((rows) => restoreRowsFromSnapshot(rows, current.inboxUpcomingRows, rollbackKeys));
    setters.setInboxDoneRows((rows) => restoreRowsFromSnapshot(rows, current.inboxDoneRows, rollbackKeys));
    throw error;
  }
}
