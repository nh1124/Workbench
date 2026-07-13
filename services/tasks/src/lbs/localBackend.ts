import { randomBytes } from "node:crypto";
import {
  createDefinition,
  deleteDefinition,
  getDefinition,
  listDefinitions,
  updateDefinition,
  bulkDeleteDefinitions,
  bulkUpdateDefinitionsActive,
  type TaskDefinitionCreate,
  type TaskDefinitionUpdate
} from "./definitionsStore.js";
import {
  createException as createStoredException,
  deleteException as deleteStoredException,
  listExceptions as listStoredExceptions,
  updateException as updateStoredException,
  type ExceptionCreate,
  type ExceptionUpdate
} from "./exceptionsStore.js";
import { deleteExecution, listExecutionsByRange, listExecutionsByTaskRange, upsertExecution } from "./executionsStore.js";
import {
  deleteCondition as deleteStoredCondition,
  getCondition as getStoredCondition,
  listConditionsInRange,
  upsertCondition
} from "./conditionsStore.js";
import { getConfig } from "./configStore.js";
import { addUtcDays } from "./engine.js";
import { LBSResponseShapes, orderTasks } from "./responseShapes.js";
import { normalizeOwner, type LbsStoreDatabase } from "./storeUtils.js";
import type {
  DateKey,
  ExceptionType,
  LBSFixtureInput,
  LBSTask,
  RuleType,
  TaskException,
  TaskStatus
} from "./types.js";
import type { LbsDataPlane, LbsScheduleDay } from "./dataPlane.js";

const DEFAULT_STATUSES: readonly TaskStatus[] = ["todo", "done"];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TASK_RESPONSE_FIELDS = new Set([
  "task_name", "context", "base_load_score", "active", "rule_type", "due_date",
  "mon", "tue", "wed", "thu", "fri", "sat", "sun", "interval_days",
  "anchor_date", "month_day", "nth_in_month", "weekday_mon1", "start_date",
  "end_date", "start_time", "end_time", "notes", "external_sync_id", "timezone",
  "is_locked"
]);
const CSV_FIELDS = [
  "task_name", "context", "base_load_score", "active", "rule_type", "due_date",
  "mon", "tue", "wed", "thu", "fri", "sat", "sun", "interval_days",
  "anchor_date", "month_day", "nth_in_month", "weekday_mon1", "start_date",
  "end_date", "start_time", "end_time", "notes", "external_sync_id", "is_locked",
  "timezone"
] as const;

export class LbsNotFoundError extends Error {
  readonly statusCode = 404;

  constructor(resource: "Task" | "Exception") {
    super(`${resource} not found (404)`);
    this.name = "LbsNotFoundError";
  }
}

function requireDate(value: unknown, field: string): DateKey {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    throw new Error(`${field} must be in YYYY-MM-DD format`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} must be a valid date`);
  }
  return value;
}

function optionalDate(value: unknown, field: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  return requireDate(value, field);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be a number`);
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function optionalInteger(value: unknown, field: string): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${field} must be an integer`);
  return value;
}

function optionalString(value: unknown, field: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function generatedTaskId(): string {
  return `T-${randomBytes(4).toString("hex").toUpperCase()}`;
}

function taskResponse(task: LBSTask): Record<string, unknown> {
  const response: Record<string, unknown> = { task_id: task.task_id };
  for (const key of TASK_RESPONSE_FIELDS) response[key] = task[key as keyof LBSTask];
  return response;
}

function exceptionResponse(exception: TaskException): Record<string, unknown> {
  const { user_id: _userId, ...response } = exception;
  return { ...response, created_at: pythonDateTime(response.created_at) };
}

function pythonDateTime(value: string): string {
  return value.replace(/\.000Z$/, "").replace(/Z$/, "");
}

function listedExceptionResponse(exception: TaskException): Record<string, unknown> {
  return { ...exception, created_at: pythonDateTime(exception.created_at) };
}

function utcToday(): DateKey {
  return new Date().toISOString().slice(0, 10);
}

function mondayFor(date: DateKey): DateKey {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addUtcDays(date, -(day === 0 ? 6 : day - 1));
}

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function parseCsv(content: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (quoted) {
      if (character === '"' && content[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error("Malformed CSV: unterminated quoted field");
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  const headers = rows.shift()?.map((header) => header.replace(/^\uFEFF/, "")) ?? [];
  return rows
    .filter((values) => values.some((value) => value.length > 0))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function csvBoolean(value: string | undefined, fallback = false): boolean {
  if (!value) return fallback;
  return ["true", "1", "yes", "y", "t"].includes(value.toLowerCase());
}

function csvOptionalInteger(value: string | undefined): number | null {
  return value?.trim() ? Number.parseInt(value, 10) : null;
}

function csvOptional(value: string | undefined): string | null {
  return value?.length ? value : null;
}

function validateTaskCreate(payload: Record<string, unknown>): TaskDefinitionCreate {
  const result: TaskDefinitionCreate = {
    task_id: generatedTaskId(),
    task_name: requireString(payload.task_name, "task_name"),
    context: requireString(payload.context, "context"),
    base_load_score: requireFiniteNumber(payload.base_load_score, "base_load_score"),
    // TaskCreate has no active field in Python; the database default is true.
    active: true,
    rule_type: requireString(payload.rule_type, "rule_type") as RuleType
  };
  for (const field of ["due_date", "anchor_date", "start_date", "end_date"] as const) {
    result[field] = optionalDate(payload[field], field);
  }
  for (const field of ["mon", "tue", "wed", "thu", "fri", "sat", "sun", "is_locked"] as const) {
    result[field] = optionalBoolean(payload[field], field);
  }
  for (const field of ["interval_days", "month_day", "nth_in_month", "weekday_mon1"] as const) {
    result[field] = optionalInteger(payload[field], field);
  }
  for (const field of ["start_time", "end_time", "notes", "external_sync_id", "timezone"] as const) {
    const value = payload[field];
    if (value !== undefined && value !== null && typeof value !== "string") throw new Error(`${field} must be a string`);
    result[field] = value as string | null | undefined;
  }
  return result;
}

function validateTaskUpdate(payload: Record<string, unknown>): TaskDefinitionUpdate {
  const patch: TaskDefinitionUpdate = {};
  if (payload.task_name !== undefined) patch.task_name = requireString(payload.task_name, "task_name");
  if (payload.context !== undefined) patch.context = requireString(payload.context, "context");
  if (payload.base_load_score !== undefined) patch.base_load_score = requireFiniteNumber(payload.base_load_score, "base_load_score");
  if (payload.active !== undefined) patch.active = optionalBoolean(payload.active, "active");
  if (payload.rule_type !== undefined) patch.rule_type = requireString(payload.rule_type, "rule_type") as RuleType;
  for (const field of ["due_date", "anchor_date", "start_date", "end_date"] as const) patch[field] = optionalDate(payload[field], field);
  for (const field of ["mon", "tue", "wed", "thu", "fri", "sat", "sun", "is_locked"] as const) patch[field] = optionalBoolean(payload[field], field);
  for (const field of ["interval_days", "month_day", "nth_in_month", "weekday_mon1"] as const) patch[field] = optionalInteger(payload[field], field);
  for (const field of ["start_time", "end_time", "notes", "external_sync_id", "timezone"] as const) {
    const value = payload[field];
    if (value !== undefined && value !== null && typeof value !== "string") throw new Error(`${field} must be a string`);
    patch[field] = value as string | null | undefined;
  }
  return patch;
}

export class LocalLbsBackend implements LbsDataPlane {
  readonly owner: string;

  constructor(ownerCoreUserId: string, private readonly database?: LbsStoreDatabase) {
    this.owner = normalizeOwner(ownerCoreUserId);
    if (!this.owner) throw new Error("Owner core user id is required");
  }

  private async requireTask(taskId: string): Promise<LBSTask> {
    const task = await getDefinition(this.owner, taskId, this.database);
    if (!task) throw new LbsNotFoundError("Task");
    return task;
  }

  private assertUnlocked(task: LBSTask, forceOverride: boolean, exception?: TaskException): void {
    if (forceOverride) return;
    const locked = exception ? exception.is_locked : task.is_locked;
    if (locked) {
      const name = exception ? exception.exception_type : task.task_name;
      throw new Error(`Action blocked: '${name}' is locked. Use force_override=true to modify.`);
    }
  }

  private async shapes(start: DateKey, end: DateKey, refToday = utcToday()): Promise<LBSResponseShapes> {
    const [tasks, exceptions, executions, dailyConditions, config] = await Promise.all([
      listDefinitions(this.owner, {}, this.database),
      listStoredExceptions(this.owner, { startDate: start, endDate: end }, this.database),
      listExecutionsByRange(this.owner, start, end, this.database),
      listConditionsInRange(this.owner, start, end, this.database),
      getConfig(this.owner, this.database)
    ]);
    const fixture: LBSFixtureInput = {
      tasks,
      task_exceptions: exceptions,
      task_executions: executions,
      daily_conditions: dailyConditions,
      system_config: Object.entries(config).map(([key, value], index) => ({
        id: index + 1,
        user_id: this.owner,
        key: key as keyof typeof config,
        value: String(value),
        description: null,
        updated_at: "1970-01-01T00:00:00.000Z"
      })),
      ref_today: refToday,
      reference_user_id: this.owner
    };
    return new LBSResponseShapes(fixture);
  }

  async listTasks(context?: string, active?: boolean): Promise<Record<string, unknown>[]> {
    const tasks = await listDefinitions(this.owner, { context, active }, this.database);
    return orderTasks(tasks).map(taskResponse);
  }

  async getTask(taskId: string, _targetDate?: string): Promise<Record<string, unknown>> {
    return taskResponse(await this.requireTask(taskId));
  }

  async createTask(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return taskResponse(await createDefinition(this.owner, validateTaskCreate(payload), this.database));
  }

  async updateTask(taskId: string, payload: Record<string, unknown>, forceOverride = false): Promise<Record<string, unknown>> {
    const current = await this.requireTask(taskId);
    this.assertUnlocked(current, forceOverride);
    const updated = await updateDefinition(this.owner, taskId, validateTaskUpdate(payload), this.database);
    if (!updated) throw new LbsNotFoundError("Task");
    return taskResponse(updated);
  }

  async deleteTask(taskId: string, forceOverride = false): Promise<void> {
    const current = await this.requireTask(taskId);
    this.assertUnlocked(current, forceOverride);
    if (!await deleteDefinition(this.owner, taskId, this.database)) throw new LbsNotFoundError("Task");
  }

  async bulkDeleteTasks(taskIds: string[], forceOverride = false): Promise<Record<string, unknown>> {
    if (!forceOverride) {
      for (const taskId of taskIds) {
        const task = await getDefinition(this.owner, taskId, this.database);
        if (task) this.assertUnlocked(task, false);
      }
    }
    const count = await bulkDeleteDefinitions(this.owner, taskIds, this.database);
    return { message: count === 0 ? "No tasks found to delete" : `Successfully deleted ${count} tasks` };
  }

  async bulkUpdateActive(taskIds: string[], active: boolean, forceOverride = false): Promise<Record<string, unknown>> {
    if (!forceOverride) {
      for (const taskId of taskIds) {
        const task = await getDefinition(this.owner, taskId, this.database);
        if (task) this.assertUnlocked(task, false);
      }
    }
    const updated = await bulkUpdateDefinitionsActive(this.owner, taskIds, active, this.database);
    return { message: updated.length === 0 ? "No tasks found to update" : `Successfully updated active status for ${updated.length} tasks` };
  }

  async resolveTask(taskId: string, targetDate: string): Promise<Record<string, unknown>> {
    await this.requireTask(taskId);
    const date = requireDate(targetDate, "target_date");
    const resolved = (await this.shapes(date, date)).resolvedTask(taskId, date);
    if (!resolved) throw new LbsNotFoundError("Task");
    return resolved;
  }

  async completeTask(
    taskId: string,
    targetDate: string,
    status: TaskStatus,
    progress?: number,
    actualTime?: number | null
  ): Promise<Record<string, unknown>> {
    await this.requireTask(taskId);
    if (!(["todo", "done", "skipped"] as string[]).includes(status)) throw new Error(`Invalid status: ${status}`);
    const resolvedProgress = progress ?? (status === "done" ? 100 : 0);
    if (!Number.isInteger(resolvedProgress) || resolvedProgress < 0 || resolvedProgress > 100) throw new Error("progress must be between 0 and 100");
    if (actualTime !== undefined && actualTime !== null && (!Number.isInteger(actualTime) || actualTime < 0)) throw new Error("actual_time must be non-negative");
    const date = requireDate(targetDate, "target_date");
    if (status === "todo") {
      await deleteExecution(this.owner, taskId, date, this.database);
    } else {
      await upsertExecution(this.owner, {
        taskId,
        targetDate: date,
        status,
        progress: resolvedProgress,
        actualTime
      }, this.database);
    }
    return { message: `Task execution updated: TaskStatus.${status.toUpperCase()}`, status };
  }

  async getTaskHistory(taskId: string, startDate: string, endDate: string): Promise<Record<string, unknown>[]> {
    await this.requireTask(taskId);
    const start = requireDate(startDate, "start_date");
    const end = requireDate(endDate, "end_date");
    const history = await listExecutionsByTaskRange(this.owner, taskId, start, end, this.database);
    return history.map(({ target_date, status }) => ({ target_date, status }));
  }

  async uploadTasksCsv(csvContent: string): Promise<Record<string, unknown>> {
    let imported = 0;
    for (const row of parseCsv(csvContent)) {
      try {
        const input: TaskDefinitionCreate = {
          task_id: generatedTaskId(),
          task_name: row.task_name || "Untitled Task",
          context: (row.context || "work").toLowerCase(),
          base_load_score: Number.parseFloat(row.base_load_score || "2.0"),
          active: csvBoolean(row.active, true),
          rule_type: (row.rule_type || "WEEKLY").toUpperCase() as RuleType,
          due_date: csvOptional(row.due_date),
          mon: csvBoolean(row.mon), tue: csvBoolean(row.tue), wed: csvBoolean(row.wed),
          thu: csvBoolean(row.thu), fri: csvBoolean(row.fri), sat: csvBoolean(row.sat), sun: csvBoolean(row.sun),
          interval_days: csvOptionalInteger(row.interval_days),
          anchor_date: csvOptional(row.anchor_date),
          month_day: csvOptionalInteger(row.month_day),
          nth_in_month: csvOptionalInteger(row.nth_in_month),
          weekday_mon1: csvOptionalInteger(row.weekday_mon1),
          start_date: csvOptional(row.start_date),
          end_date: csvOptional(row.end_date),
          start_time: csvOptional(row.start_time),
          end_time: csvOptional(row.end_time),
          notes: csvOptional(row.notes),
          external_sync_id: csvOptional(row.external_sync_id),
          is_locked: csvBoolean(row.is_locked),
          timezone: row.timezone || "UTC"
        };
        if (!Number.isFinite(input.base_load_score)) throw new Error("Invalid base_load_score");
        await createDefinition(this.owner, input, this.database);
        imported += 1;
      } catch {
        // Python's CSV route logs malformed rows and continues importing the rest.
      }
    }
    return { message: `Successfully imported ${imported} tasks`, imported };
  }

  async exportTasksCsv(): Promise<string> {
    const tasks = await listDefinitions(this.owner, {}, this.database);
    const rows = tasks.map((task) => CSV_FIELDS.map((field) => csvEscape(task[field])).join(","));
    return [CSV_FIELDS.join(","), ...rows].join("\r\n");
  }

  async getSchedule(startDate: string, endDate: string): Promise<LbsScheduleDay[]> {
    const start = requireDate(startDate, "start_date");
    const end = requireDate(endDate, "end_date");
    return (await this.shapes(start, end)).schedule(start, end) as unknown as LbsScheduleDay[];
  }

  async getDashboard(startDate?: string): Promise<Record<string, unknown>> {
    const today = utcToday();
    const start = startDate ? requireDate(startDate, "start_date") : mondayFor(today);
    return (await this.shapes(start, addUtcDays(start, 6), today)).dashboard(start, today);
  }

  async getHeatmap(start: string, end: string, statuses?: TaskStatus[]): Promise<Record<string, unknown>[]> {
    const startDate = requireDate(start, "start");
    const endDate = requireDate(end, "end");
    return (await this.shapes(startDate, endDate)).heatmap(startDate, endDate, statuses ?? DEFAULT_STATUSES);
  }

  async getTrends(weeks = 12, startDate?: string, statuses?: TaskStatus[]): Promise<Record<string, unknown>> {
    if (!Number.isInteger(weeks) || weeks < 0) throw new Error("weeks must be a non-negative integer");
    const start = startDate ? requireDate(startDate, "start_date") : addUtcDays(utcToday(), -(weeks * 7));
    const end = addUtcDays(start, weeks * 7);
    return (await this.shapes(start, end)).trends(weeks, start, statuses ?? DEFAULT_STATUSES);
  }

  async getContextDistribution(start: string, end: string, statuses?: TaskStatus[]): Promise<Record<string, unknown>> {
    const startDate = requireDate(start, "start");
    const endDate = requireDate(end, "end");
    return (await this.shapes(startDate, endDate)).contextDistribution(startDate, endDate, statuses ?? DEFAULT_STATUSES);
  }

  async calculateLoad(targetDate: string, statuses?: TaskStatus[]): Promise<Record<string, unknown>> {
    const date = requireDate(targetDate, "target_date");
    return (await this.shapes(date, date)).calculate(date, statuses ?? DEFAULT_STATUSES) as unknown as Record<string, unknown>;
  }

  async forceExpand(startDate: string, endDate: string): Promise<Record<string, unknown>> {
    requireDate(startDate, "start_date");
    requireDate(endDate, "end_date");
    // Local mode calculates in-process and deliberately persists no expansion cache.
    return { message: "Expansion complete" };
  }

  async listExceptions(taskId?: string, startDate?: string, endDate?: string): Promise<Record<string, unknown>[]> {
    return (await listStoredExceptions(this.owner, { taskId, startDate, endDate }, this.database)).map(listedExceptionResponse);
  }

  async createException(payload: Record<string, unknown>, forceOverride = false): Promise<Record<string, unknown>> {
    const taskId = requireString(payload.task_id, "task_id");
    const task = await this.requireTask(taskId);
    this.assertUnlocked(task, forceOverride);
    const input: ExceptionCreate = {
      task_id: taskId,
      target_date: requireDate(payload.target_date, "target_date"),
      exception_type: requireString(payload.exception_type, "exception_type") as ExceptionType,
      override_load_value: payload.override_load_value === undefined || payload.override_load_value === null
        ? payload.override_load_value as null | undefined
        : requireFiniteNumber(payload.override_load_value, "override_load_value"),
      start_time: optionalString(payload.start_time, "start_time"),
      end_time: optionalString(payload.end_time, "end_time"),
      notes: optionalString(payload.notes, "notes"),
      is_locked: optionalBoolean(payload.is_locked, "is_locked")
    };
    return exceptionResponse(await createStoredException(this.owner, input, this.database));
  }

  async updateException(exceptionId: number, payload: Record<string, unknown>, forceOverride = false): Promise<Record<string, unknown>> {
    const existing = (await listStoredExceptions(this.owner, {}, this.database)).find((row) => row.id === exceptionId);
    if (!existing) throw new LbsNotFoundError("Exception");
    const task = await this.requireTask(existing.task_id);
    this.assertUnlocked(task, forceOverride, existing);
    const patch: ExceptionUpdate = {};
    if (payload.exception_type !== undefined) patch.exception_type = requireString(payload.exception_type, "exception_type") as ExceptionType;
    if (payload.override_load_value !== undefined) patch.override_load_value = payload.override_load_value === null
      ? null : requireFiniteNumber(payload.override_load_value, "override_load_value");
    for (const field of ["start_time", "end_time", "notes"] as const) {
      if (payload[field] !== undefined) {
        if (payload[field] !== null && typeof payload[field] !== "string") throw new Error(`${field} must be a string`);
        patch[field] = payload[field] as string | null;
      }
    }
    if (payload.is_locked !== undefined) patch.is_locked = optionalBoolean(payload.is_locked, "is_locked");
    const updated = await updateStoredException(this.owner, exceptionId, patch, this.database);
    if (!updated) throw new LbsNotFoundError("Exception");
    return exceptionResponse(updated);
  }

  async deleteException(exceptionId: number, forceOverride = false): Promise<void> {
    const existing = (await listStoredExceptions(this.owner, {}, this.database)).find((row) => row.id === exceptionId);
    if (!existing) throw new LbsNotFoundError("Exception");
    const task = await this.requireTask(existing.task_id);
    this.assertUnlocked(task, forceOverride, existing);
    if (!await deleteStoredException(this.owner, exceptionId, this.database)) throw new LbsNotFoundError("Exception");
  }

  async createCondition(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const date = requireDate(payload.date, "date");
    return await upsertCondition(this.owner, date, {
      cognitiveFatigue: requireFiniteNumber(payload.cognitive_fatigue ?? 0, "cognitive_fatigue"),
      physicalFatigue: requireFiniteNumber(payload.physical_fatigue ?? 0, "physical_fatigue"),
      note: optionalString(payload.note, "note")
    }, this.database) as unknown as Record<string, unknown>;
  }

  async getCondition(targetDate: string): Promise<Record<string, unknown>> {
    const date = requireDate(targetDate, "target_date");
    const stored = await getStoredCondition(this.owner, date, this.database);
    return (stored ?? {
      user_id: this.owner,
      target_date: date,
      cognitive_fatigue: 0,
      physical_fatigue: 0,
      note: null,
      updated_at: new Date().toISOString()
    }) as unknown as Record<string, unknown>;
  }

  async deleteCondition(targetDate: string): Promise<void> {
    await deleteStoredCondition(this.owner, requireDate(targetDate, "target_date"), this.database);
  }

  async healthCheck(): Promise<Record<string, unknown>> {
    return { status: "healthy", service: "lbs-api" };
  }
}
