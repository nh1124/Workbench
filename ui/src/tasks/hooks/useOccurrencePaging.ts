/**
 * useOccurrencePaging.ts
 * Owns the planned / overdue occurrence page-loading state.
 * Behavior is identical to the loadOccurrencePage / buildOccurrenceRowsFromSchedule
 * logic that lived in TasksPage.tsx.
 */

import { useMemo, useState } from "react";
import { tasksApi } from "../../lib/api";
import { addDays, startOfDay, toDateKey } from "../../lib/taskDateUtils";
import type { TaskOccurrenceRow } from "../types";
import { OCCURRENCE_PAGE_DAYS, toTaskStatus } from "../types";
import type { ScheduleCalendarDay, TaskScheduleDay } from "../../types/models";
import { computeOccurrenceHasMore } from "../lib/occurrencePagingUtils";
import { taskOccurrenceRowKey } from "../lib/taskOccurrenceIdentity";

/** Build flat occurrence rows from a raw schedule response. */
function buildOccurrenceRowsFromSchedule(
  scheduleDays: TaskScheduleDay[],
  mode: "planned" | "overdue",
  todayKey: string
): TaskOccurrenceRow[] {
  const rows: TaskOccurrenceRow[] = [];
  for (const day of scheduleDays) {
    const dateKey = day.date;
    if (mode === "planned" && dateKey <= todayKey) continue;
    if (mode === "overdue" && dateKey >= todayKey) continue;
    for (const item of day.tasks) {
      const status = toTaskStatus(item.status);
      if (mode === "overdue" && status === "done") continue;
      rows.push({
        key: taskOccurrenceRowKey({
          taskId: item.taskId,
          occurrenceDate: dateKey,
          scheduledDate: dateKey
        }),
        taskId: item.taskId,
        date: dateKey,
        occurrenceDate: dateKey,
        title: item.title,
        context: item.context,
        status,
        load: item.load,
        startTime: item.startTime,
        endTime: item.endTime,
        isLocked: item.isLocked
      });
    }
  }
  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.title.localeCompare(b.title);
  });
  return rows;
}

function buildOccurrenceRowsFromScheduleCalendar(
  scheduleDays: ScheduleCalendarDay[],
  todayKey: string,
  contextFilter: string
): TaskOccurrenceRow[] {
  const rows: TaskOccurrenceRow[] = [];
  for (const day of scheduleDays) {
    const dateKey = day.date;
    if (dateKey <= todayKey) continue;
    for (const item of day.items) {
      if (contextFilter && item.context !== contextFilter) continue;
      rows.push({
        key: taskOccurrenceRowKey({
          taskId: item.taskId,
          occurrenceDate: item.occurrenceDate,
          scheduledDate: item.scheduledDate,
          scheduleId: item.scheduleId
        }),
        taskId: item.taskId,
        date: item.scheduledDate,
        occurrenceDate: item.occurrenceDate,
        scheduledDate: item.scheduledDate,
        scheduleId: item.scheduleId,
        title: item.title,
        context: item.context,
        status: toTaskStatus(item.status),
        load: item.load,
        startTime: item.startTime,
        endTime: item.endTime,
        isLocked: item.isLocked
      });
    }
  }
  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    const time = (a.startTime || "").localeCompare(b.startTime || "");
    if (time !== 0) return time;
    return a.title.localeCompare(b.title);
  });
  return rows;
}

export interface OccurrencePagingState {
  occurrenceRows: TaskOccurrenceRow[];
  occurrenceLoading: boolean;
  occurrenceHasMore: boolean;
  occurrenceRowsOrdered: TaskOccurrenceRow[];
  occurrenceDateGroups: { date: string; rows: TaskOccurrenceRow[] }[];
  occurrenceOrderedKeys: string[];
}

export interface OccurrencePagingActions {
  loadOccurrencePage: (
    mode: "planned" | "overdue",
    reset?: boolean
  ) => Promise<void>;
  resetOccurrences: () => void;
  setOccurrenceRows: React.Dispatch<React.SetStateAction<TaskOccurrenceRow[]>>;
}

export function useOccurrencePaging(
  contextFilter: string
): OccurrencePagingState & OccurrencePagingActions {
  const [occurrenceRows, setOccurrenceRows] = useState<TaskOccurrenceRow[]>([]);
  const [occurrenceCursorDate, setOccurrenceCursorDate] = useState<Date | null>(null);
  const [occurrenceLoading, setOccurrenceLoading] = useState(false);
  const [occurrenceHasMore, setOccurrenceHasMore] = useState(true);

  const resetOccurrences = () => {
    setOccurrenceRows([]);
    setOccurrenceCursorDate(null);
    setOccurrenceHasMore(true);
  };

  const loadOccurrencePage = async (
    mode: "planned" | "overdue",
    reset = false
  ) => {
    if (occurrenceLoading) return;
    if (!reset && !occurrenceHasMore) return;
    setOccurrenceLoading(true);
    try {
      const todayDate = startOfDay(new Date());
      const todayKey = toDateKey(todayDate);
      const baseDate =
        reset || !occurrenceCursorDate
          ? mode === "planned"
            ? addDays(todayDate, 1)
            : addDays(todayDate, -1)
          : occurrenceCursorDate;

      const startDate =
        mode === "planned"
          ? baseDate
          : addDays(baseDate, -(OCCURRENCE_PAGE_DAYS - 1));
      const endDate =
        mode === "planned"
          ? addDays(baseDate, OCCURRENCE_PAGE_DAYS - 1)
          : baseDate;

      const rows = mode === "planned"
        ? buildOccurrenceRowsFromScheduleCalendar(
          await tasksApi.scheduleCalendar(toDateKey(startDate), toDateKey(endDate)),
          todayKey,
          contextFilter
        )
        : buildOccurrenceRowsFromSchedule(
          await tasksApi.schedule(
            toDateKey(startDate),
            toDateKey(endDate),
            contextFilter || undefined
          ),
          mode,
          todayKey
        );
      const nextCursor =
        mode === "planned"
          ? addDays(endDate, 1)
          : addDays(startDate, -1);
      const withinHorizon = computeOccurrenceHasMore(mode, todayDate, nextCursor);

      if (reset) {
        setOccurrenceRows(rows);
      } else {
        setOccurrenceRows((prev) => {
          const map = new Map<string, TaskOccurrenceRow>();
          for (const row of prev) map.set(row.key, row);
          for (const row of rows) map.set(row.key, row);
          const merged = Array.from(map.values());
          merged.sort((a, b) => {
            if (a.date !== b.date) return a.date.localeCompare(b.date);
            return a.title.localeCompare(b.title);
          });
          return merged;
        });
      }
      setOccurrenceCursorDate(nextCursor);
      // Keep paging even when a window has no rows.
      // Planned/Overdue can be sparse, so an empty page is not the end signal.
      setOccurrenceHasMore(withinHorizon);
    } catch {
      setOccurrenceHasMore(false);
    } finally {
      setOccurrenceLoading(false);
    }
  };

  // Derived sorted view
  const occurrenceRowsOrdered = useMemo(() => {
    const copied = occurrenceRows.slice();
    copied.sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      const doneA = a.status === "done" ? 1 : 0;
      const doneB = b.status === "done" ? 1 : 0;
      if (doneA !== doneB) return doneA - doneB;
      return a.title.localeCompare(b.title);
    });
    return copied;
  }, [occurrenceRows]);

  const occurrenceDateGroups = useMemo(() => {
    const map = new Map<string, TaskOccurrenceRow[]>();
    for (const row of occurrenceRowsOrdered) {
      const list = map.get(row.date) || [];
      list.push(row);
      map.set(row.date, list);
    }
    return Array.from(map.entries()).map(([date, rows]) => ({ date, rows }));
  }, [occurrenceRowsOrdered]);

  const occurrenceOrderedKeys = useMemo(
    () => occurrenceRowsOrdered.map((row) => row.key),
    [occurrenceRowsOrdered]
  );

  return {
    occurrenceRows,
    occurrenceLoading,
    occurrenceHasMore,
    occurrenceRowsOrdered,
    occurrenceDateGroups,
    occurrenceOrderedKeys,
    loadOccurrencePage,
    resetOccurrences,
    setOccurrenceRows
  };
}
