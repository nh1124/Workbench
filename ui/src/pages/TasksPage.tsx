import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent, type UIEvent } from "react";
import { useLocation } from "react-router-dom";
import { projectsApi, taskAttachmentsApi, tasksApi, taskSubtasksApi } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { pushErrorNotification } from "../lib/notificationService";
import { buildInboxRows } from "../lib/inboxBuilder";
import type { RecurrenceType, ScheduleCalendarDay, ScheduleCalendarItem, Task, TaskAttachment, TaskHistoryEntry, TaskScheduleDay, TaskStatus, TaskSubtask, TodayTask } from "../types/models";
// CSS is now imported by TasksPageContainer via the split css/ files.
// The original TasksPage.css is kept for reference but is no longer loaded here.

type SortMode = "load" | "due" | "project";

type SidebarMode = "list" | "calendar" | "schedule";
type CalendarMode = "month" | "week";
type QuickFilter = "today" | "myday" | "planned" | "overdue" | "inbox";
type CalendarStatusFilter = "all" | "open" | "done";

const TASK_STATUSES: TaskStatus[] = ["todo", "done", "skipped"];
const RECURRENCE_TYPES: RecurrenceType[] = ["ONCE", "WEEKLY", "EVERY_N_DAYS", "MONTHLY_DAY", "MONTHLY_NTH_WEEKDAY"];
const RECURRENCE_LABELS: Record<RecurrenceType, string> = {
  ONCE: "Once",
  WEEKLY: "Weekly",
  EVERY_N_DAYS: "Every N Days",
  MONTHLY_DAY: "Monthly (Day)",
  MONTHLY_NTH_WEEKDAY: "Monthly (Nth Weekday)"
};
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TIMELINE_START_HOUR = 0;
const TIMELINE_END_HOUR = 24;
const TIMELINE_HOUR_HEIGHT = 44;

interface TaskDraft {
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
  mon: boolean; tue: boolean; wed: boolean; thu: boolean;
  fri: boolean; sat: boolean; sun: boolean;
  intervalDays: number;
  anchorDate: string;
  monthDay: number;
  nthInMonth: number;
  weekdayMon1: number;
}

interface MonthCell { key: string; date: Date; inCurrentMonth: boolean; }
interface ProjectOption { projectId: string; projectName?: string; }
interface TaskOccurrenceRow {
  key: string;
  taskId: string;
  date: string;
  title: string;
  context: string;
  status: TaskStatus;
  load?: number;
  startTime?: string;
  endTime?: string;
  isLocked?: boolean;
}

const OCCURRENCE_PAGE_DAYS = 30;

const emptyDraft: TaskDraft = {
  title: "", notes: "", context: "",
  status: "todo", isLocked: false, baseLoadScore: 5,
  recurrence: "ONCE", dueDate: "", startTime: "", endTime: "",
  timezone: "Asia/Tokyo", active: true,
  activeFrom: "", activeUntil: "",
  mon: false, tue: false, wed: false, thu: false,
  fri: false, sat: false, sun: false,
  intervalDays: 1, anchorDate: "", monthDay: 1, nthInMonth: 1, weekdayMon1: 0
};

function taskToDraft(task: Task): TaskDraft {
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

function startOfDay(date: Date): Date { return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }
function startOfMonth(date: Date): Date { return new Date(date.getFullYear(), date.getMonth(), 1); }
function startOfWeek(date: Date): Date { const v = startOfDay(date); v.setDate(v.getDate() - v.getDay()); return v; }
function addDays(date: Date, days: number): Date { const v = new Date(date); v.setDate(v.getDate() + days); return v; }
function addMonths(date: Date, months: number): Date { return new Date(date.getFullYear(), date.getMonth() + months, 1); }
function isSameDay(a: Date, b: Date): boolean { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
const DAY_MS = 24 * 60 * 60 * 1000;

function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toTaskStatus(value: string | undefined): TaskStatus {
  if (value === "done" || value === "skipped") return value;
  return "todo";
}

function formatDateHeading(dateKey: string): string {
  const parsed = parseDateOnly(dateKey);
  if (!parsed) return dateKey;
  const mm = `${parsed.getMonth() + 1}`.padStart(2, "0");
  const dd = `${parsed.getDate()}`.padStart(2, "0");
  const yyyy = `${parsed.getFullYear()}`;
  return `${mm}.${dd}.${yyyy}`;
}

function parseDateOnly(value?: string): Date | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]) - 1;
    const day = Number(m[3]);
    return new Date(year, month, day);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return startOfDay(parsed);
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

function taskOccursOnDate(task: Task, date: Date): boolean {
  const day = startOfDay(date);

  if (task.recurrence === "ONCE") {
    const due = parseDateOnly(task.dueDate);
    return !!due && isSameDay(due, day);
  }

  if (!taskWithinActivePeriod(task, day)) return false;

  if (task.recurrence === "WEEKLY") {
    const selectedDays = [task.sun, task.mon, task.tue, task.wed, task.thu, task.fri, task.sat].map(Boolean);
    if (selectedDays.some(Boolean)) return selectedDays[day.getDay()];
    const fallback = parseDateOnly(task.activeFrom) || parseDateOnly(task.dueDate);
    return fallback ? fallback.getDay() === day.getDay() : false;
  }

  if (task.recurrence === "EVERY_N_DAYS") {
    const interval = Math.max(1, task.intervalDays ?? 1);
    const anchor = parseDateOnly(task.activeFrom) || parseDateOnly(task.createdAt);
    if (!anchor) return false;
    const diff = Math.floor((day.getTime() - anchor.getTime()) / DAY_MS);
    return diff >= 0 && diff % interval === 0;
  }

  if (task.recurrence === "MONTHLY_DAY") {
    const dayOfMonth = Math.min(31, Math.max(1, task.monthDay ?? 1));
    return day.getDate() === dayOfMonth;
  }

  if (task.recurrence === "MONTHLY_NTH_WEEKDAY") {
    const nthInMonth = Math.min(5, Math.max(1, task.nthInMonth ?? 1));
    const weekday = Math.min(6, Math.max(0, task.weekdayMon1 ?? 0));
    const weekIndex = Math.floor((day.getDate() - 1) / 7) + 1;
    return day.getDay() === weekday && weekIndex === nthInMonth;
  }

  return false;
}

function parseTimeToMinutes(value?: string): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!m) return null;
  const hour = Math.min(23, Math.max(0, Number(m[1])));
  const minute = Math.min(59, Math.max(0, Number(m[2])));
  return (hour * 60) + minute;
}

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

function buildMonthCells(monthDate: Date): MonthCell[] {
  const first = startOfMonth(monthDate);
  const firstWeekday = first.getDay();
  const daysInMonth = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0).getDate();
  const result: MonthCell[] = [];
  for (let i = 0; i < firstWeekday; i++)
    result.push({ key: `prev-${i}`, date: new Date(first.getFullYear(), first.getMonth(), i - firstWeekday + 1), inCurrentMonth: false });
  for (let day = 1; day <= daysInMonth; day++)
    result.push({ key: `cur-${day}`, date: new Date(first.getFullYear(), first.getMonth(), day), inCurrentMonth: true });
  while (result.length % 7 !== 0 || result.length < 35) {
    const nextIndex = result.length - (firstWeekday + daysInMonth) + 1;
    result.push({ key: `next-${nextIndex}`, date: new Date(first.getFullYear(), first.getMonth() + 1, nextIndex), inCurrentMonth: false });
  }
  return result;
}

function loadScoreColor(score: number): string {
  if (score >= 8) return "#f87171";
  if (score >= 5) return "#fbbf24";
  return "#6ee7b7";
}

function contextColor(context: string): string {
  const colors = ["#22d3ee", "#a78bfa", "#f472b6", "#34d399", "#fb923c", "#60a5fa", "#e879f9"];
  let h = 0;
  for (let i = 0; i < context.length; i++) h = (h * 31 + context.charCodeAt(i)) % colors.length;
  return colors[h];
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function mergeProjectOptions(...groups: ProjectOption[][]): ProjectOption[] {
  const merged = new Map<string, ProjectOption>();
  for (const group of groups) {
    for (const option of group) {
      const id = option.projectId?.trim();
      if (!id) continue;
      const prev = merged.get(id);
      merged.set(id, {
        projectId: id,
        projectName: option.projectName?.trim() || prev?.projectName
      });
    }
  }
  return Array.from(merged.values()).sort((a, b) =>
    (a.projectName || a.projectId).localeCompare(b.projectName || b.projectId)
  );
}

function isAuthErrorMessage(message: string): boolean {
  return /(missing bearer token|unauthori[sz]ed|unauthenticated|forbidden|401)/i.test(message);
}

// ─── SVG Icons ───────────────────────────────────────────────────
const IcoClipboard = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: "1rem", height: "1rem" }}>
    <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
    <rect x="9" y="3" width="6" height="4" rx="1" />
    <path d="M9 12h6M9 16h4" />
  </svg>
);
const IcoList = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: "0.85rem", height: "0.85rem" }}>
    <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
    <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
  </svg>
);
const IcoCal = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: "0.85rem", height: "0.85rem" }}>
    <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
  </svg>
);
const IcoSun = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: "0.85rem", height: "0.85rem" }}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
  </svg>
);
const IcoCalSmall = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: "0.85rem", height: "0.85rem" }}>
    <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
  </svg>
);
const IcoClock = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: "0.85rem", height: "0.85rem" }}>
    <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" />
  </svg>
);
const IcoInbox = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: "0.85rem", height: "0.85rem" }}>
    <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
    <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  </svg>
);
const IcoFolder = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: "0.85rem", height: "0.85rem" }}>
    <path d="M3 7h6l2 2h10v11H3z" />
  </svg>
);
const IcoCircle = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: "1rem", height: "1rem" }}>
    <circle cx="12" cy="12" r="9" />
  </svg>
);
const IcoCheckCircle = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: "1rem", height: "1rem" }}>
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
  </svg>
);
const IcoSkipped = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: "1rem", height: "1rem" }}>
    <circle cx="12" cy="12" r="9" /><line x1="9" y1="9" x2="15" y2="15" /><line x1="15" y1="9" x2="9" y2="15" />
  </svg>
);
const IcoLock = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: "0.8rem", height: "0.8rem" }}>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);
const IcoUnlock = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: "0.8rem", height: "0.8rem" }}>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 7.8-1" />
  </svg>
);
const IcoRefresh = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: "1rem", height: "1rem" }}>
    <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </svg>
);
const IcoDownload = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: "1rem", height: "1rem" }}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);
const IcoUpload = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: "1rem", height: "1rem" }}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);
const IcoX = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: "1rem", height: "1rem" }}>
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);
const IcoTrash = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: "0.9rem", height: "0.9rem" }}>
    <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14H6L5 6M10 11v6M14 11v6" /><path d="M9 6V4h6v2" />
  </svg>
);
const IcoChevron = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: "0.85rem", height: "0.85rem" }}>
    <polyline points="9 18 15 12 9 6" />
  </svg>
);
const IcoRepeat = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: "0.75rem", height: "0.75rem" }}>
    <polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" />
    <polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
  </svg>
);
const IcoPin = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: "0.8rem", height: "0.8rem" }}>
    <path d="M14 3l7 7-3 1-3 6-2-2-2 6-2-2 6-2-2-2 1-3-3-3z" />
  </svg>
);
const IcoZap = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: "0.6rem", height: "0.6rem" }}>
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </svg>
);
const IcoPlus = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: "1.5rem", height: "1.5rem" }}>
    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);
const IcoHistory = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: "0.85rem", height: "0.85rem" }}>
    <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 .49-4.08" />
    <polyline points="12 7 12 12 16 14" />
  </svg>
);
const IcoChevronDown = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: "0.85rem", height: "0.85rem" }}>
    <polyline points="6 9 12 15 18 9" />
  </svg>
);
const IcoFile = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: "0.85rem", height: "0.85rem", flexShrink: 0 }}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </svg>
);

function StatusCircle({ status }: { status: TaskStatus }) {
  if (status === "done") return <span style={{ color: "#3b82f6" }}><IcoCheckCircle /></span>;
  if (status === "skipped") return <span style={{ color: "#6b7280" }}><IcoSkipped /></span>;
  return <span style={{ color: "#4b5563" }}><IcoCircle /></span>;
}


import { TasksPageContainer } from "../tasks/TasksPageContainer";

/**
 * TasksPage — thin entry point.
 * All logic has been extracted into hooks under src/tasks/hooks/ and
 * the container component src/tasks/TasksPageContainer.tsx.
 * This file is retained for router compatibility (the route still imports TasksPage).
 */
export function TasksPage() {
  return <TasksPageContainer />;
}
