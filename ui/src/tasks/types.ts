/**
 * tasks/types.ts
 * Shared types, constants, and draft utilities for the Tasks domain.
 * Import from here so hooks and panes share the same definitions.
 */

import type { RecurrenceType, Task, TaskStatus } from "../types/models";

// ── View mode / filter types ──────────────────────────────────────────────────

export type SortMode = "load" | "due" | "project";
export type SidebarMode = "list" | "calendar" | "schedule";
export type CalendarMode = "month" | "week";
export type QuickFilter = "today" | "myday" | "planned" | "overdue" | "inbox";
export type CalendarStatusFilter = "all" | "open" | "done";

// ── Domain constants ──────────────────────────────────────────────────────────

export const TASK_STATUSES: TaskStatus[] = ["todo", "done", "skipped"];

export const RECURRENCE_TYPES: RecurrenceType[] = [
  "ONCE",
  "WEEKLY",
  "EVERY_N_DAYS",
  "MONTHLY_DAY",
  "MONTHLY_NTH_WEEKDAY"
];

export const RECURRENCE_LABELS: Record<RecurrenceType, string> = {
  ONCE: "Once",
  WEEKLY: "Weekly",
  EVERY_N_DAYS: "Every N Days",
  MONTHLY_DAY: "Monthly (Day)",
  MONTHLY_NTH_WEEKDAY: "Monthly (Nth Weekday)"
};

export const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export const OCCURRENCE_PAGE_DAYS = 30;

// ── Timeline constants ────────────────────────────────────────────────────────

export const TIMELINE_START_HOUR = 0;
export const TIMELINE_END_HOUR = 24;
export const TIMELINE_HOUR_HEIGHT = 44;

// ── TaskDraft ─────────────────────────────────────────────────────────────────

/** Mutable draft used in the Add Panel and the Edit Detail panel. */
export interface TaskDraft {
  title: string;
  notes: string;
  context: string;
  status: TaskStatus;
  isLocked: boolean;
  baseLoadScore: number;
  recurrence: RecurrenceType;
  dueDate: string;
  startTime: string;
  endTime: string;
  timezone: string;
  active: boolean;
  activeFrom: string;
  activeUntil: string;
  mon: boolean;
  tue: boolean;
  wed: boolean;
  thu: boolean;
  fri: boolean;
  sat: boolean;
  sun: boolean;
  intervalDays: number;
  anchorDate: string;
  monthDay: number;
  nthInMonth: number;
  /** Internal UI/service weekday index: Sunday = 0, Monday = 1, ..., Saturday = 6. */
  weekdayMon1: number;
}

export const emptyDraft: TaskDraft = {
  title: "",
  notes: "",
  context: "",
  status: "todo",
  isLocked: false,
  baseLoadScore: 5,
  recurrence: "ONCE",
  dueDate: "",
  startTime: "",
  endTime: "",
  timezone: "Asia/Tokyo",
  active: true,
  activeFrom: "",
  activeUntil: "",
  mon: false,
  tue: false,
  wed: false,
  thu: false,
  fri: false,
  sat: false,
  sun: false,
  intervalDays: 1,
  anchorDate: "",
  monthDay: 1,
  nthInMonth: 1,
  weekdayMon1: 0
};

/** Map a persisted Task to its mutable TaskDraft representation. */
export function taskToDraft(task: Task): TaskDraft {
  return {
    title: task.title,
    notes: task.notes,
    context: task.context,
    status: task.status,
    isLocked: task.isLocked,
    baseLoadScore: task.baseLoadScore,
    recurrence: task.recurrence,
    dueDate: task.dueDate || "",
    startTime: task.startTime || "",
    endTime: task.endTime || "",
    timezone: task.timezone || "Asia/Tokyo",
    active: task.active,
    activeFrom: task.activeFrom || "",
    activeUntil: task.activeUntil || "",
    mon: task.mon ?? false,
    tue: task.tue ?? false,
    wed: task.wed ?? false,
    thu: task.thu ?? false,
    fri: task.fri ?? false,
    sat: task.sat ?? false,
    sun: task.sun ?? false,
    intervalDays: task.intervalDays ?? 1,
    anchorDate: task.anchorDate || "",
    monthDay: task.monthDay ?? 1,
    nthInMonth: task.nthInMonth ?? 1,
    weekdayMon1: task.weekdayMon1 ?? 0
  };
}

// ── Occurrence row ────────────────────────────────────────────────────────────

/** A flattened row used by planned/overdue/today/inbox list views. */
export interface TaskOccurrenceRow {
  /** Stable row key derived from schedule item identity or occurrence identity. */
  key: string;
  taskId: string;
  /** Display/grouping date for the active view. */
  date: string;
  /** LBS execution date used for completion/history operations. */
  occurrenceDate?: string;
  /** Planned work date when this row comes from an explicit schedule item. */
  scheduledDate?: string;
  /** Explicit schedule item id, when available. */
  scheduleId?: number;
  title: string;
  context: string;
  status: TaskStatus;
  load?: number;
  startTime?: string;
  endTime?: string;
  isLocked?: boolean;
}

// ── Status coercion ───────────────────────────────────────────────────────────

/** Coerce an unknown string to a valid TaskStatus (defaults to "todo"). */
export function toTaskStatus(value: string | undefined): TaskStatus {
  if (value === "done" || value === "skipped") return value;
  return "todo";
}
