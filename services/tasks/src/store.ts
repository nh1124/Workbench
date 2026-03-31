import { createHash } from "node:crypto";
import { cacheTasks, listPinnedTaskIds, setTaskPinned, upsertServiceAccount } from "./db.js";
import type { LbsScheduleDay } from "./lbsClient.js";
import {
  applyResolvedStatus,
  createLbsClient,
  getLbsConfig,
  normalizeResponseTask,
  resolveStatusTargetDate,
  toDueDateOnly,
  toLbsStatus,
  toUiStatus,
  toValidRecurrence,
  todayInTimezone,
  type LbsConfig,
  type LbsTask
} from "./lbsTaskService.js";
import type {
  Task,
  TaskHistoryEntry,
  TaskInput,
  TaskProjectSummary,
  TaskScheduleDay as TaskScheduleDayModel,
  TaskStatus
} from "./types.js";

interface LbsHistoryEntry {
  id?: string | number;
  task_id?: string;
  target_date?: string;
  status?: string;
  created_at?: string;
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

export async function listTasks(
  filters: { projectId?: string; status?: TaskStatus; limit?: number } | undefined,
  ownerUsername: string,
  lbsAccessToken: string
): Promise<Task[]> {
  console.log(`[tasks-service] listTasks  owner=${ownerUsername} filters=${JSON.stringify(filters ?? {})}`);
  const config = getLbsConfig();
  const client = createLbsClient(config, lbsAccessToken);
  const tasks = (await client.listTasks(filters?.projectId, config.defaultActive)) as unknown as LbsTask[];
  console.log(`[tasks-service] listTasks  LBS returned ${tasks.length} task(s)`);
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
  console.log(`[tasks-service] listTasks  returning ${result.length} task(s) after filters`);
  return result;
}

export async function getTask(id: string, ownerUsername: string, lbsAccessToken: string): Promise<Task | undefined> {
  console.log(`[tasks-service] getTask  id=${id} owner=${ownerUsername}`);
  try {
    const config = getLbsConfig();
    const client = createLbsClient(config, lbsAccessToken);
    const task = (await client.getTask(id)) as unknown as LbsTask;
    const normalized = normalizeResponseTask(task);
    const resolved = await applyResolvedStatus(normalized, lbsAccessToken, config.timezone);
    const pinnedIds = new Set(await listPinnedTaskIds(ownerUsername));
    const taskWithPin = { ...resolved, isPinned: pinnedIds.has(resolved.id) };
    await cacheTasks([taskWithPin], ownerUsername);
    console.log(`[tasks-service] getTask  id=${id} found: title="${taskWithPin.title}"`);
    return taskWithPin;
  } catch (error) {
    // LBS returns {"detail":"Task not found"} for missing tasks.
    // The LBS client uses the raw response body as the error message, so we
    // need to check for both the status-code suffix "(404)" and the JSON body.
    if (error instanceof Error && (
      error.message.includes("(404)") ||
      error.message.includes("Task not found") ||
      error.message.includes('"detail"')
    )) {
      console.warn(`[tasks-service] getTask(${id}): task not found in LBS, returning undefined`);
      return undefined;
    }
    console.error(`[tasks-service] getTask(${id}) unexpected error:`, error instanceof Error ? error.message : String(error));
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
  // NOTE: LBS has no export-csv endpoint - GET /tasks/export-csv would match
  // the /tasks/{task_id} route and return {"detail":"Task not found"}.
  // We build the CSV ourselves by fetching all tasks via listTasks().
  console.log(`[tasks-service] exportTasksCsv  fetching all tasks from LBS`);
  const config = getLbsConfig();
  const client = createLbsClient(config, lbsAccessToken);
  try {
    // Omit the `active` filter to export both active and inactive tasks
    const tasks = (await client.listTasks(undefined, undefined)) as unknown as LbsTask[];
    console.log(`[tasks-service] exportTasksCsv  received ${tasks.length} task(s) from LBS`);

    const headers = [
      "task_name", "context", "base_load_score", "active", "rule_type",
      "due_date", "mon", "tue", "wed", "thu", "fri", "sat", "sun",
      "interval_days", "anchor_date", "month_day", "nth_in_month", "weekday_mon1",
      "start_date", "end_date", "notes", "timezone"
    ];

    const escapeCell = (v: unknown): string => {
      const s = v === null || v === undefined ? "" : String(v);
      return s.includes(",") || s.includes('"') || s.includes("\n")
        ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const rows = tasks.map((t) =>
      [
        t.task_name, t.context, t.base_load_score, t.active, t.rule_type,
        t.due_date ?? "", t.mon ?? false, t.tue ?? false, t.wed ?? false,
        t.thu ?? false, t.fri ?? false, t.sat ?? false, t.sun ?? false,
        t.interval_days ?? "", t.anchor_date ?? "", t.month_day ?? "",
        t.nth_in_month ?? "", t.weekday_mon1 ?? "",
        t.start_date ?? "", t.end_date ?? "", t.notes ?? "",
        t.timezone ?? config.timezone
      ].map(escapeCell).join(",")
    );

    const csv = [headers.join(","), ...rows].join("\n");
    console.log(`[tasks-service] exportTasksCsv  built ${rows.length} row(s), ${csv.length} char(s)`);
    return csv;
  } catch (error) {
    console.error(`[tasks-service] exportTasksCsv  error:`, error instanceof Error ? error.message : String(error));
    throw error;
  }
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
