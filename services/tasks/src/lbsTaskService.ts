import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LbsClient, type LbsClientConfig } from "./lbsClient.js";
import type { RecurrenceType, Task, TaskStatus } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadEnv({ path: path.resolve(__dirname, "../.env") });

const defaultTimezone = "Asia/Tokyo";

export interface LbsTask {
  task_id: string;
  task_name: string;
  context: string;
  base_load_score: number;
  active: boolean;
  rule_type: string;
  due_date?: string | null;
  notes?: string | null;
  status?: string | null;
  is_locked?: boolean | null;
  start_time?: string | null;
  end_time?: string | null;
  created_at?: string;
  updated_at?: string;
  timezone?: string | null;
  meta_payload?: Record<string, unknown>;
  mon?: boolean | null;
  tue?: boolean | null;
  wed?: boolean | null;
  thu?: boolean | null;
  fri?: boolean | null;
  sat?: boolean | null;
  sun?: boolean | null;
  interval_days?: number | null;
  anchor_date?: string | null;
  month_day?: number | null;
  nth_in_month?: number | null;
  weekday_mon1?: number | null;
  start_date?: string | null;
  end_date?: string | null;
}

interface LbsHistoryEntry {
  id?: string | number;
  task_id?: string;
  target_date?: string;
  status?: string;
  created_at?: string;
}

interface LbsResolvedTask {
  status?: string | null;
}

export interface LbsConfig {
  baseUrl: string;
  authBaseUrl: string;
  authLoginPath: string;
  authUserCreatePath: string;
  accountPasswordSeed: string;
  apiKey?: string;
  token?: string;
  timezone: string;
  forceOverride: boolean;
  defaultActive: boolean;
}

function toClientConfig(config: LbsConfig): LbsClientConfig {
  return {
    baseUrl: config.baseUrl,
    authBaseUrl: config.authBaseUrl,
    authLoginPath: config.authLoginPath,
    authUserCreatePath: config.authUserCreatePath,
    timezone: config.timezone,
    apiKey: config.apiKey,
    sharedToken: config.token
  };
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getLbsConfig(): LbsConfig {
  const baseUrl = requireEnv("TASKS_LBS_BASE_URL").replace(/\/+$/, "");
  const authBaseUrl = (process.env.TASKS_LBS_AUTH_BASE_URL?.trim() || baseUrl).replace(/\/+$/, "");
  const authLoginPath = process.env.TASKS_LBS_AUTH_LOGIN_PATH?.trim() || "/auth/login";
  const authUserCreatePath = process.env.TASKS_LBS_AUTH_USER_CREATE_PATH?.trim() || "/users/";
  const accountPasswordSeed = process.env.TASKS_LBS_ACCOUNT_PASSWORD_SEED?.trim() || "workbench-tasks-lbs-seed";
  const forceOverride = (process.env.TASKS_LBS_FORCE_OVERRIDE ?? "true").toLowerCase() !== "false";
  const defaultActive = (process.env.TASKS_LBS_DEFAULT_ACTIVE ?? "true").toLowerCase() !== "false";

  return {
    baseUrl,
    authBaseUrl,
    authLoginPath,
    authUserCreatePath,
    accountPasswordSeed,
    apiKey: process.env.TASKS_LBS_API_KEY?.trim() || undefined,
    token: process.env.TASKS_LBS_AUTH_TOKEN?.trim() || undefined,
    timezone: process.env.TASKS_LBS_TIMEZONE?.trim() || defaultTimezone,
    forceOverride,
    defaultActive
  };
}

export function createLbsClient(config: LbsConfig, authToken?: string): LbsClient {
  return new LbsClient(toClientConfig(config), authToken);
}

export function toValidRecurrence(value: string | null | undefined): RecurrenceType {
  const valid = ["ONCE", "WEEKLY", "EVERY_N_DAYS", "MONTHLY_DAY", "MONTHLY_NTH_WEEKDAY"] as const;
  if (value && valid.includes(value as RecurrenceType)) return value as RecurrenceType;
  return "ONCE";
}

export function toLbsStatus(status: TaskStatus): "todo" | "done" | "skipped" {
  if (status === "done") return "done";
  if (status === "skipped") return "skipped";
  return "todo";
}

export function toUiStatus(lbsStatus?: string | null): TaskStatus {
  if (lbsStatus === "done") return "done";
  if (lbsStatus === "skipped") return "skipped";
  return "todo";
}

export function toLbsWeekdayMon1(uiWeekday?: number | null): number | undefined {
  if (typeof uiWeekday !== "number" || !Number.isFinite(uiWeekday)) return undefined;
  const normalized = Math.trunc(uiWeekday);
  if (normalized === 0) return 7;
  if (normalized >= 1 && normalized <= 6) return normalized;
  return undefined;
}

export function toUiWeekdayIndex(lbsWeekdayMon1?: number | null): number | undefined {
  if (typeof lbsWeekdayMon1 !== "number" || !Number.isFinite(lbsWeekdayMon1)) return undefined;
  const normalized = Math.trunc(lbsWeekdayMon1);
  if (normalized === 7) return 0;
  if (normalized >= 1 && normalized <= 6) return normalized;
  return undefined;
}

export function toDueDateOnly(value?: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const leadingDate = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/.exec(trimmed);
  if (leadingDate) {
    return `${leadingDate[1]}-${leadingDate[2]}-${leadingDate[3]}`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}

export function todayInTimezone(timezone: string, baseDate: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(baseDate);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    // fall through to UTC fallback
  }
  return new Date().toISOString().slice(0, 10);
}

export function normalizeResponseTask(task: LbsTask): Task {
  const now = new Date().toISOString();
  const context = (task.context || "inbox").trim() || "inbox";
  return {
    id: task.task_id,
    title: task.task_name,
    notes: task.notes || "",
    context,
    contextName: context,
    status: toUiStatus(task.status),
    isLocked: task.is_locked === true,
    baseLoadScore: typeof task.base_load_score === "number" ? task.base_load_score : 1,
    recurrence: toValidRecurrence(task.rule_type),
    dueDate: toDueDateOnly(task.due_date),
    startTime: task.start_time || undefined,
    endTime: task.end_time || undefined,
    timezone: task.timezone || undefined,
    active: task.active !== false,
    activeFrom: toDueDateOnly(task.start_date),
    activeUntil: toDueDateOnly(task.end_date),
    mon: task.mon ?? undefined,
    tue: task.tue ?? undefined,
    wed: task.wed ?? undefined,
    thu: task.thu ?? undefined,
    fri: task.fri ?? undefined,
    sat: task.sat ?? undefined,
    sun: task.sun ?? undefined,
    intervalDays: task.interval_days ?? undefined,
    anchorDate: toDueDateOnly(task.anchor_date),
    monthDay: task.month_day ?? undefined,
    nthInMonth: task.nth_in_month ?? undefined,
    weekdayMon1: toUiWeekdayIndex(task.weekday_mon1),
    createdAt: task.created_at || task.updated_at || now,
    updatedAt: task.updated_at || task.created_at || now
  };
}

export function resolveStatusTargetDate(
  recurrence: RecurrenceType | undefined,
  dueDate: string | undefined,
  timezone: string,
  fallbackTimezone: string
): string {
  if ((recurrence ?? "ONCE") === "ONCE") {
    return toDueDateOnly(dueDate) || todayInTimezone(timezone || fallbackTimezone);
  }
  return todayInTimezone(timezone || fallbackTimezone);
}

function resolveTargetDate(task: Task, fallbackTimezone: string): string {
  return resolveStatusTargetDate(task.recurrence, task.dueDate, task.timezone || fallbackTimezone, fallbackTimezone);
}

export async function applyResolvedStatus(
  task: Task,
  lbsAccessToken: string,
  fallbackTimezone: string,
  overrideDate?: string
): Promise<Task> {
  const targetDate = overrideDate ?? resolveTargetDate(task, fallbackTimezone);
  const config = getLbsConfig();
  const client = createLbsClient(config, lbsAccessToken);
  try {
    const resolved = (await client.resolveTask(task.id, targetDate)) as unknown as LbsResolvedTask;
    return { ...task, status: toUiStatus(resolved.status) };
  } catch {
    try {
      const history = (await client.getTaskHistory(task.id, targetDate, targetDate)) as unknown as LbsHistoryEntry[];
      if (history.length === 0) {
        return task;
      }
      const latest = history
        .slice()
        .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))[0];
      return { ...task, status: toUiStatus(latest.status) };
    } catch {
      return task;
    }
  }
}
