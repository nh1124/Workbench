import { config as loadEnv } from "dotenv";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cacheTasks, listPinnedTaskIds, setTaskPinned, upsertServiceAccount } from "./db.js";
import { LbsClient, type LbsClientConfig, type LbsScheduleDay } from "./lbsClient.js";
import type {
  RecurrenceType,
  Task,
  TaskHistoryEntry,
  TaskInput,
  TaskProjectSummary,
  TaskScheduleDay as TaskScheduleDayModel,
  TaskStatus
} from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadEnv({ path: path.resolve(__dirname, "../.env") });

const defaultTimezone = "Asia/Tokyo";

interface LbsTask {
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

interface LbsConfig {
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

function createLbsClient(config: LbsConfig, authToken?: string): LbsClient {
  return new LbsClient(toClientConfig(config), authToken);
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getLbsConfig(): LbsConfig {
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

function toValidRecurrence(value: string | null | undefined): RecurrenceType {
  const valid = ["ONCE", "WEEKLY", "EVERY_N_DAYS", "MONTHLY_DAY", "MONTHLY_NTH_WEEKDAY"] as const;
  if (value && valid.includes(value as RecurrenceType)) return value as RecurrenceType;
  return "ONCE";
}

function toLbsStatus(status: TaskStatus): "todo" | "done" | "skipped" {
  if (status === "done") return "done";
  if (status === "skipped") return "skipped";
  return "todo";
}

function toUiStatus(lbsStatus?: string | null): TaskStatus {
  if (lbsStatus === "done") return "done";
  if (lbsStatus === "skipped") return "skipped";
  return "todo";
}

function toDueDateOnly(value?: string | null): string | undefined {
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

function todayInTimezone(timezone: string, baseDate: Date = new Date()): string {
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

function normalizeResponseTask(task: LbsTask): Task {
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
    weekdayMon1: task.weekday_mon1 ?? undefined,
    createdAt: task.created_at || task.updated_at || now,
    updatedAt: task.updated_at || task.created_at || now
  };
}

interface LbsAuthTokenResponse {
  accessToken?: string;
  access_token?: string;
  token?: string;
  jwt?: string;
  refreshToken?: string;
  refresh_token?: string;
}

function resolveLbsAccessToken(payload: LbsAuthTokenResponse): { accessToken: string; refreshToken?: string } {
  const accessToken = payload.accessToken ?? payload.access_token ?? payload.token ?? payload.jwt;
  const refreshToken = payload.refreshToken ?? payload.refresh_token;
  if (!accessToken) {
    throw new Error("LBS auth response does not contain access token");
  }
  return { accessToken, refreshToken };
}

function lbsAccountIdentity(coreUserId: string): { email: string; name: string } {
  const compact = coreUserId.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  return {
    email: `wb_${compact}@workbench.local`,
    name: `Workbench ${compact.slice(0, 12)}`
  };
}

function lbsAccountPassword(coreUserId: string): string {
  const config = getLbsConfig();
  return createHash("sha256").update(`${coreUserId.trim().toLowerCase()}:${config.accountPasswordSeed}`).digest("hex");
}

async function authenticateLbsUser(coreUserId: string): Promise<{ accessToken: string; refreshToken?: string }> {
  const config = getLbsConfig();
  const identity = lbsAccountIdentity(coreUserId);
  const password = lbsAccountPassword(coreUserId);

  const login = async (): Promise<{ accessToken: string; refreshToken?: string }> => {
    const url = `${config.authBaseUrl}${config.authLoginPath}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username_or_email: identity.email, password })
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(text || `LBS login failed (${response.status})`);
    }

    let payload: LbsAuthTokenResponse = {};
    if (text.trim()) {
      payload = JSON.parse(text) as LbsAuthTokenResponse;
    }
    return resolveLbsAccessToken(payload);
  };

  const register = async (): Promise<void> => {
    const url = `${config.authBaseUrl}${config.authUserCreatePath}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: identity.email, name: identity.name, password })
    });

    const text = await response.text();
    if (response.ok || response.status === 409) {
      return;
    }
    throw new Error(text || `LBS register failed (${response.status})`);
  };

  try {
    return await login();
  } catch (loginError) {
    try {
      await register();
      return await login();
    } catch (registerError) {
      const loginMessage = loginError instanceof Error ? loginError.message : "login failed";
      const registerMessage = registerError instanceof Error ? registerError.message : "register failed";
      throw new Error(`Failed to provision LBS user (${loginMessage}; ${registerMessage})`);
    }
  }
}

async function authenticateLbsUserLegacy(coreUserId: string): Promise<{ accessToken: string; refreshToken?: string }> {
  const config = getLbsConfig();
  const identity = lbsAccountIdentity(coreUserId);
  const password = lbsAccountPassword(coreUserId);

  const callAuth = async (pathValue: string): Promise<{ accessToken: string; refreshToken?: string }> => {
    const url = `${config.authBaseUrl}${pathValue}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: identity.email, password })
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(text || `LBS auth failed (${response.status})`);
    }

    let payload: LbsAuthTokenResponse = {};
    if (text.trim()) {
      payload = JSON.parse(text) as LbsAuthTokenResponse;
    }
    return resolveLbsAccessToken(payload);
  };

  try {
    return await callAuth(config.authLoginPath);
  } catch (loginError) {
    try {
      return await callAuth("/auth/register");
    } catch (registerError) {
      const loginMessage = loginError instanceof Error ? loginError.message : "login failed";
      const registerMessage = registerError instanceof Error ? registerError.message : "register failed";
      throw new Error(`Failed to provision LBS user (${loginMessage}; ${registerMessage})`);
    }
  }
}

export async function provisionLbsAccount(coreUserId: string, usernameSnapshot: string): Promise<void> {
  let tokens: { accessToken: string; refreshToken?: string };
  try {
    tokens = await authenticateLbsUser(coreUserId);
  } catch (primaryError) {
    // Backward-compatible fallback for environments still exposing /auth/register contract.
    tokens = await authenticateLbsUserLegacy(coreUserId).catch((legacyError) => {
      const primaryMessage = primaryError instanceof Error ? primaryError.message : "primary auth failed";
      const legacyMessage = legacyError instanceof Error ? legacyError.message : "legacy auth failed";
      throw new Error(`LBS provisioning failed (${primaryMessage}; ${legacyMessage})`);
    });
  }
  await upsertServiceAccount(coreUserId, usernameSnapshot, tokens);
}

function resolveStatusTargetDate(
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

async function setTaskCompletion(
  taskId: string,
  lbsAccessToken: string,
  targetDate: string,
  status: TaskStatus = "todo"
): Promise<void> {
  const config = getLbsConfig();
  const client = createLbsClient(config, lbsAccessToken);
  await client.completeTask(taskId, toDueDateOnly(targetDate) || targetDate, toLbsStatus(status));
}

function resolveTargetDate(task: Task, fallbackTimezone: string): string {
  return resolveStatusTargetDate(task.recurrence, task.dueDate, task.timezone || fallbackTimezone, fallbackTimezone);
}

async function applyResolvedStatus(task: Task, lbsAccessToken: string, fallbackTimezone: string): Promise<Task> {
  const targetDate = resolveTargetDate(task, fallbackTimezone);
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

export async function listTasks(
  filters: { projectId?: string; status?: TaskStatus; limit?: number } | undefined,
  ownerUsername: string,
  lbsAccessToken: string
): Promise<Task[]> {
  const config = getLbsConfig();
  const client = createLbsClient(config, lbsAccessToken);
  const tasks = (await client.listTasks(filters?.projectId, config.defaultActive)) as unknown as LbsTask[];
  const mapped = tasks.map(normalizeResponseTask);
  const withResolvedStatuses = await Promise.all(
    mapped.map((task) => applyResolvedStatus(task, lbsAccessToken, config.timezone))
  );
  const pinnedIds = new Set(await listPinnedTaskIds(ownerUsername));
  const withPins = withResolvedStatuses.map((task) => ({ ...task, isPinned: pinnedIds.has(task.id) }));
  const statusFiltered = filters?.status
    ? withPins.filter((task) => task.status === filters.status)
    : withPins;
  const sorted = statusFiltered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const result = filters?.limit && filters.limit > 0 ? sorted.slice(0, filters.limit) : sorted;
  await cacheTasks(result, ownerUsername);
  return result;
}

export async function getTask(id: string, ownerUsername: string, lbsAccessToken: string): Promise<Task | undefined> {
  try {
    const config = getLbsConfig();
    const client = createLbsClient(config, lbsAccessToken);
    const task = (await client.getTask(id)) as unknown as LbsTask;
    const normalized = normalizeResponseTask(task);
    const resolved = await applyResolvedStatus(normalized, lbsAccessToken, config.timezone);
    const pinnedIds = new Set(await listPinnedTaskIds(ownerUsername));
    const taskWithPin = { ...resolved, isPinned: pinnedIds.has(resolved.id) };
    await cacheTasks([taskWithPin], ownerUsername);
    return taskWithPin;
  } catch (error) {
    if (error instanceof Error && error.message.includes("(404)")) {
      return undefined;
    }
    throw error;
  }
}

export async function getTaskHistory(id: string, lbsAccessToken: string): Promise<TaskHistoryEntry[]> {
  try {
    const config = getLbsConfig();
    const client = createLbsClient(config, lbsAccessToken);
    const endDate = todayInTimezone(config.timezone);
    const startBase = new Date();
    startBase.setFullYear(startBase.getFullYear() - 2);
    const startDate = todayInTimezone(config.timezone, startBase);
    const history = (await client.getTaskHistory(id, startDate, endDate)) as unknown as LbsHistoryEntry[];
    return history.map((entry) => ({
      id: entry.id ?? "",
      taskId: entry.task_id ?? id,
      targetDate: entry.target_date ?? "",
      status: entry.status ?? "",
      createdAt: entry.created_at ?? ""
    }));
  } catch {
    return [];
  }
}

function buildLbsPayload(input: TaskInput, config: LbsConfig): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    task_name: input.title.trim(),
    context: input.context.trim(),
    base_load_score: input.baseLoadScore ?? 5,
    rule_type: input.recurrence ?? "ONCE",
    notes: input.notes ?? "",
    active: input.active !== false,
    timezone: input.timezone ?? config.timezone
  };

  if (input.dueDate !== undefined) payload.due_date = input.dueDate || null;
  if (input.startTime !== undefined) payload.start_time = input.startTime || null;
  if (input.endTime !== undefined) payload.end_time = input.endTime || null;
  if (input.isLocked !== undefined) payload.is_locked = input.isLocked;
  if (input.activeFrom !== undefined) payload.start_date = input.activeFrom || null;
  if (input.activeUntil !== undefined) payload.end_date = input.activeUntil || null;
  if (input.mon !== undefined) payload.mon = input.mon;
  if (input.tue !== undefined) payload.tue = input.tue;
  if (input.wed !== undefined) payload.wed = input.wed;
  if (input.thu !== undefined) payload.thu = input.thu;
  if (input.fri !== undefined) payload.fri = input.fri;
  if (input.sat !== undefined) payload.sat = input.sat;
  if (input.sun !== undefined) payload.sun = input.sun;
  if (input.intervalDays !== undefined) payload.interval_days = input.intervalDays;
  if (input.anchorDate !== undefined) payload.anchor_date = input.anchorDate || null;
  // For EVERY_N_DAYS, anchor_date is required; fall back to activeFrom if not explicitly set
  if ((input.recurrence === "EVERY_N_DAYS") && !payload.anchor_date) {
    payload.anchor_date = input.activeFrom || null;
  }
  if (input.monthDay !== undefined) payload.month_day = input.monthDay;
  if (input.nthInMonth !== undefined) payload.nth_in_month = input.nthInMonth;
  if (input.weekdayMon1 !== undefined) payload.weekday_mon1 = input.weekdayMon1;

  return payload;
}

export async function createTask(input: TaskInput, ownerUsername: string, lbsAccessToken: string): Promise<Task> {
  const config = getLbsConfig();
  const client = createLbsClient(config, lbsAccessToken);
  const payload = buildLbsPayload(input, config);

  const created = (await client.createTask(payload)) as unknown as LbsTask;

  // Set initial status via completion endpoint
  const uiStatus = input.status ?? "todo";
  const createStatusTargetDate = resolveStatusTargetDate(
    input.recurrence,
    input.dueDate,
    input.timezone || config.timezone,
    config.timezone
  );
  await setTaskCompletion(created.task_id, lbsAccessToken, createStatusTargetDate, uiStatus);

  const fresh = (await client.getTask(created.task_id)) as unknown as LbsTask;
  const normalized = normalizeResponseTask(fresh);
  const resolved = await applyResolvedStatus(normalized, lbsAccessToken, config.timezone);
  const pinnedIds = new Set(await listPinnedTaskIds(ownerUsername));
  const taskWithPin = { ...resolved, isPinned: pinnedIds.has(resolved.id) };
  await cacheTasks([taskWithPin], ownerUsername);
  return taskWithPin;
}

export async function updateTask(
  id: string,
  updates: Partial<TaskInput>,
  ownerUsername: string,
  lbsAccessToken: string
): Promise<Task | undefined> {
  const config = getLbsConfig();
  const client = createLbsClient(config, lbsAccessToken);

  // Fetch current task first to merge fields
  let current: LbsTask | undefined;
  try {
    current = (await client.getTask(id)) as unknown as LbsTask;
  } catch {
    return undefined;
  }

  const merged: TaskInput = {
    title: updates.title ?? current.task_name,
    notes: updates.notes !== undefined ? updates.notes : (current.notes ?? ""),
    context: updates.context ?? current.context,
    baseLoadScore: updates.baseLoadScore !== undefined ? updates.baseLoadScore : current.base_load_score,
    recurrence: updates.recurrence ?? toValidRecurrence(current.rule_type),
    dueDate: updates.dueDate !== undefined ? (updates.dueDate || undefined) : (toDueDateOnly(current.due_date) ?? undefined),
    startTime: updates.startTime !== undefined ? (updates.startTime || undefined) : (current.start_time ?? undefined),
    endTime: updates.endTime !== undefined ? (updates.endTime || undefined) : (current.end_time ?? undefined),
    timezone: updates.timezone ?? current.timezone ?? config.timezone,
    active: updates.active !== undefined ? updates.active : current.active,
    isLocked: updates.isLocked !== undefined ? updates.isLocked : (current.is_locked ?? false),
    activeFrom: updates.activeFrom !== undefined ? (updates.activeFrom || undefined) : (toDueDateOnly(current.start_date) ?? undefined),
    activeUntil: updates.activeUntil !== undefined ? (updates.activeUntil || undefined) : (toDueDateOnly(current.end_date) ?? undefined),
    mon: updates.mon !== undefined ? updates.mon : (current.mon ?? undefined),
    tue: updates.tue !== undefined ? updates.tue : (current.tue ?? undefined),
    wed: updates.wed !== undefined ? updates.wed : (current.wed ?? undefined),
    thu: updates.thu !== undefined ? updates.thu : (current.thu ?? undefined),
    fri: updates.fri !== undefined ? updates.fri : (current.fri ?? undefined),
    sat: updates.sat !== undefined ? updates.sat : (current.sat ?? undefined),
    sun: updates.sun !== undefined ? updates.sun : (current.sun ?? undefined),
    intervalDays: updates.intervalDays !== undefined ? updates.intervalDays : (current.interval_days ?? undefined),
    anchorDate: updates.anchorDate !== undefined ? (updates.anchorDate || undefined) : (toDueDateOnly(current.anchor_date) ?? undefined),
    monthDay: updates.monthDay !== undefined ? updates.monthDay : (current.month_day ?? undefined),
    nthInMonth: updates.nthInMonth !== undefined ? updates.nthInMonth : (current.nth_in_month ?? undefined),
    weekdayMon1: updates.weekdayMon1 !== undefined ? updates.weekdayMon1 : (current.weekday_mon1 ?? undefined),
    status: updates.status
  };

  const payload = buildLbsPayload(merged, config);

  try {
    await client.updateTask(id, payload, config.forceOverride);

    if (updates.status !== undefined) {
      const updateStatusTargetDate = resolveStatusTargetDate(
        merged.recurrence,
        merged.dueDate,
        merged.timezone || config.timezone,
        config.timezone
      );
      await setTaskCompletion(id, lbsAccessToken, updateStatusTargetDate, updates.status);
    }

    const fresh = (await client.getTask(id)) as unknown as LbsTask;
    const normalized = normalizeResponseTask(fresh);
    const resolved = await applyResolvedStatus(normalized, lbsAccessToken, config.timezone);
    const pinnedIds = new Set(await listPinnedTaskIds(ownerUsername));
    const taskWithPin = { ...resolved, isPinned: pinnedIds.has(resolved.id) };
    await cacheTasks([taskWithPin], ownerUsername);
    return taskWithPin;
  } catch (error) {
    if (error instanceof Error && error.message.includes("(404)")) {
      return undefined;
    }
    throw error;
  }
}

export async function deleteTask(id: string, _ownerUsername: string, lbsAccessToken: string): Promise<boolean> {
  const config = getLbsConfig();
  const client = createLbsClient(config, lbsAccessToken);
  try {
    await client.deleteTask(id, config.forceOverride);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes("(404)")) {
      return false;
    }
    throw error;
  }
}

export async function exportTasksCsv(lbsAccessToken: string): Promise<string> {
  const config = getLbsConfig();
  const client = createLbsClient(config, lbsAccessToken);
  return client.exportTasksCsv();
}

export async function importTasksCsv(csvContent: string, lbsAccessToken: string): Promise<{ imported: number }> {
  const config = getLbsConfig();
  const client = createLbsClient(config, lbsAccessToken);
  const result = await client.uploadTasksCsv(csvContent);
  return { imported: typeof result.imported === "number" ? result.imported : 0 };
}

export async function listTaskProjects(_ownerUsername: string, lbsAccessToken: string): Promise<TaskProjectSummary[]> {
  const config = getLbsConfig();
  const client = createLbsClient(config, lbsAccessToken);
  const tasks = ((await client.listTasks(undefined, config.defaultActive)) as unknown as LbsTask[])
    .map(normalizeResponseTask);
  const grouped = new Map<string, TaskProjectSummary>();

  for (const task of tasks) {
    const current = grouped.get(task.context);
    if (!current) {
      grouped.set(task.context, {
        projectId: task.context,
        projectName: task.contextName,
        taskCount: 1,
        latestUpdatedAt: task.updatedAt
      });
      continue;
    }

    current.taskCount += 1;
    if (task.updatedAt > current.latestUpdatedAt) {
      current.latestUpdatedAt = task.updatedAt;
    }
  }

  return Array.from(grouped.values()).sort((a, b) => b.latestUpdatedAt.localeCompare(a.latestUpdatedAt));
}

export async function listTaskPins(ownerUsername: string): Promise<string[]> {
  return listPinnedTaskIds(ownerUsername);
}

export async function updateTaskPin(ownerUsername: string, taskId: string, pinned: boolean): Promise<{ taskId: string; pinned: boolean }> {
  await setTaskPinned(ownerUsername, taskId, pinned);
  return { taskId, pinned };
}

function mapScheduleStatus(status?: string | null): TaskStatus {
  return toUiStatus(status);
}

function mapScheduleDay(
  day: LbsScheduleDay,
  projectId?: string,
  status?: TaskStatus
): TaskScheduleDayModel {
  const mappedTasks = (day.tasks || [])
    .filter((task) => (projectId ? task.context === projectId : true))
    .map((task) => ({
      taskId: task.task_id,
      title: task.task_name,
      context: task.context,
      status: mapScheduleStatus(task.status),
      load: task.load,
      startTime: task.start_time || undefined,
      endTime: task.end_time || undefined,
      isLocked: task.is_locked === true
    }))
    .filter((task) => (status ? task.status === status : true));

  return {
    date: day.date,
    totalLoad: day.total_load,
    baseLoad: day.base_load,
    cap: day.cap,
    level: day.level,
    tasks: mappedTasks
  };
}

export async function getTaskSchedule(
  startDate: string,
  endDate: string,
  projectId: string | undefined,
  status: TaskStatus | undefined,
  lbsAccessToken: string
): Promise<TaskScheduleDayModel[]> {
  const config = getLbsConfig();
  const client = createLbsClient(config, lbsAccessToken);
  const days = await client.getSchedule(startDate, endDate);
  return days
    .map((day) => mapScheduleDay(day, projectId, status))
    .filter((day) => day.tasks.length > 0);
}

export async function completeTaskOccurrence(
  taskId: string,
  targetDate: string,
  status: TaskStatus,
  lbsAccessToken: string
): Promise<{ taskId: string; targetDate: string; status: TaskStatus }> {
  const config = getLbsConfig();
  const client = createLbsClient(config, lbsAccessToken);
  const normalizedDate = toDueDateOnly(targetDate);
  if (!normalizedDate) {
    throw new Error("targetDate must be in YYYY-MM-DD format");
  }
  await client.completeTask(taskId, normalizedDate, toLbsStatus(status));
  return { taskId, targetDate: normalizedDate, status };
}

function extractExceptionId(record: Record<string, unknown>): number | undefined {
  const id = record.id;
  if (typeof id === "number") return id;
  if (typeof id === "string" && id.trim()) {
    const parsed = Number(id);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function extractExceptionDate(record: Record<string, unknown>): string | undefined {
  const value = record.target_date;
  if (typeof value === "string") return toDueDateOnly(value);
  return undefined;
}

async function upsertTaskException(
  client: LbsClient,
  taskId: string,
  targetDate: string,
  exceptionType: "SKIP" | "FORCE_DO",
  notes: string
): Promise<void> {
  const payload = {
    task_id: taskId,
    target_date: targetDate,
    exception_type: exceptionType,
    notes,
    is_locked: false
  };
  try {
    await client.createException(payload, true);
    return;
  } catch {
    const listed = await client.listExceptions(taskId, targetDate, targetDate);
    const exact = listed.find((row) => extractExceptionDate(row) === targetDate);
    const exceptionId = exact ? extractExceptionId(exact) : undefined;
    if (!exceptionId) {
      throw new Error(`Failed to upsert exception for ${taskId} on ${targetDate}`);
    }
    await client.updateException(
      exceptionId,
      {
        exception_type: exceptionType,
        notes,
        is_locked: false
      },
      true
    );
  }
}

export async function moveTaskOccurrence(
  taskId: string,
  sourceDate: string,
  targetDate: string,
  lbsAccessToken: string
): Promise<{ taskId: string; sourceDate: string; targetDate: string }> {
  const config = getLbsConfig();
  const client = createLbsClient(config, lbsAccessToken);
  const normalizedSource = toDueDateOnly(sourceDate);
  const normalizedTarget = toDueDateOnly(targetDate);
  if (!normalizedSource || !normalizedTarget) {
    throw new Error("sourceDate and targetDate must be in YYYY-MM-DD format");
  }
  if (normalizedSource === normalizedTarget) {
    return { taskId, sourceDate: normalizedSource, targetDate: normalizedTarget };
  }

  await upsertTaskException(client, taskId, normalizedSource, "SKIP", `Moved to ${normalizedTarget}`);
  await upsertTaskException(client, taskId, normalizedTarget, "FORCE_DO", `Moved from ${normalizedSource}`);
  return { taskId, sourceDate: normalizedSource, targetDate: normalizedTarget };
}

export async function skipTaskOccurrenceException(
  taskId: string,
  targetDate: string,
  lbsAccessToken: string
): Promise<{ taskId: string; targetDate: string }> {
  const config = getLbsConfig();
  const client = createLbsClient(config, lbsAccessToken);
  const normalizedDate = toDueDateOnly(targetDate);
  if (!normalizedDate) {
    throw new Error("targetDate must be in YYYY-MM-DD format");
  }
  await upsertTaskException(client, taskId, normalizedDate, "SKIP", "Removed via UI");
  return { taskId, targetDate: normalizedDate };
}
