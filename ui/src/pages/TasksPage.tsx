import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type UIEvent } from "react";
import { projectsApi, tasksApi } from "../lib/api";
import { formatDateTime } from "../lib/format";
import type { RecurrenceType, Task, TaskHistoryEntry, TaskScheduleDay, TaskStatus } from "../types/models";
import "./TasksPage.css";

type SidebarMode = "list" | "calendar";
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
  intervalDays: 1, monthDay: 1, nthInMonth: 1, weekdayMon1: 0
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

function StatusCircle({ status }: { status: TaskStatus }) {
  if (status === "done") return <span style={{ color: "#3b82f6" }}><IcoCheckCircle /></span>;
  if (status === "skipped") return <span style={{ color: "#6b7280" }}><IcoSkipped /></span>;
  return <span style={{ color: "#4b5563" }}><IcoCircle /></span>;
}

export function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projectOptions, setProjectOptions] = useState<ProjectOption[]>([]);
  const [contextFilter, setContextFilter] = useState("");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("today");
  const [calendarStatusFilter, setCalendarStatusFilter] = useState<CalendarStatusFilter>("all");
  const [todayTaskIds, setTodayTaskIds] = useState<Set<string>>(new Set());
  const [occurrenceRows, setOccurrenceRows] = useState<TaskOccurrenceRow[]>([]);
  const [occurrenceCursorDate, setOccurrenceCursorDate] = useState<Date | null>(null);
  const [occurrenceLoading, setOccurrenceLoading] = useState(false);
  const [occurrenceHasMore, setOccurrenceHasMore] = useState(true);
  const [selectedOccurrenceKeys, setSelectedOccurrenceKeys] = useState<Set<string>>(new Set());
  const [lastOccurrenceKey, setLastOccurrenceKey] = useState<string | null>(null);
  const [occurrenceMenu, setOccurrenceMenu] = useState<{ x: number; y: number; visible: boolean }>({
    x: 0,
    y: 0,
    visible: false
  });
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("list");
  const [calendarMode, setCalendarMode] = useState<CalendarMode>("month");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TaskDraft>(emptyDraft);
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [addAdvancedOpen, setAddAdvancedOpen] = useState(false);
  const [addDraft, setAddDraft] = useState<TaskDraft>({ ...emptyDraft });
  const [addContextInput, setAddContextInput] = useState("");
  const [monthCursor, setMonthCursor] = useState(() => startOfMonth(new Date()));
  const [weekCursor, setWeekCursor] = useState(() => startOfWeek(new Date()));
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dayDetailDate, setDayDetailDate] = useState<Date | null>(null);
  const [history, setHistory] = useState<TaskHistoryEntry[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [nowMarker, setNowMarker] = useState(() => new Date());
  const importRef = useRef<HTMLInputElement>(null);
  const weekTimelineScrollRef = useRef<HTMLDivElement | null>(null);
  const autoScrolledWeekKeyRef = useRef<string>("");

  const today = useMemo(() => startOfDay(new Date()), []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMarker(new Date());
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const load = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const todayKey = toDateKey(new Date());
      const [taskList, taskProjects, projectsResult, todaySchedule] = await Promise.all([
        tasksApi.list(contextFilter || undefined),
        tasksApi.projects(),
        projectsApi.list(undefined, "active", 200).catch(() => ({ items: [] })),
        tasksApi.schedule(todayKey, todayKey, contextFilter || undefined).catch(() => [] as TaskScheduleDay[])
      ]);
      const todayIds = new Set<string>();
      const todayStatusMap = new Map<string, TaskStatus>();
      for (const day of todaySchedule) {
        for (const item of day.tasks) {
          todayIds.add(item.taskId);
          todayStatusMap.set(item.taskId, toTaskStatus(item.status));
        }
      }

      const mergedTasks = taskList.map((task) => {
        const status = todayStatusMap.get(task.id);
        if (!status) return task;
        return { ...task, status };
      });

      const serviceProjects = projectsResult.items.map((project) => ({
        projectId: project.id,
        projectName: project.name
      }));
      setTasks(mergedTasks);
      setTodayTaskIds(todayIds);
      setProjectOptions(
        mergeProjectOptions(
          taskProjects.map((p) => ({ projectId: p.projectId, projectName: p.projectName })),
          serviceProjects
        )
      );
      if (selectedTaskId && !mergedTasks.find((t) => t.id === selectedTaskId)) {
        setSelectedTaskId(null);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to load tasks.";
      setTodayTaskIds(new Set());
      setError(isAuthErrorMessage(message) ? message : null);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { void load(); }, [contextFilter]);

  const buildOccurrenceRowsFromSchedule = (
    scheduleDays: TaskScheduleDay[],
    mode: "planned" | "overdue",
    todayKey: string
  ): TaskOccurrenceRow[] => {
    const rows: TaskOccurrenceRow[] = [];
    for (const day of scheduleDays) {
      const dateKey = day.date;
      if (mode === "planned" && dateKey <= todayKey) continue;
      if (mode === "overdue" && dateKey >= todayKey) continue;
      for (const item of day.tasks) {
        const status = toTaskStatus(item.status);
        if (mode === "overdue" && status === "done") continue;
        rows.push({
          key: `${dateKey}::${item.taskId}`,
          taskId: item.taskId,
          date: dateKey,
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
  };

  const loadOccurrencePage = async (mode: "planned" | "overdue", reset = false) => {
    if (occurrenceLoading) return;
    if (!reset && !occurrenceHasMore) return;
    setOccurrenceLoading(true);
    try {
      const todayDate = startOfDay(new Date());
      const todayKey = toDateKey(todayDate);
      const baseDate = reset || !occurrenceCursorDate
        ? (mode === "planned" ? addDays(todayDate, 1) : addDays(todayDate, -1))
        : occurrenceCursorDate;
      const startDate = mode === "planned" ? baseDate : addDays(baseDate, -(OCCURRENCE_PAGE_DAYS - 1));
      const endDate = mode === "planned" ? addDays(baseDate, OCCURRENCE_PAGE_DAYS - 1) : baseDate;
      const schedule = await tasksApi.schedule(
        toDateKey(startDate),
        toDateKey(endDate),
        contextFilter || undefined
      );
      const rows = buildOccurrenceRowsFromSchedule(schedule, mode, todayKey);
      const nextCursor = mode === "planned" ? addDays(endDate, 1) : addDays(startDate, -1);

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
      setOccurrenceHasMore(rows.length > 0);
    } catch {
      setOccurrenceHasMore(false);
    } finally {
      setOccurrenceLoading(false);
    }
  };

  useEffect(() => {
    if (quickFilter !== "planned" && quickFilter !== "overdue") {
      setOccurrenceRows([]);
      setOccurrenceCursorDate(null);
      setOccurrenceHasMore(true);
      setSelectedOccurrenceKeys(new Set());
      setLastOccurrenceKey(null);
      setOccurrenceMenu((prev) => ({ ...prev, visible: false }));
      return;
    }
    setOccurrenceCursorDate(null);
    setOccurrenceHasMore(true);
    setSelectedOccurrenceKeys(new Set());
    setLastOccurrenceKey(null);
    void loadOccurrencePage(quickFilter, true);
  }, [quickFilter, contextFilter]);

  useEffect(() => {
    if (!occurrenceMenu.visible) return;
    const close = () => {
      setOccurrenceMenu((prev) => ({ ...prev, visible: false }));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [occurrenceMenu.visible]);

  const filteredTasks = useMemo(() => {
    let base = tasks;
    // Apply calendar status filter in calendar mode
    if (sidebarMode === "calendar") {
      if (calendarStatusFilter === "open") base = base.filter((t) => t.status === "todo");
      if (calendarStatusFilter === "done") base = base.filter((t) => t.status === "done");
    } else {
      if (quickFilter === "today") {
        base = todayTaskIds.size > 0
          ? base.filter((t) => todayTaskIds.has(t.id))
          : base.filter((task) => taskOccursOnDate(task, today));
      } else if (quickFilter === "myday") {
        base = base.filter((t) => t.isPinned === true);
      } else if (quickFilter === "planned") {
        base = base;
      } else if (quickFilter === "overdue") {
        base = base;
      } else if (quickFilter === "inbox") {
        // Inbox is the previous "All Tasks" view in VisionArk flow.
        base = base;
      }
    }
    return base.sort((a, b) => {
      const dA = a.dueDate || "9999-12-31", dB = b.dueDate || "9999-12-31";
      return dA !== dB ? dA.localeCompare(dB) : b.updatedAt.localeCompare(a.updatedAt);
    });
  }, [quickFilter, calendarStatusFilter, sidebarMode, tasks, today, todayTaskIds]);

  const counters = useMemo(() => ({
    today: todayTaskIds.size > 0
      ? todayTaskIds.size
      : tasks.filter((task) => taskOccursOnDate(task, today)).length,
    myday: tasks.filter((t) => t.isPinned === true).length,
    planned: occurrenceRows.filter((row) => row.date > toDateKey(today)).length,
    overdue: occurrenceRows.filter((row) => row.date < toDateKey(today)).length,
    inbox: tasks.length
  }), [tasks, today, todayTaskIds, occurrenceRows]);

  const handleCenterScroll = (event: UIEvent<HTMLDivElement>) => {
    if (sidebarMode !== "list") return;
    if (quickFilter !== "planned" && quickFilter !== "overdue") return;
    const currentTarget = event.currentTarget;
    const remaining = currentTarget.scrollHeight - currentTarget.scrollTop - currentTarget.clientHeight;
    if (remaining < 140) {
      void loadOccurrencePage(quickFilter, false);
    }
  };

  const projectNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const option of projectOptions) {
      map.set(option.projectId, option.projectName?.trim() || option.projectId);
    }
    return map;
  }, [projectOptions]);

  const resolveContextDisplayName = (context: string, contextName?: string): string =>
    projectNameMap.get(context) || contextName || context;

  const groupedTasks = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of filteredTasks) {
      const list = map.get(t.context) || [];
      list.push(t);
      map.set(t.context, list);
    }
    return Array.from(map.entries()).map(([context, pts]) => ({
      context, contextName: projectNameMap.get(context) || pts[0]?.contextName || context, tasks: pts
    }));
  }, [filteredTasks, projectNameMap]);

  const occurrenceRowsOrdered = useMemo(() => {
    const copied = occurrenceRows.slice();
    copied.sort((a, b) => {
      if (a.date !== b.date) {
        return quickFilter === "overdue"
          ? b.date.localeCompare(a.date)
          : a.date.localeCompare(b.date);
      }
      return a.title.localeCompare(b.title);
    });
    return copied;
  }, [occurrenceRows, quickFilter]);

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

  const monthCells = useMemo(() => buildMonthCells(monthCursor), [monthCursor]);
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekCursor, i)), [weekCursor]);

  const tasksByDate = useMemo(() => {
    const visibleDates = calendarMode === "month"
      ? monthCells.map((cell) => startOfDay(cell.date))
      : weekDays.map((d) => startOfDay(d));

    const map = new Map<string, Task[]>();
    for (const date of visibleDates) {
      const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      map.set(key, filteredTasks.filter((task) => taskOccursOnDate(task, date)));
    }
    return map;
  }, [calendarMode, filteredTasks, monthCells, weekDays]);

  const hasTasksInVisiblePeriod = useMemo(
    () => Array.from(tasksByDate.values()).some((items) => items.length > 0),
    [tasksByDate]
  );
  const periodLabel = useMemo(() => (
    calendarMode === "month"
      ? monthCursor.toLocaleDateString("en-US", { year: "numeric", month: "long" })
      : `${weekDays[0].toLocaleDateString("en-US", { month: "short", day: "numeric" })} - ${weekDays[6].toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
  ), [calendarMode, monthCursor, weekDays]);
  const timelineHours = useMemo(
    () => Array.from({ length: (TIMELINE_END_HOUR - TIMELINE_START_HOUR) + 1 }, (_, i) => TIMELINE_START_HOUR + i),
    []
  );
  const timelineBodyHeight = useMemo(
    () => (TIMELINE_END_HOUR - TIMELINE_START_HOUR) * TIMELINE_HOUR_HEIGHT,
    []
  );
  const nowDay = useMemo(() => startOfDay(nowMarker), [nowMarker]);
  const nowMinuteOfDay = useMemo(() => (nowMarker.getHours() * 60) + nowMarker.getMinutes(), [nowMarker]);
  const visibleWeekKey = useMemo(
    () => `${weekDays[0].getFullYear()}-${weekDays[0].getMonth()}-${weekDays[0].getDate()}_${weekDays[6].getFullYear()}-${weekDays[6].getMonth()}-${weekDays[6].getDate()}`,
    [weekDays]
  );

  useEffect(() => {
    if (sidebarMode !== "calendar" || calendarMode !== "week") {
      autoScrolledWeekKeyRef.current = "";
    }
  }, [sidebarMode, calendarMode]);

  useEffect(() => {
    if (sidebarMode !== "calendar" || calendarMode !== "week") return;
    if (autoScrolledWeekKeyRef.current === visibleWeekKey) return;
    const scrollElement = weekTimelineScrollRef.current;
    if (!scrollElement) return;

    const startMinutes = TIMELINE_START_HOUR * 60;
    const endMinutes = TIMELINE_END_HOUR * 60;
    if (nowMinuteOfDay < startMinutes || nowMinuteOfDay > endMinutes) return;

    const markerTop = ((nowMinuteOfDay - startMinutes) / 60) * TIMELINE_HOUR_HEIGHT;
    const target = Math.max(0, markerTop - (scrollElement.clientHeight * 0.35));
    scrollElement.scrollTop = target;
    autoScrolledWeekKeyRef.current = visibleWeekKey;
  }, [calendarMode, nowMinuteOfDay, sidebarMode, visibleWeekKey]);

  const isAuthError = useMemo(() => {
    if (!error) return false;
    return isAuthErrorMessage(error);
  }, [error]);
  const displayError = useMemo(() => {
    if (!error || isAuthError) return null;
    return error;
  }, [error, isAuthError]);
  const selectedTask = tasks.find((t) => t.id === selectedTaskId) || null;
  const dayDetailTasks = useMemo(() => {
    if (!dayDetailDate) return [];
    return filteredTasks.filter((task) => taskOccursOnDate(task, dayDetailDate));
  }, [dayDetailDate, filteredTasks]);

  const selectTask = (task: Task) => {
    setSelectedTaskId(task.id);
    setDraft(taskToDraft(task));
    setHistory([]);
    setHistoryOpen(false);
    setAdvancedOpen(false);
    setShowAddPanel(false);
  };

  const clearDetail = () => {
    setSelectedTaskId(null);
    setDraft(emptyDraft);
    setHistory([]);
    setAdvancedOpen(false);
  };

  const openAddPanel = () => {
    setShowAddPanel(true);
    setAddAdvancedOpen(false);
    setSelectedTaskId(null);
    const initialContext = contextFilter || projectOptions[0]?.projectId || "";
    const initialName = projectOptions.find((p) => p.projectId === initialContext)?.projectName || initialContext;
    setAddDraft({ ...emptyDraft, context: initialContext });
    setAddContextInput(initialName);
  };

  const resolveExistingContextOption = (rawValue: string): ProjectOption | undefined => {
    const value = rawValue.trim();
    if (!value) return undefined;
    const lower = normalizeText(value);
    return projectOptions.find((option) =>
      option.projectId === value ||
      normalizeText(option.projectId) === lower ||
      (option.projectName && normalizeText(option.projectName) === lower)
    );
  };

  const ensureAddContextProject = async (): Promise<ProjectOption | undefined> => {
    const typed = addContextInput.trim();
    if (!typed) return undefined;
    const existing = resolveExistingContextOption(typed);
    if (existing) return existing;

    const created = await projectsApi.create({ name: typed, status: "active" });
    const createdOption: ProjectOption = { projectId: created.id, projectName: created.name };
    setProjectOptions((prev) => mergeProjectOptions(prev, [createdOption]));
    return createdOption;
  };

  const handleToggleDone = async (task: Task) => {
    const newStatus: TaskStatus = task.status === "done" ? "todo" : "done";
    const previousStatus = task.status;
    setTasks((prev) => prev.map((item) => (
      item.id === task.id ? { ...item, status: newStatus } : item
    )));
    if (selectedTaskId === task.id) {
      setDraft((prev) => ({ ...prev, status: newStatus }));
    }
    try {
      await tasksApi.update(task.id, { status: newStatus });
      await load();
    } catch {
      setTasks((prev) => prev.map((item) => (
        item.id === task.id ? { ...item, status: previousStatus } : item
      )));
      if (selectedTaskId === task.id) {
        setDraft((prev) => ({ ...prev, status: previousStatus }));
      }
      setError("Failed to update task status.");
    }
  };

  const handleTogglePin = async (task: Task) => {
    const nextPinned = !(task.isPinned === true);
    setTasks((prev) => prev.map((item) => (
      item.id === task.id ? { ...item, isPinned: nextPinned } : item
    )));
    try {
      await tasksApi.setPin(task.id, nextPinned);
      await load();
    } catch {
      setTasks((prev) => prev.map((item) => (
        item.id === task.id ? { ...item, isPinned: task.isPinned === true } : item
      )));
      setError("Failed to update pin status. Please try again.");
    }
  };

  const handleToggleOccurrenceDone = async (row: TaskOccurrenceRow) => {
    const nextStatus: TaskStatus = row.status === "done" ? "todo" : "done";
    try {
      await tasksApi.completeOccurrence(row.taskId, row.date, nextStatus);
      await refreshAfterOccurrenceMutation();
    } catch {
      setError("Failed to update occurrence status.");
    }
  };

  const refreshAfterOccurrenceMutation = async () => {
    await load();
    if (quickFilter === "planned" || quickFilter === "overdue") {
      setOccurrenceCursorDate(null);
      setOccurrenceHasMore(true);
      await loadOccurrencePage(quickFilter, true);
    }
  };

  const handleOccurrenceClick = (event: ReactMouseEvent<HTMLButtonElement>, row: TaskOccurrenceRow) => {
    const isShift = "shiftKey" in event && event.shiftKey;
    const isToggle = "metaKey" in event && (event.metaKey || event.ctrlKey);
    const next = new Set(selectedOccurrenceKeys);

    if (isShift && lastOccurrenceKey) {
      const start = occurrenceOrderedKeys.indexOf(lastOccurrenceKey);
      const end = occurrenceOrderedKeys.indexOf(row.key);
      if (start >= 0 && end >= 0) {
        const [from, to] = start < end ? [start, end] : [end, start];
        for (let index = from; index <= to; index += 1) {
          next.add(occurrenceOrderedKeys[index]);
        }
      } else {
        next.add(row.key);
      }
    } else if (isToggle) {
      if (next.has(row.key)) next.delete(row.key);
      else next.add(row.key);
    } else {
      next.clear();
      next.add(row.key);
      if (!isShift) {
        const masterTask = tasks.find((task) => task.id === row.taskId);
        if (masterTask) {
          selectTask(masterTask);
        }
      }
    }

    setSelectedOccurrenceKeys(next);
    setLastOccurrenceKey(row.key);
  };

  const ensureContextSelection = (row: TaskOccurrenceRow, x: number, y: number) => {
    setSelectedOccurrenceKeys((prev) => {
      if (prev.has(row.key)) return prev;
      return new Set([row.key]);
    });
    setLastOccurrenceKey(row.key);
    setOccurrenceMenu({ x, y, visible: true });
  };

  const getSelectedOccurrenceRows = (): TaskOccurrenceRow[] => {
    if (selectedOccurrenceKeys.size === 0) return [];
    return occurrenceRowsOrdered.filter((row) => selectedOccurrenceKeys.has(row.key));
  };

  const handleMarkSelectedOccurrences = async (status: TaskStatus) => {
    const selectedRows = getSelectedOccurrenceRows();
    if (selectedRows.length === 0) return;
    try {
      await Promise.all(
        selectedRows.map((row) => tasksApi.completeOccurrence(row.taskId, row.date, status))
      );
      setOccurrenceMenu((prev) => ({ ...prev, visible: false }));
      await refreshAfterOccurrenceMutation();
    } catch {
      setError("Failed to update selected occurrences.");
    }
  };

  const handleMoveSelectedOccurrences = async () => {
    const selectedRows = getSelectedOccurrenceRows();
    if (selectedRows.length === 0) return;
    const targetDateInput = window.prompt("Move selected occurrences to date (YYYY-MM-DD)");
    if (!targetDateInput) return;
    const targetDate = targetDateInput.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      setError("Invalid date format. Use YYYY-MM-DD.");
      return;
    }
    try {
      await Promise.all(
        selectedRows.map((row) => tasksApi.moveOccurrence(row.taskId, row.date, targetDate))
      );
      setOccurrenceMenu((prev) => ({ ...prev, visible: false }));
      await refreshAfterOccurrenceMutation();
    } catch {
      setError("Failed to move selected occurrences.");
    }
  };

  const handleDeleteSelectedFromMenu = async () => {
    const selectedRows = getSelectedOccurrenceRows();
    if (selectedRows.length === 0) return;
    const confirmed = window.confirm(`Delete ${selectedRows.length} selected task(s)?`);
    if (!confirmed) return;
    const taskIds = Array.from(new Set(selectedRows.map((row) => row.taskId)));
    try {
      await Promise.all(taskIds.map((taskId) => tasksApi.remove(taskId)));
      setOccurrenceMenu((prev) => ({ ...prev, visible: false }));
      await refreshAfterOccurrenceMutation();
    } catch {
      setError("Failed to delete selected tasks.");
    }
  };

  const handleAddTask = async () => {
    if (!addDraft.title.trim()) { setError("Task name is required."); return; }
    setIsSaving(true); setError(null);
    try {
      const contextOption = await ensureAddContextProject();
      if (!contextOption) {
        setError("Context is required.");
        return;
      }
      const isOnce = addDraft.recurrence === "ONCE";
      await tasksApi.create({
        title: addDraft.title.trim(),
        notes: addDraft.notes,
        context: contextOption.projectId,
        contextName: contextOption.projectName || contextOption.projectId,
        status: addDraft.status,
        isLocked: addDraft.isLocked,
        baseLoadScore: addDraft.baseLoadScore,
        recurrence: addDraft.recurrence,
        dueDate: isOnce ? (addDraft.dueDate || undefined) : undefined,
        startTime: addDraft.startTime || undefined,
        endTime: addDraft.endTime || undefined,
        timezone: addDraft.timezone,
        active: true,
        activeFrom: isOnce ? undefined : (addDraft.activeFrom || undefined),
        activeUntil: isOnce ? undefined : (addDraft.activeUntil || undefined),
        mon: addDraft.mon, tue: addDraft.tue, wed: addDraft.wed, thu: addDraft.thu,
        fri: addDraft.fri, sat: addDraft.sat, sun: addDraft.sun,
        intervalDays: addDraft.intervalDays,
        monthDay: addDraft.monthDay, nthInMonth: addDraft.nthInMonth,
        weekdayMon1: addDraft.weekdayMon1
      } as Parameters<typeof tasksApi.create>[0]);
      setShowAddPanel(false);
      setAddAdvancedOpen(false);
      setAddDraft({ ...emptyDraft });
      setAddContextInput("");
      await load();
    } catch {
      // API errors are routed to the global notification center.
      setError(null);
    }
    finally { setIsSaving(false); }
  };

  const handleSaveDetail = async () => {
    if (!draft.title.trim() || !draft.context.trim()) { setError("Title and context are required."); return; }
    if (!selectedTaskId) return;
    setIsSaving(true); setError(null);
    try {
      const updated = await tasksApi.update(selectedTaskId, {
        title: draft.title.trim(),
        notes: draft.notes,
        context: draft.context,
        status: draft.status,
        isLocked: draft.isLocked,
        baseLoadScore: draft.baseLoadScore,
        recurrence: draft.recurrence,
        dueDate: draft.dueDate || undefined,
        startTime: draft.startTime || undefined,
        endTime: draft.endTime || undefined,
        timezone: draft.timezone,
        active: draft.active,
        activeFrom: draft.activeFrom || undefined,
        activeUntil: draft.activeUntil || undefined,
        mon: draft.mon, tue: draft.tue, wed: draft.wed, thu: draft.thu,
        fri: draft.fri, sat: draft.sat, sun: draft.sun,
        intervalDays: draft.intervalDays,
        monthDay: draft.monthDay, nthInMonth: draft.nthInMonth, weekdayMon1: draft.weekdayMon1
      });
      if (updated) setDraft(taskToDraft(updated));
      await load();
    } catch {
      // API errors are routed to the global notification center.
      setError(null);
    }
    finally { setIsSaving(false); }
  };

  const handleDeleteDetail = async () => {
    if (!selectedTaskId) return;
    setIsSaving(true); setError(null);
    try {
      await tasksApi.remove(selectedTaskId);
      clearDetail(); await load();
    } catch {
      // API errors are routed to the global notification center.
      setError(null);
    }
    finally { setIsSaving(false); }
  };

  const loadHistory = async () => {
    if (!selectedTaskId || historyLoading) return;
    setHistoryLoading(true);
    try {
      const h = await tasksApi.history(selectedTaskId);
      setHistory(h);
    } catch { setHistory([]); }
    finally { setHistoryLoading(false); }
  };

  const handleHistoryToggle = () => {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (next && history.length === 0) void loadHistory();
  };

  const handleExport = async () => {
    try {
      const blob = await tasksApi.exportCsv();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "tasks.csv"; a.click();
      URL.revokeObjectURL(url);
    } catch {
      // API errors are routed to the global notification center.
      setError(null);
    }
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    tasksApi.importCsv(file)
      .then(() => void load())
      .catch(() => {
        // API errors are routed to the global notification center.
        setError(null);
      });
    e.target.value = "";
  };

  const jumpToday = () => {
    setMonthCursor(startOfMonth(new Date()));
    setWeekCursor(startOfWeek(new Date()));
  };

  const movePrevPeriod = () => {
    if (calendarMode === "month") setMonthCursor((p) => addMonths(p, -1));
    else setWeekCursor((p) => addDays(p, -7));
  };

  const moveNextPeriod = () => {
    if (calendarMode === "month") setMonthCursor((p) => addMonths(p, 1));
    else setWeekCursor((p) => addDays(p, 7));
  };

  return (
    <section className={selectedTask ? "tasks-shell has-detail" : "tasks-shell"}>

      {/* ── Left secondary sidebar ─────────────────────── */}
      <aside className="tasks-secondary">
        <header className="tasks-secondary-head">
          <h2>
            <IcoClipboard />
            Tasks
          </h2>
        </header>

        {/* View tabs */}
        <div className="tasks-secondary-group" style={{ borderTop: 0, paddingTop: 0 }}>
          <button
            type="button"
            className={sidebarMode === "list" ? "sidebar-tab active" : "sidebar-tab"}
            onClick={() => setSidebarMode("list")}
          >
            <IcoList /> Task List
          </button>
          <button
            type="button"
            className={sidebarMode === "calendar" ? "sidebar-tab active" : "sidebar-tab"}
            onClick={() => setSidebarMode("calendar")}
          >
            <IcoCal /> Calendar
          </button>
        </div>

        {/* List mode filters */}
        {sidebarMode === "list" && (
          <>
            <div className="tasks-secondary-group">
              <p>Task Filters</p>
              <button type="button" className={quickFilter === "today" ? "filter-item active" : "filter-item"}
                onClick={() => setQuickFilter("today")}>
                <span className="filter-item-left"><IcoSun /><span>Today</span></span>
                <small>{counters.today}</small>
              </button>
              <button type="button" className={quickFilter === "myday" ? "filter-item active" : "filter-item"}
                onClick={() => setQuickFilter("myday")}>
                <span className="filter-item-left"><IcoCheckCircle /><span>My Day</span></span>
                <small>{counters.myday}</small>
              </button>
              <button type="button" className={quickFilter === "planned" ? "filter-item active" : "filter-item"}
                onClick={() => setQuickFilter("planned")}>
                <span className="filter-item-left"><IcoCalSmall /><span>Planned</span></span>
                <small>{counters.planned}</small>
              </button>
              <button type="button" className={quickFilter === "overdue" ? "filter-item active" : "filter-item"}
                onClick={() => setQuickFilter("overdue")}>
                <span className="filter-item-left"><IcoClock /><span>Overdue</span></span>
                <small>{counters.overdue}</small>
              </button>
              <button type="button" className={quickFilter === "inbox" ? "filter-item active" : "filter-item"}
                onClick={() => setQuickFilter("inbox")}>
                <span className="filter-item-left"><IcoInbox /><span>Inbox</span></span>
                <small>{counters.inbox}</small>
              </button>
            </div>

            <div className="tasks-secondary-group">
              <p>Projects</p>
              <button type="button" className={contextFilter === "" ? "filter-item active" : "filter-item"}
                onClick={() => setContextFilter("")}>
                <span className="filter-item-left"><IcoFolder /><span>All Projects</span></span>
              </button>
              {projectOptions.map((p) => (
                <button key={p.projectId} type="button"
                  className={contextFilter === p.projectId ? "filter-item active" : "filter-item"}
                  onClick={() => setContextFilter(p.projectId)}>
                  <span className="filter-item-left">
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: contextColor(p.projectId), flexShrink: 0, display: "inline-block" }} />
                    <span>{p.projectName || p.projectId}</span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {/* Calendar mode: CALENDAR STATUS */}
        {sidebarMode === "calendar" && (
          <>
            <div className="tasks-secondary-group">
              <p>Calendar Status</p>
              <button type="button" className={calendarStatusFilter === "all" ? "filter-item active" : "filter-item"}
                onClick={() => setCalendarStatusFilter("all")}>
                <span className="filter-item-left"><IcoFolder /><span>All Status</span></span>
              </button>
              <button type="button" className={calendarStatusFilter === "open" ? "filter-item active" : "filter-item"}
                onClick={() => setCalendarStatusFilter("open")}>
                <span className="filter-item-left"><IcoCircle /><span>Open Only</span></span>
              </button>
              <button type="button" className={calendarStatusFilter === "done" ? "filter-item active" : "filter-item"}
                onClick={() => setCalendarStatusFilter("done")}>
                <span className="filter-item-left"><IcoCheckCircle /><span>Done Only</span></span>
              </button>
            </div>
            <div className="tasks-secondary-group">
              <p>Projects</p>
              <button type="button" className={contextFilter === "" ? "filter-item active" : "filter-item"}
                onClick={() => setContextFilter("")}>
                <span className="filter-item-left"><IcoFolder /><span>All Projects</span></span>
              </button>
              {projectOptions.map((p) => (
                <button key={p.projectId} type="button"
                  className={contextFilter === p.projectId ? "filter-item active" : "filter-item"}
                  onClick={() => setContextFilter(p.projectId)}>
                  <span className="filter-item-left">
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: contextColor(p.projectId), flexShrink: 0, display: "inline-block" }} />
                    <span>{p.projectName || p.projectId}</span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </aside>

      {/* ── Center content ─────────────────────────────── */}
      <div className="tasks-center" onScroll={handleCenterScroll}>
        {/* Header */}
        {sidebarMode === "calendar" ? (
          <header className="tasks-center-head tasks-center-head-calendar">
            <div className="calendar-nav-cluster">
              <button type="button" className="calendar-nav-btn" onClick={movePrevPeriod} title="Previous period">{"<"}</button>
              <button type="button" className="calendar-nav-today" onClick={jumpToday}>Today</button>
              <button type="button" className="calendar-nav-btn" onClick={moveNextPeriod} title="Next period">{">"}</button>
              <strong>{periodLabel}</strong>
            </div>
            <div className="tasks-head-actions calendar-head-actions">
              <div className="calendar-view-toggle">
                <button type="button" className={calendarMode === "month" ? "active" : ""}
                  onClick={() => setCalendarMode("month")}
                  aria-label="Month view"
                  title="Month view">
                  <IcoCal />
                </button>
                <button type="button" className={calendarMode === "week" ? "active" : ""}
                  onClick={() => setCalendarMode("week")}
                  aria-label="Week view"
                  title="Week view">
                  <IcoList />
                </button>
              </div>
              <button type="button" className="icon-button" onClick={() => void load()} title="Refresh"><IcoRefresh /></button>
            </div>
          </header>
        ) : (
          <header className="tasks-center-head">
            <div>
              <p>{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</p>
            </div>
            <div className="tasks-head-actions">
              <button type="button" className="icon-button" onClick={handleExport} title="Export CSV"><IcoDownload /></button>
              <button type="button" className="icon-button" onClick={() => importRef.current?.click()} title="Import CSV"><IcoUpload /></button>
              <input ref={importRef} type="file" accept=".csv" style={{ display: "none" }} onChange={handleImport} />
              <button type="button" className="icon-button" onClick={() => void load()} title="Refresh"><IcoRefresh /></button>
              <button type="button" className="tasks-add-btn" onClick={openAddPanel}>+ Add</button>
            </div>
          </header>
        )}

        {displayError ? <p className="error" style={{ margin: "0 0 0.5rem", fontSize: "0.8rem" }}>{displayError}</p> : null}
        {isLoading ? <p className="info" style={{ margin: "0 0 0.5rem", fontSize: "0.8rem" }}>Loading tasks...</p> : null}

        {/* ── Quick Add inline panel ── */}
        {showAddPanel && sidebarMode === "list" && (
          <div className="task-add-panel">
            <p className="task-add-panel-kicker">New Task</p>
            <div className="task-add-panel-body">
              <div className="task-add-row">
                <input className="task-add-title-input" placeholder="Task name..." value={addDraft.title}
                  onChange={(e) => setAddDraft((p) => ({ ...p, title: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && void handleAddTask()} />
              </div>
              <div className={addDraft.recurrence === "ONCE" ? "task-add-compact-row" : "task-add-compact-row without-date"}>
                <label className="task-add-select task-add-select-context">
                  <span className="task-add-select-icon"><IcoFolder /></span>
                  <input
                    list="task-context-options"
                    className="task-add-context-input"
                    placeholder="Type or select context"
                    value={addContextInput}
                    onChange={(e) => {
                      const value = e.target.value;
                      setAddContextInput(value);
                      const matched = resolveExistingContextOption(value);
                      setAddDraft((p) => ({ ...p, context: matched?.projectId || "" }));
                    }}
                  />
                  <datalist id="task-context-options">
                    {projectOptions.map((p) => (
                      <option key={p.projectId} value={p.projectName || p.projectId} />
                    ))}
                  </datalist>
                </label>
                <label className="task-add-select task-add-select-load">
                  <span className="task-add-select-icon">#</span>
                  <input type="number" min={0} max={10} value={addDraft.baseLoadScore}
                    onChange={(e) => setAddDraft((p) => ({ ...p, baseLoadScore: Number(e.target.value) }))} />
                </label>
                {addDraft.recurrence === "ONCE" && (
                  <label className="task-add-select task-add-select-date">
                    <span className="task-add-select-icon"><IcoCalSmall /></span>
                    <input type="date" value={addDraft.dueDate}
                      onChange={(e) => setAddDraft((p) => ({ ...p, dueDate: e.target.value }))} />
                  </label>
                )}
              </div>
              <button type="button" className="task-add-more-btn" onClick={() => setAddAdvancedOpen((prev) => !prev)}>
                <span className={addAdvancedOpen ? "task-add-more-chevron open" : "task-add-more-chevron"}><IcoChevron /></span>
                More options
              </button>
              {addAdvancedOpen && (
                <div className="task-add-advanced-grid">
                  <div className="edit-section task-add-advanced-span">
                    <div className="edit-section-label">Recurrence</div>
                    <select className="edit-input" value={addDraft.recurrence}
                      onChange={(e) => {
                        const recurrence = e.target.value as RecurrenceType;
                        setAddDraft((p) => ({
                          ...p,
                          recurrence,
                          dueDate: recurrence === "ONCE" ? p.dueDate : "",
                          activeFrom: recurrence === "ONCE" ? "" : p.activeFrom,
                          activeUntil: recurrence === "ONCE" ? "" : p.activeUntil
                        }));
                      }}>
                      {RECURRENCE_TYPES.map((r) => <option key={r} value={r}>{RECURRENCE_LABELS[r]}</option>)}
                    </select>
                  </div>
                  {addDraft.recurrence === "WEEKLY" && (
                    <div className="edit-section task-add-advanced-span">
                      <div className="weekday-picker">
                        {(["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const).map((d, i) => (
                          <button key={d} type="button"
                            className={addDraft[d] ? "weekday-btn active" : "weekday-btn"}
                            onClick={() => setAddDraft((p) => ({ ...p, [d]: !p[d] }))}>
                            {weekdays[i]}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {addDraft.recurrence === "EVERY_N_DAYS" && (
                    <div className="edit-section task-add-advanced-span">
                      <div className="edit-section-label">Every N Days</div>
                      <input type="number" min={1} className="edit-input" value={addDraft.intervalDays}
                        onChange={(e) => setAddDraft((p) => ({ ...p, intervalDays: Number(e.target.value) }))} />
                    </div>
                  )}
                  {addDraft.recurrence === "MONTHLY_DAY" && (
                    <div className="edit-section">
                      <div className="edit-section-label">Day of Month</div>
                      <input type="number" min={1} max={31} className="edit-input" value={addDraft.monthDay}
                        onChange={(e) => setAddDraft((p) => ({ ...p, monthDay: Number(e.target.value) }))} />
                    </div>
                  )}
                  {addDraft.recurrence === "MONTHLY_NTH_WEEKDAY" && (
                    <>
                      <div className="edit-section">
                        <div className="edit-section-label">Nth Week</div>
                        <input type="number" min={1} max={5} className="edit-input" value={addDraft.nthInMonth}
                          onChange={(e) => setAddDraft((p) => ({ ...p, nthInMonth: Number(e.target.value) }))} />
                      </div>
                      <div className="edit-section">
                        <div className="edit-section-label">Weekday</div>
                        <select className="edit-input" value={addDraft.weekdayMon1}
                          onChange={(e) => setAddDraft((p) => ({ ...p, weekdayMon1: Number(e.target.value) }))}>
                          {weekdays.map((d, i) => <option key={d} value={i}>{d}</option>)}
                        </select>
                      </div>
                    </>
                  )}
                  {addDraft.recurrence !== "ONCE" && (
                    <>
                      <div className="edit-section">
                        <div className="edit-section-label">Active From</div>
                        <input type="date" className="edit-input" value={addDraft.activeFrom}
                          onChange={(e) => setAddDraft((p) => ({ ...p, activeFrom: e.target.value }))} />
                      </div>
                      <div className="edit-section">
                        <div className="edit-section-label">Active Until</div>
                        <input type="date" className="edit-input" value={addDraft.activeUntil}
                          onChange={(e) => setAddDraft((p) => ({ ...p, activeUntil: e.target.value }))} />
                      </div>
                    </>
                  )}
                  <div className="edit-two-col task-add-advanced-span">
                    <div className="edit-section">
                      <div className="edit-section-label">Start Time</div>
                      <input type="time" className="edit-input" value={addDraft.startTime}
                        onChange={(e) => setAddDraft((p) => ({ ...p, startTime: e.target.value }))} />
                    </div>
                    <div className="edit-section">
                      <div className="edit-section-label">End Time</div>
                      <input type="time" className="edit-input" value={addDraft.endTime}
                        onChange={(e) => setAddDraft((p) => ({ ...p, endTime: e.target.value }))} />
                    </div>
                  </div>
                  <div className="edit-section">
                    <div className="edit-section-label">Timezone</div>
                    <input className="edit-input" value={addDraft.timezone}
                      onChange={(e) => setAddDraft((p) => ({ ...p, timezone: e.target.value }))} />
                  </div>
                  <div className="edit-section task-add-advanced-notes">
                    <div className="edit-section-label">Notes</div>
                    <textarea className="edit-input" value={addDraft.notes}
                      onChange={(e) => setAddDraft((p) => ({ ...p, notes: e.target.value }))} />
                  </div>
                </div>
              )}
              <div className="task-add-actions">
                <button type="button" className="task-add-cancel"
                  onClick={() => { setShowAddPanel(false); setAddAdvancedOpen(false); setAddContextInput(""); }}>Cancel</button>
                <button type="button" className="task-add-submit" onClick={handleAddTask} disabled={isSaving}>
                  {isSaving ? "Creating..." : "Add Task"}
                </button>
              </div>
            </div>
          </div>
        )}
        {sidebarMode === "list" ? (
          /* ── Task List ── */
          <section className="task-list-section">
            {((quickFilter === "planned" || quickFilter === "overdue")
              ? occurrenceRowsOrdered.length === 0
              : filteredTasks.length === 0) && !isLoading && (
              <div style={{ textAlign: "center", opacity: 0.35, padding: "3rem 0" }}>
                <IcoPlus />
                <p style={{ margin: "0.5rem 0 0", fontSize: "0.7rem", fontWeight: 900, textTransform: "uppercase", letterSpacing: "0.15em" }}>No Tasks</p>
              </div>
            )}
            {(quickFilter === "planned" || quickFilter === "overdue") ? (
              <>
                {occurrenceDateGroups.map((group) => (
                  <article key={group.date} className="task-date-group">
                    <header>
                      <h4>{formatDateHeading(group.date)}</h4>
                      <small>{group.rows.length}</small>
                    </header>
                    <ul>
                      {group.rows.map((row) => {
                        const masterTask = tasks.find((task) => task.id === row.taskId);
                        const contextName = resolveContextDisplayName(row.context, masterTask?.contextName);
                        const selected = selectedOccurrenceKeys.has(row.key);
                        const itemClass = [
                          selectedTaskId === row.taskId ? "task-list-item active" : "task-list-item",
                          selected ? "occurrence-selected" : ""
                        ].filter(Boolean).join(" ");
                        return (
                          <li key={row.key}>
                            <div className={itemClass}>
                              <button
                                type="button"
                                className="task-circle"
                                onClick={() => void handleToggleOccurrenceDone(row)}
                                aria-label="Toggle done"
                              >
                                <StatusCircle status={row.status} />
                              </button>
                              <button
                                type="button"
                                className="task-list-main"
                                onClick={(event) => handleOccurrenceClick(event, row)}
                                onContextMenu={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  ensureContextSelection(row, event.clientX, event.clientY);
                                }}
                              >
                                <span className={`task-title${row.status === "done" ? " done" : ""}`}>{row.title}</span>
                                <span className="task-meta-row">
                                  {typeof row.load === "number" && (
                                    <span className="load-badge" style={{ color: loadScoreColor(row.load), borderColor: loadScoreColor(row.load) }}>
                                      <IcoZap />{row.load}
                                    </span>
                                  )}
                                  <span className="context-badge" style={{ color: contextColor(row.context) }}>
                                    {contextName}
                                  </span>
                                  {(row.startTime || row.endTime) && (
                                    <span className="time-badge">
                                      <IcoClock />
                                      {row.startTime || "--:--"}{row.endTime ? ` - ${row.endTime}` : ""}
                                    </span>
                                  )}
                                  {row.isLocked && (
                                    <span style={{ color: "#fbbf24" }}><IcoLock /></span>
                                  )}
                                </span>
                              </button>
                              <span style={{ color: "#374151", flexShrink: 0 }}><IcoChevron /></span>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </article>
                ))}
                {occurrenceLoading && (
                  <p style={{ color: "#64748b", fontSize: "0.74rem", margin: "0.5rem 0 0.25rem" }}>Loading more...</p>
                )}
              </>
            ) : (
              groupedTasks.map((group) => (
                <article key={group.context} className="task-project-block">
                  <header>
                    <h4 style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: contextColor(group.context), display: "inline-block", flexShrink: 0 }} />
                      {group.contextName}
                    </h4>
                    <small>{group.tasks.length}</small>
                  </header>
                  <ul>
                    {group.tasks.map((task) => (
                      <li key={task.id}>
                        <div className={selectedTaskId === task.id ? "task-list-item active" : "task-list-item"}>
                          {/* Status circle */}
                          <button type="button" className="task-circle"
                            onClick={() => void handleToggleDone(task)}
                            aria-label="Toggle done">
                            <StatusCircle status={task.status} />
                          </button>

                          {/* Main content */}
                          <button type="button" className="task-list-main" onClick={() => selectTask(task)}>
                            <span className={`task-title${task.status === "done" ? " done" : ""}`}>{task.title}</span>
                            <span className="task-meta-row">
                              {/* Load score badge */}
                              <span className="load-badge" style={{ color: loadScoreColor(task.baseLoadScore), borderColor: loadScoreColor(task.baseLoadScore) }}>
                                <IcoZap />{task.baseLoadScore}
                              </span>
                              {/* Context tag */}
                              <span className="context-badge" style={{ color: contextColor(task.context) }}>
                                {resolveContextDisplayName(task.context, task.contextName)}
                              </span>
                              {/* Recurrence */}
                              {task.recurrence !== "ONCE" && (
                                <span className="recurrence-badge"><IcoRepeat />{task.recurrence.replace(/_/g, " ")}</span>
                              )}
                              {/* Time */}
                              {task.startTime && (
                                <span className="time-badge"><IcoClock />{task.startTime}{task.endTime ? ` - ${task.endTime}` : ""}</span>
                              )}
                              {/* Due date */}
                              {task.dueDate && (
                                <span className="due-badge">{task.dueDate}</span>
                              )}
                              {/* Lock */}
                              {task.isLocked && (
                                <span style={{ color: "#fbbf24" }}><IcoLock /></span>
                              )}
                            </span>
                          </button>
                          <button
                            type="button"
                            className={task.isPinned ? "task-pin-button active" : "task-pin-button"}
                            onClick={() => void handleTogglePin(task)}
                            title={task.isPinned ? "Unpin from My Day" : "Pin to My Day"}
                            aria-label={task.isPinned ? "Unpin from My Day" : "Pin to My Day"}
                          >
                            <IcoPin />
                          </button>
                          <span style={{ color: "#374151", flexShrink: 0 }}><IcoChevron /></span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </article>
              ))
            )}
            {(quickFilter === "planned" || quickFilter === "overdue") && occurrenceMenu.visible && (
              <div
                className="task-occurrence-menu"
                style={{ top: occurrenceMenu.y, left: occurrenceMenu.x }}
                onClick={(event) => event.stopPropagation()}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
              >
                <button type="button" onClick={() => void handleMarkSelectedOccurrences("done")}>Mark as Done</button>
                <button type="button" onClick={() => void handleMarkSelectedOccurrences("skipped")}>Skip this occurrence</button>
                <button type="button" onClick={() => void handleMoveSelectedOccurrences()}>Move to date</button>
                <button type="button" className="danger" onClick={() => void handleDeleteSelectedFromMenu()}>Delete</button>
              </div>
            )}
          </section>
        ) : (
          /* ── Calendar view ── */
          <section className="task-calendar-shell">
            {calendarMode === "month" ? (
              <>
                <div className="calendar-weekdays">
                  {weekdays.map((d) => <span key={d}>{d}</span>)}
                </div>
                <div className="calendar-month-grid">
                  {monthCells.map((cell) => {
                    const key = `${cell.date.getFullYear()}-${cell.date.getMonth()}-${cell.date.getDate()}`;
                    const dayTasks = tasksByDate.get(key) || [];
                    const isToday = isSameDay(cell.date, today);
                    return (
                      <div key={cell.key}
                        className={["calendar-cell", !cell.inCurrentMonth ? "muted" : "", isToday ? "is-today" : ""].filter(Boolean).join(" ")}
                        onClick={() => setDayDetailDate(cell.date)}
                        style={{ cursor: "pointer" }}>
                        <strong>{cell.date.getDate()}</strong>
                        {dayTasks.slice(0, 3).map((t) => (
                          <button key={t.id} type="button" className={`calendar-task-pill${t.status === "done" ? " done" : ""}`}
                            onClick={(e) => { e.stopPropagation(); selectTask(t); }}>{t.title}</button>
                        ))}
                        {dayTasks.length > 3 && <small style={{ color: "#6b7280", fontSize: "0.62rem" }}>+{dayTasks.length - 3}</small>}
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="calendar-week-timeline">
                <div className="calendar-week-timeline-head">
                  <div className="calendar-week-time-col calendar-week-time-col-head">
                    <IcoClock />
                  </div>
                  {weekDays.map((day) => {
                    const isTodayHeader = isSameDay(day, today);
                    return (
                      <div
                        key={`head-${day.toISOString()}`}
                        className={isTodayHeader ? "calendar-week-day-head is-today" : "calendar-week-day-head"}
                      >
                        <small>{weekdays[day.getDay()]}</small>
                        <strong>{day.getDate()}</strong>
                      </div>
                    );
                  })}
                </div>

                <div className="calendar-week-all-day-row">
                  <div className="calendar-week-time-col calendar-week-all-day-label">All Day</div>
                  {weekDays.map((day) => {
                    const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
                    const dayTasks = tasksByDate.get(key) || [];
                    const allDayTasks = dayTasks.filter((task) => !task.startTime && !task.endTime);
                    return (
                      <div key={`all-day-${day.toISOString()}`} className="calendar-week-all-day-cell">
                        {allDayTasks.slice(0, 3).map((task) => (
                          <button
                            key={task.id}
                            type="button"
                            className={`calendar-task-pill${task.status === "done" ? " done" : ""}`}
                            onClick={() => selectTask(task)}
                            title={task.title}
                          >
                            {task.title}
                          </button>
                        ))}
                        {allDayTasks.length > 3 ? (
                          <small className="calendar-week-more">+{allDayTasks.length - 3}</small>
                        ) : null}
                      </div>
                    );
                  })}
                </div>

                <div className="calendar-week-scroll" ref={weekTimelineScrollRef}>
                  <div className="calendar-week-grid">
                    <div className="calendar-week-time-axis" style={{ height: timelineBodyHeight }}>
                      {timelineHours.map((hour) => (
                        <span
                          key={`time-${hour}`}
                          className="calendar-week-time-label"
                          style={{ top: (hour - TIMELINE_START_HOUR) * TIMELINE_HOUR_HEIGHT }}
                        >
                          {hourLabel(hour)}
                        </span>
                      ))}
                    </div>

                    {weekDays.map((day) => {
                      const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
                      const dayTasks = tasksByDate.get(key) || [];
                      const isCurrentDay = isSameDay(day, nowDay);
                      const showNowLine = isCurrentDay
                        && nowMinuteOfDay >= (TIMELINE_START_HOUR * 60)
                        && nowMinuteOfDay <= (TIMELINE_END_HOUR * 60);
                      const nowLineTop = ((nowMinuteOfDay - (TIMELINE_START_HOUR * 60)) / 60) * TIMELINE_HOUR_HEIGHT;
                      const timedTasks = dayTasks
                        .filter((task) => task.startTime || task.endTime)
                        .sort((a, b) => {
                          const aStart = parseTimeToMinutes(a.startTime) ?? 0;
                          const bStart = parseTimeToMinutes(b.startTime) ?? 0;
                          return aStart - bStart;
                        });

                      const laidOutTimedTasks = timedTasks
                        .map((task) => {
                          const startMinuteRaw = parseTimeToMinutes(task.startTime);
                          const endMinuteRaw = parseTimeToMinutes(task.endTime);
                          const fallbackStart = endMinuteRaw !== null
                            ? Math.max((TIMELINE_START_HOUR * 60), endMinuteRaw - 60)
                            : (TIMELINE_START_HOUR * 60);
                          const startMinute = startMinuteRaw ?? fallbackStart;
                          const fallbackEnd = Math.min((TIMELINE_END_HOUR * 60), startMinute + 60);
                          const rawEnd = endMinuteRaw ?? fallbackEnd;

                          const clippedStart = Math.max(TIMELINE_START_HOUR * 60, Math.min(startMinute, TIMELINE_END_HOUR * 60));
                          const boundedEnd = Math.max(clippedStart + 30, rawEnd);
                          const clippedEnd = Math.min(TIMELINE_END_HOUR * 60, boundedEnd);

                          if (clippedStart >= TIMELINE_END_HOUR * 60 || clippedEnd <= TIMELINE_START_HOUR * 60) {
                            return null;
                          }

                          const top = ((clippedStart - (TIMELINE_START_HOUR * 60)) / 60) * TIMELINE_HOUR_HEIGHT;
                          const height = Math.max(22, ((clippedEnd - clippedStart) / 60) * TIMELINE_HOUR_HEIGHT);
                          const timeLabel = task.startTime
                            ? `${task.startTime}${task.endTime ? ` - ${task.endTime}` : ""}`
                            : `${hourLabel(Math.floor(clippedStart / 60))}`;

                          return {
                            task,
                            clippedStart,
                            clippedEnd,
                            top,
                            height,
                            timeLabel,
                            lane: 0,
                            laneCount: 1
                          };
                        })
                        .filter((item): item is {
                          task: Task;
                          clippedStart: number;
                          clippedEnd: number;
                          top: number;
                          height: number;
                          timeLabel: string;
                          lane: number;
                          laneCount: number;
                        } => item !== null)
                        .sort((a, b) => {
                          if (a.clippedStart !== b.clippedStart) return a.clippedStart - b.clippedStart;
                          return a.clippedEnd - b.clippedEnd;
                        });

                      const activeEvents: Array<{ lane: number; end: number }> = [];
                      let clusterIndexes: number[] = [];
                      let clusterMaxLanes = 1;

                      for (let index = 0; index < laidOutTimedTasks.length; index++) {
                        const event = laidOutTimedTasks[index];

                        for (let activeIndex = activeEvents.length - 1; activeIndex >= 0; activeIndex--) {
                          if (activeEvents[activeIndex].end <= event.clippedStart) {
                            activeEvents.splice(activeIndex, 1);
                          }
                        }

                        if (activeEvents.length === 0 && clusterIndexes.length > 0) {
                          for (const clusterIndex of clusterIndexes) {
                            laidOutTimedTasks[clusterIndex].laneCount = clusterMaxLanes;
                          }
                          clusterIndexes = [];
                          clusterMaxLanes = 1;
                        }

                        const usedLanes = new Set(activeEvents.map((active) => active.lane));
                        let lane = 0;
                        while (usedLanes.has(lane)) lane++;

                        event.lane = lane;
                        activeEvents.push({ lane, end: event.clippedEnd });
                        clusterIndexes.push(index);
                        clusterMaxLanes = Math.max(clusterMaxLanes, lane + 1);
                      }

                      if (clusterIndexes.length > 0) {
                        for (const clusterIndex of clusterIndexes) {
                          laidOutTimedTasks[clusterIndex].laneCount = clusterMaxLanes;
                        }
                      }

                      return (
                        <div
                          key={`time-col-${day.toISOString()}`}
                          className="calendar-week-day-column"
                          style={{ height: timelineBodyHeight }}
                        >
                          {timelineHours.map((hour) => (
                            <span
                              key={`${day.toISOString()}-line-${hour}`}
                              className="calendar-week-hour-line"
                              style={{ top: (hour - TIMELINE_START_HOUR) * TIMELINE_HOUR_HEIGHT }}
                            />
                          ))}

                          {showNowLine ? (
                            <span className="calendar-week-now-line" style={{ top: nowLineTop }} />
                          ) : null}

                          {laidOutTimedTasks.map((event, eventIndex) => {
                            const contextDisplay = resolveContextDisplayName(event.task.context, event.task.contextName);
                            const laneWidthPercent = 100 / event.laneCount;
                            const laneLeftPercent = laneWidthPercent * event.lane;
                            const compactClass = event.height < 44
                              ? " title-only"
                              : event.height < 64
                                ? " title-priority"
                                : "";

                            return (
                              <button
                                key={`${event.task.id}-${eventIndex}`}
                                type="button"
                                className={`calendar-week-event-block${event.task.status === "done" ? " done" : ""}${compactClass}`}
                                style={{
                                  top: event.top,
                                  height: event.height,
                                  left: `calc(${laneLeftPercent}% + 2px)`,
                                  width: `calc(${laneWidthPercent}% - 4px)`,
                                  zIndex: event.lane + 1
                                }}
                                onClick={() => selectTask(event.task)}
                                title={`${event.task.title} (${event.timeLabel})`}
                              >
                                <strong>{event.task.title}</strong>
                                <span>{contextDisplay}</span>
                                <small className="calendar-week-event-time">{event.timeLabel}</small>
                              </button>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
            {isAuthError && (
              <div className="calendar-state-card">
                <h4>Sign in required</h4>
                <p>Sign in to view your tasks calendar.</p>
                <button type="button" onClick={() => void load()}>Retry</button>
              </div>
            )}
            {!isLoading && !isAuthError && !hasTasksInVisiblePeriod && (
              <div className="calendar-empty-hint">
                <p>No tasks scheduled for this period.</p>
              </div>
            )}
          </section>
        )}
      </div>

      {/* ── Calendar day detail panel ─────────────────── */}
      {dayDetailDate && (
        <>
          <div className="day-tasks-backdrop" onClick={() => setDayDetailDate(null)} />
          <div className="day-tasks-panel">
            <div className="day-tasks-head">
              <div>
                <h3>Day Tasks</h3>
                <p>{dayDetailDate.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</p>
              </div>
              <button type="button" className="tasks-detail-close" onClick={() => setDayDetailDate(null)}><IcoX /></button>
            </div>
            <div className="day-tasks-body">
              {dayDetailTasks.length === 0 ? (
                <div className="day-tasks-empty">
                  <IcoPlus />
                  <p>Clear Schedule</p>
                </div>
              ) : dayDetailTasks.map((t) => (
                <div key={t.id} className="day-task-card" onClick={() => { selectTask(t); setDayDetailDate(null); }}>
                  <div className="day-task-card-top">
                    <div className={`day-task-card-status${t.status === "done" ? " done" : ""}`}>
                      <StatusCircle status={t.status} />
                    </div>
                    <span className={`day-task-card-name${t.status === "done" ? " done" : ""}`}>{t.title}</span>
                  </div>
                  <div className="day-task-card-meta">
                    <span className="day-task-card-context" style={{ color: contextColor(t.context) }}>
                      {resolveContextDisplayName(t.context, t.contextName)}
                    </span>
                    <span className="day-task-card-priority">
                      <IcoZap /> {t.baseLoadScore}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ── Right edit detail panel ─────────────────────── */}
      {selectedTask && (
        <button
          type="button"
          className="tasks-detail-backdrop"
          onClick={clearDetail}
          aria-label="Close detail panel"
        />
      )}
      {selectedTask && (
        <aside className="tasks-detail">
          <div className="tasks-detail-head">
            <div className="tasks-detail-head-left">
              <div className="tasks-detail-dot" />
              <input
                className="tasks-detail-title-input"
                value={draft.title}
                onChange={(e) => setDraft((p) => ({ ...p, title: e.target.value }))}
                placeholder="Task title"
                aria-label="Task title"
              />
            </div>
            <button type="button" className="tasks-detail-close" onClick={clearDetail} aria-label="Close">
              <IcoX />
            </button>
          </div>

          <div className="tasks-detail-body">
            {displayError ? <p className="error" style={{ margin: 0, fontSize: "0.8rem" }}>{displayError}</p> : null}

            {/* Status + Lock row */}
            <div className="edit-section">
              <div className="status-lock-row">
                <div className="status-toggle-row">
                  {TASK_STATUSES.map((s) => (
                    <button key={s} type="button"
                      className={draft.status === s ? `status-toggle active ${s}` : "status-toggle"}
                      onClick={() => setDraft((p) => ({ ...p, status: s }))}>
                      <span className="status-toggle-icon" />
                      {s}
                    </button>
                  ))}
                </div>
                <button type="button"
                  className={draft.isLocked ? "lock-toggle compact active" : "lock-toggle compact"}
                  onClick={() => setDraft((p) => ({ ...p, isLocked: !p.isLocked }))}>
                  {draft.isLocked ? <><IcoLock /> Lock</> : <><IcoUnlock /> Lock</>}
                </button>
              </div>
            </div>

            {/* Context + Load Score */}
            <div className="edit-two-col">
              <div className="edit-section">
                <div className="edit-section-label">Context</div>
                <select className="edit-input" value={draft.context}
                  onChange={(e) => setDraft((p) => ({ ...p, context: e.target.value }))}>
                  <option value="">Select context</option>
                  {projectOptions.map((p) => (
                    <option key={p.projectId} value={p.projectId}>{p.projectName || p.projectId}</option>
                  ))}
                </select>
              </div>
              <div className="edit-section">
                <div className="edit-section-label">Load (0 E0)</div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  <input type="range" min={0} max={10} step={1} value={draft.baseLoadScore}
                    onChange={(e) => setDraft((p) => ({ ...p, baseLoadScore: Number(e.target.value) }))}
                    style={{ flex: 1 }} />
                  <span className="load-badge"
                    style={{ color: loadScoreColor(draft.baseLoadScore), borderColor: loadScoreColor(draft.baseLoadScore), flexShrink: 0 }}>
                    {draft.baseLoadScore}
                  </span>
                </div>
              </div>
            </div>

            {/* Recurrence */}
            <div className="edit-section">
              <div className="edit-section-label">Recurrence</div>
              <select className="edit-input" value={draft.recurrence}
                onChange={(e) => setDraft((p) => ({ ...p, recurrence: e.target.value as RecurrenceType }))}>
                {RECURRENCE_TYPES.map((r) => <option key={r} value={r}>{RECURRENCE_LABELS[r]}</option>)}
              </select>
            </div>

            {/* Weekly day picker */}
            {draft.recurrence === "WEEKLY" && (
              <div className="edit-section">
                <div className="edit-section-label">Days</div>
                <div className="weekday-picker">
                  {(["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const).map((d, i) => (
                    <button key={d} type="button"
                      className={draft[d] ? "weekday-btn active" : "weekday-btn"}
                      onClick={() => setDraft((p) => ({ ...p, [d]: !p[d] }))}>
                      {weekdays[i]}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Every N days */}
            {draft.recurrence === "EVERY_N_DAYS" && (
              <div className="edit-section">
                <div className="edit-section-label">Every N Days</div>
                <input type="number" min={1} className="edit-input" value={draft.intervalDays}
                  onChange={(e) => setDraft((p) => ({ ...p, intervalDays: Number(e.target.value) }))} />
              </div>
            )}

            {/* Monthly fields */}
            {draft.recurrence === "MONTHLY_DAY" && (
              <div className="edit-section">
                <div className="edit-section-label">Day of Month</div>
                <input type="number" min={1} max={31} className="edit-input" value={draft.monthDay}
                  onChange={(e) => setDraft((p) => ({ ...p, monthDay: Number(e.target.value) }))} />
              </div>
            )}
            {draft.recurrence === "MONTHLY_NTH_WEEKDAY" && (
              <div className="edit-two-col">
                <div className="edit-section">
                  <div className="edit-section-label">Nth Week</div>
                  <input type="number" min={1} max={5} className="edit-input" value={draft.nthInMonth}
                    onChange={(e) => setDraft((p) => ({ ...p, nthInMonth: Number(e.target.value) }))} />
                </div>
                <div className="edit-section">
                  <div className="edit-section-label">Weekday</div>
                  <select className="edit-input" value={draft.weekdayMon1}
                    onChange={(e) => setDraft((p) => ({ ...p, weekdayMon1: Number(e.target.value) }))}>
                    {weekdays.map((d, i) => <option key={d} value={i}>{d}</option>)}
                  </select>
                </div>
              </div>
            )}

            {/* Due Date (ONCE only) */}
            {draft.recurrence === "ONCE" && (
              <div className="edit-section">
                <div className="edit-section-label">Due Date</div>
                <input type="date" className="edit-input" value={draft.dueDate}
                  onChange={(e) => setDraft((p) => ({ ...p, dueDate: e.target.value }))} />
              </div>
            )}

            {/* Start / End time */}
            <div className="edit-two-col">
              <div className="edit-section">
                <div className="edit-section-label">Start Time</div>
                <input type="time" className="edit-input" value={draft.startTime}
                  onChange={(e) => setDraft((p) => ({ ...p, startTime: e.target.value }))} />
              </div>
              <div className="edit-section">
                <div className="edit-section-label">End Time</div>
                <input type="time" className="edit-input" value={draft.endTime}
                  onChange={(e) => setDraft((p) => ({ ...p, endTime: e.target.value }))} />
              </div>
            </div>

            {/* Timezone */}
            <div className="edit-section">
              <div className="edit-section-label">Timezone</div>
              <input className="edit-input" value={draft.timezone}
                onChange={(e) => setDraft((p) => ({ ...p, timezone: e.target.value }))}
                placeholder="e.g. Asia/Tokyo" />
            </div>

            {/* Notes */}
            <div className="edit-section">
              <div className="edit-section-label">Notes</div>
              <textarea className="edit-input" rows={4} value={draft.notes}
                onChange={(e) => setDraft((p) => ({ ...p, notes: e.target.value }))}
                placeholder="Notes..." />
            </div>

            {/* Advanced settings */}
            <div className="edit-section">
              <button type="button" className="history-toggle" onClick={() => setAdvancedOpen((v) => !v)}>
                <IcoHistory />
                <span>Advanced Setting</span>
                <span style={{ marginLeft: "auto", transform: advancedOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.15s" }}><IcoChevronDown /></span>
              </button>
              {advancedOpen && (
                <div className="history-body advanced-body">
                  {draft.recurrence !== "ONCE" && (
                    <div className="edit-two-col" style={{ padding: "0 0.2rem 0.45rem" }}>
                      <div className="edit-section">
                        <div className="edit-section-label">Active From</div>
                        <input type="date" className="edit-input" value={draft.activeFrom}
                          onChange={(e) => setDraft((p) => ({ ...p, activeFrom: e.target.value }))} />
                      </div>
                      <div className="edit-section">
                        <div className="edit-section-label">Active Until</div>
                        <input type="date" className="edit-input" value={draft.activeUntil}
                          onChange={(e) => setDraft((p) => ({ ...p, activeUntil: e.target.value }))} />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Timestamps */}
            <div className="edit-timestamps">
              <small>Created: {formatDateTime(selectedTask.createdAt)}</small>
              <small>Updated: {formatDateTime(selectedTask.updatedAt)}</small>
            </div>

            {/* Execution History */}
            <div className="edit-section">
              <button type="button" className="history-toggle" onClick={handleHistoryToggle}>
                <IcoHistory />
                <span>Execution History</span>
                <span style={{ marginLeft: "auto" }}><IcoChevronDown /></span>
              </button>
              {historyOpen && (
                <div className="history-body">
                  {historyLoading ? (
                    <p style={{ color: "#6b7280", fontSize: "0.75rem", margin: "0.5rem 0" }}>Loading...</p>
                  ) : history.length === 0 ? (
                    <p style={{ color: "#4b5563", fontSize: "0.75rem", margin: "0.5rem 0" }}>No history found.</p>
                  ) : history.map((h, i) => (
                    <div key={i} className="history-entry">
                      <span className="history-date">{h.targetDate}</span>
                      <span className={`history-status ${h.status}`}>{h.status}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="edit-footer">
            <button type="button" className="edit-delete-btn" onClick={handleDeleteDetail} disabled={isSaving} title="Delete task">
              <IcoTrash />
            </button>
            <div className="edit-footer-actions">
              <button type="button" className="ghost-button" onClick={clearDetail} disabled={isSaving}
                style={{ fontSize: "0.8rem", padding: "0.4rem 0.8rem" }}>
                Cancel
              </button>
              <button type="button" className="edit-save-btn" onClick={handleSaveDetail} disabled={isSaving}>
                {isSaving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </aside>
      )}
    </section>
  );
}
