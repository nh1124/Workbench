import { randomUUID } from "node:crypto";
import {
  listOpenOutboxForResource,
  markRemoteResourceDeleted,
  markOutboxSuperseded,
  removeRemoteResource,
  upsertRemoteResource,
  writeManifestDebugSnapshot,
  type OutboxItem
} from "./manifestStore.js";
import {
  asNumber,
  asRecord,
  asString,
  enqueueManifestOutbox,
  listLocalRemoteDomainItems,
  localProjectId,
  localProjectName,
  localRemoteDomainItem,
  refreshManifestStats,
  resultRecord,
  supersedeOpenOutboxForPath
} from "./localStore.js";
import type { DaemonState, SyncPushResponse } from "./types.js";
export const LOCAL_TASK_ID_PREFIX = "local-task-";
export const LOCAL_TASK_STATUSES = new Set(["todo", "done", "skipped"]);
export const LOCAL_TASK_PRIORITIES = new Set(["low", "medium", "high"]);
export const LOCAL_TASK_RECURRENCES = new Set(["ONCE", "WEEKLY", "EVERY_N_DAYS", "MONTHLY_DAY", "MONTHLY_NTH_WEEKDAY"]);
export const DAY_MS = 24 * 60 * 60 * 1000;

export function isLocalTaskId(id: string | undefined): boolean {
  return typeof id === "string" && id.startsWith(LOCAL_TASK_ID_PREFIX);
}

export function taskOutboxPath(id: string): string {
  return `tasks/${id}`;
}

export function taskRelationOutboxPath(id: string, relation: string): string {
  return `tasks/${id}/${relation}`;
}

export function parseTaskStatus(value: unknown): "todo" | "done" | "skipped" | undefined {
  return typeof value === "string" && LOCAL_TASK_STATUSES.has(value)
    ? value as "todo" | "done" | "skipped"
    : undefined;
}

export function normalizeTaskStatus(value: unknown, fallback?: unknown): "todo" | "done" | "skipped" {
  const parsed = parseTaskStatus(value);
  if (parsed) return parsed;
  const fallbackParsed = parseTaskStatus(fallback);
  if (fallbackParsed) return fallbackParsed;
  return "todo";
}

export function normalizeTaskPriority(value: unknown, fallback?: unknown): "low" | "medium" | "high" | undefined {
  if (typeof value === "string" && LOCAL_TASK_PRIORITIES.has(value)) return value as "low" | "medium" | "high";
  if (typeof fallback === "string" && LOCAL_TASK_PRIORITIES.has(fallback)) return fallback as "low" | "medium" | "high";
  return undefined;
}

export function normalizeTaskRecurrence(value: unknown, fallback?: unknown): string {
  if (typeof value === "string" && LOCAL_TASK_RECURRENCES.has(value)) return value;
  if (typeof fallback === "string" && LOCAL_TASK_RECURRENCES.has(fallback)) return fallback;
  return "ONCE";
}

export function finiteNumber(value: unknown, fallback?: unknown, defaultValue?: number): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof fallback === "number" && Number.isFinite(fallback)) return fallback;
  return defaultValue;
}

export function finiteInteger(value: unknown, fallback?: unknown): number | undefined {
  const number = finiteNumber(value, fallback);
  return number === undefined ? undefined : Math.trunc(number);
}

export function normalizeTaskBoolean(value: unknown, fallback: unknown, defaultValue?: boolean): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof fallback === "boolean") return fallback;
  return defaultValue;
}

export function copyOptionalTaskString(payload: Record<string, unknown>, key: string, input: Record<string, unknown>, existing?: Record<string, unknown>): void {
  if (typeof input[key] === "string") {
    payload[key] = input[key];
  } else if (typeof existing?.[key] === "string") {
    payload[key] = existing[key];
  }
}

export function copyOptionalTaskBoolean(payload: Record<string, unknown>, key: string, input: Record<string, unknown>, existing?: Record<string, unknown>): void {
  const value = normalizeTaskBoolean(input[key], existing?.[key]);
  if (value !== undefined) payload[key] = value;
}

export function copyOptionalTaskInteger(payload: Record<string, unknown>, key: string, input: Record<string, unknown>, existing?: Record<string, unknown>): void {
  const value = finiteInteger(input[key], existing?.[key]);
  if (value !== undefined) payload[key] = value;
}

export function normalizeLocalTaskPayload(
  state: DaemonState,
  input: Record<string, unknown>,
  existing?: Record<string, unknown>
): Record<string, unknown> {
  const now = new Date().toISOString();
  const title = typeof input.title === "string" && input.title.trim()
    ? input.title.trim()
    : typeof existing?.title === "string" && existing.title.trim()
      ? existing.title
      : "Untitled Task";
  const context = typeof input.context === "string" && input.context.trim()
    ? input.context.trim()
    : typeof existing?.context === "string" && existing.context.trim()
      ? existing.context
      : typeof existing?.projectId === "string" && existing.projectId.trim()
        ? existing.projectId
        : localProjectId(state);
  const contextName = typeof input.contextName === "string"
    ? input.contextName
    : typeof existing?.contextName === "string"
      ? existing.contextName
      : localProjectName(state);
  const payload: Record<string, unknown> = {
    ...(existing ?? {}),
    title,
    notes: typeof input.notes === "string" ? input.notes : typeof existing?.notes === "string" ? existing.notes : "",
    context,
    contextName,
    status: normalizeTaskStatus(input.status, existing?.status),
    isLocked: normalizeTaskBoolean(input.isLocked, existing?.isLocked, false) ?? false,
    baseLoadScore: finiteNumber(input.baseLoadScore, existing?.baseLoadScore, 5) ?? 5,
    recurrence: normalizeTaskRecurrence(input.recurrence, existing?.recurrence),
    active: normalizeTaskBoolean(input.active, existing?.active, true) ?? true,
    isPinned: normalizeTaskBoolean(input.isPinned, existing?.isPinned, false) ?? false,
    createdAt: typeof existing?.createdAt === "string" ? existing.createdAt : now,
    updatedAt: now
  };
  const priority = normalizeTaskPriority(input.priority, existing?.priority);
  if (priority) payload.priority = priority;
  for (const key of ["dueDate", "startTime", "endTime", "timezone", "activeFrom", "activeUntil", "anchorDate"]) {
    copyOptionalTaskString(payload, key, input, existing);
  }
  for (const key of ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]) {
    copyOptionalTaskBoolean(payload, key, input, existing);
  }
  for (const key of ["intervalDays", "monthDay", "nthInMonth", "weekdayMon1"]) {
    copyOptionalTaskInteger(payload, key, input, existing);
  }
  return payload;
}

export function localTaskProjectSummaries(state: DaemonState): Record<string, unknown>[] {
  const byProject = new Map<string, { projectId: string; projectName?: string; taskCount: number; latestUpdatedAt: string }>();
  for (const task of listLocalRemoteDomainItems(state, "tasks")) {
    const projectId = typeof task.context === "string" && task.context.trim()
      ? task.context
      : typeof task.projectId === "string" && task.projectId.trim()
        ? task.projectId
        : localProjectId(state);
    const projectName = typeof task.contextName === "string" ? task.contextName : undefined;
    const updatedAt = typeof task.updatedAt === "string" ? task.updatedAt : new Date().toISOString();
    const existing = byProject.get(projectId);
    if (!existing) {
      byProject.set(projectId, { projectId, projectName, taskCount: 1, latestUpdatedAt: updatedAt });
    } else {
      existing.taskCount += 1;
      if (!existing.projectName && projectName) existing.projectName = projectName;
      if (existing.latestUpdatedAt < updatedAt) existing.latestUpdatedAt = updatedAt;
    }
  }
  return [...byProject.values()].sort((a, b) => b.latestUpdatedAt.localeCompare(a.latestUpdatedAt));
}

export function localTaskPinnedIds(state: DaemonState): string[] {
  return listLocalRemoteDomainItems(state, "tasks")
    .filter((task) => task.isPinned === true)
    .map((task) => asString(task.id))
    .filter((id): id is string => Boolean(id));
}

export function taskRelationPayload(item: OutboxItem): { relation: string; taskId: string } | undefined {
  if (item.domain !== "tasks") return undefined;
  const relation = asString(item.payload.relation);
  if (!relation) return undefined;
  const taskId = asString(item.payload.taskId) ?? item.resourceId ?? asString(item.payload.id);
  return taskId ? { relation, taskId } : undefined;
}

export function shouldDeferTaskOutboxItem(state: DaemonState, item: OutboxItem): boolean {
  const relationPayload = taskRelationPayload(item);
  if (!relationPayload || !isLocalTaskId(relationPayload.taskId)) return false;
  return listOpenOutboxForResource(state.manifestStore, relationPayload.taskId).some(
    (candidate) => candidate.domain === "tasks"
      && candidate.action === "create"
      && !asString(candidate.payload.relation)
  );
}

export function retargetOpenTaskOutboxReferences(state: DaemonState, oldResourceId: string, newResourceId: string, updatedAt: string): void {
  for (const item of listOpenOutboxForResource(state.manifestStore, oldResourceId)) {
    if (item.domain !== "tasks") continue;
    markOutboxSuperseded(
      state.manifestStore,
      item.id,
      "Local task received a cloud id; pending task operation was retargeted.",
      updatedAt
    );
    enqueueManifestOutbox(state.manifestStore, {
      relativePath: item.relativePath.replace(oldResourceId, newResourceId),
      domain: item.domain,
      action: item.action,
      resourceId: newResourceId,
      payload: {
        ...item.payload,
        id: asString(item.payload.id) === oldResourceId ? newResourceId : item.payload.id,
        taskId: asString(item.payload.taskId) === oldResourceId ? newResourceId : item.payload.taskId
      }
    });
  }
}

export function applyTaskPinPushResult(
  state: DaemonState,
  item: OutboxItem,
  appliedItem: NonNullable<SyncPushResponse["applied"]>[number],
  now: string
): boolean {
  const relationPayload = taskRelationPayload(item);
  if (!relationPayload || relationPayload.relation !== "pin") return false;
  const result = resultRecord(appliedItem.result);
  const taskId = appliedItem.resourceId ?? asString(result?.taskId) ?? relationPayload.taskId;
  const pinned = typeof result?.pinned === "boolean" ? result.pinned : normalizeTaskBoolean(item.payload.pinned, undefined, false) ?? false;
  const existing = localRemoteDomainItem(state, "tasks", taskId, { includeDeleted: true });
  if (existing) {
    const payload = {
      ...existing,
      id: taskId,
      isPinned: pinned,
      updatedAt: now
    };
    upsertRemoteResource(state.manifestStore, {
      domain: "tasks",
      resourceId: taskId,
      version: appliedItem.version,
      payload,
      updatedAt: now,
      lastSyncedAt: now
    });
  }
  return true;
}

export function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(asRecord(item)))
    : [];
}

export function nextLocalScheduleId(): number {
  return -Number.parseInt(randomUUID().slice(0, 8), 16);
}

export function localSubtaskId(): string {
  return `local-subtask-${randomUUID()}`;
}

export function localTaskPayloadForUpdate(state: DaemonState, taskId: string): Record<string, unknown> | undefined {
  return localRemoteDomainItem(state, "tasks", taskId, { includeDeleted: true });
}

export function upsertLocalTaskPayload(
  state: DaemonState,
  taskId: string,
  payload: Record<string, unknown>,
  updatedAt: string
): void {
  upsertRemoteResource(state.manifestStore, {
    domain: "tasks",
    resourceId: taskId,
    version: asNumber(payload.version),
    payload: {
      ...payload,
      id: taskId,
      updatedAt
    },
    updatedAt,
    lastSyncedAt: asString(payload.lastSyncedAt)
  });
}

export function taskScheduleItems(task: Record<string, unknown> | undefined): Record<string, unknown>[] {
  return recordArray(task?.scheduleItems);
}

export function taskSubtasks(task: Record<string, unknown> | undefined): Record<string, unknown>[] {
  return recordArray(task?.subtasks);
}

export function taskAttachments(task: Record<string, unknown> | undefined): Record<string, unknown>[] {
  return recordArray(task?.attachments);
}

export function taskOccurrenceActions(task: Record<string, unknown> | undefined): Record<string, unknown>[] {
  return recordArray(task?.occurrenceActions);
}

export function parseDateOnly(value: unknown): Date | undefined {
  const text = asString(value);
  if (!text) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!year || !month || !day) return undefined;
  return new Date(Date.UTC(year, month - 1, day));
}

export function dateKeyFromDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function localTaskWithinActivePeriod(task: Record<string, unknown>, date: Date): boolean {
  if (task.recurrence === "ONCE") return true;
  if (task.active === false) return false;
  const from = parseDateOnly(task.activeFrom);
  const until = parseDateOnly(task.activeUntil);
  if (from && date < from) return false;
  if (until && date > until) return false;
  return true;
}

export function localTaskOccursOnDateKey(task: Record<string, unknown>, dateKey: string): boolean {
  const day = parseDateOnly(dateKey);
  if (!day) return false;
  const recurrence = asString(task.recurrence) ?? "ONCE";

  if (recurrence === "ONCE") {
    const due = parseDateOnly(task.dueDate);
    return !!due && dateKeyFromDate(due) === dateKey;
  }

  if (!localTaskWithinActivePeriod(task, day)) return false;

  if (recurrence === "WEEKLY") {
    const selectedDays = [
      task.sun, task.mon, task.tue, task.wed, task.thu, task.fri, task.sat
    ].map(Boolean);
    if (selectedDays.some(Boolean)) return selectedDays[day.getUTCDay()];
    const fallback = parseDateOnly(task.activeFrom) || parseDateOnly(task.dueDate);
    return fallback ? fallback.getUTCDay() === day.getUTCDay() : false;
  }

  if (recurrence === "EVERY_N_DAYS") {
    const interval = Math.max(1, finiteInteger(task.intervalDays) ?? 1);
    const anchor =
      parseDateOnly(task.anchorDate) ||
      parseDateOnly(task.activeFrom) ||
      parseDateOnly(task.createdAt);
    if (!anchor) return false;
    const diff = Math.floor((day.getTime() - anchor.getTime()) / DAY_MS);
    return diff >= 0 && diff % interval === 0;
  }

  if (recurrence === "MONTHLY_DAY") {
    const dayOfMonth = Math.min(31, Math.max(1, finiteInteger(task.monthDay) ?? 1));
    return day.getUTCDate() === dayOfMonth;
  }

  if (recurrence === "MONTHLY_NTH_WEEKDAY") {
    const nthInMonth = Math.min(5, Math.max(1, finiteInteger(task.nthInMonth) ?? 1));
    const weekday = Math.min(6, Math.max(0, finiteInteger(task.weekdayMon1) ?? 0));
    const weekIndex = Math.floor((day.getUTCDate() - 1) / 7) + 1;
    return day.getUTCDay() === weekday && weekIndex === nthInMonth;
  }

  return false;
}

export function scheduleItemNaturalKey(taskId: string, occurrenceDate: string, scheduledDate: string): string {
  return `${taskId}::${occurrenceDate}::${scheduledDate}`;
}

export function scheduleItemDates(item: Record<string, unknown>): { occurrenceDate: string; scheduledDate: string } | undefined {
  const scheduledDate = asString(item.scheduledDate);
  if (!scheduledDate) return undefined;
  return {
    occurrenceDate: asString(item.occurrenceDate) ?? scheduledDate,
    scheduledDate
  };
}

export function scheduleItemNaturalKeyValue(taskId: string, item: Record<string, unknown>): string | undefined {
  const dates = scheduleItemDates(item);
  return dates ? scheduleItemNaturalKey(taskId, dates.occurrenceDate, dates.scheduledDate) : undefined;
}

export function scheduleItemIdentityMatches(
  taskId: string,
  item: Record<string, unknown>,
  identity: { scheduleId?: number; occurrenceDate?: string; scheduledDate?: string },
  mode: "exact" | "upsert"
): boolean {
  const candidateId = scheduleItemIdValue(item);
  if (identity.scheduleId !== undefined) {
    if (mode === "exact") return candidateId === identity.scheduleId;
    if (identity.scheduleId > 0) return candidateId === identity.scheduleId;
  }
  if (!identity.occurrenceDate || !identity.scheduledDate) return false;
  return scheduleItemNaturalKeyValue(taskId, item) === scheduleItemNaturalKey(taskId, identity.occurrenceDate, identity.scheduledDate);
}

export function occurrenceOperation(action: Record<string, unknown>): string | undefined {
  const operation = asString(action.operation) ?? asString(action.kind);
  return operation === "skip-exception" ? "skipException" : operation;
}

export function occurrenceActionDate(action: Record<string, unknown>): string | undefined {
  return asString(action.targetDate) ?? asString(action.occurrenceDate);
}

export function localOccurrenceStatus(
  task: Record<string, unknown>,
  occurrenceDate: string
): "todo" | "done" | "skipped" | undefined {
  let status: "todo" | "done" | "skipped" | undefined;
  for (const action of taskOccurrenceActions(task)) {
    const operation = occurrenceOperation(action);
    if (operation === "complete" && occurrenceActionDate(action) === occurrenceDate) {
      status = parseTaskStatus(action.status) ?? status;
    } else if (operation === "skipException" && occurrenceActionDate(action) === occurrenceDate) {
      status = "skipped";
    } else if (operation === "move") {
      if (asString(action.sourceDate) === occurrenceDate) status = "skipped";
      if (asString(action.targetDate) === occurrenceDate && status === "skipped") status = undefined;
    }
  }
  return status;
}

export function localResolvedOccurrenceStatus(
  task: Record<string, unknown>,
  occurrenceDate: string
): "todo" | "done" | "skipped" {
  return localOccurrenceStatus(task, occurrenceDate) ?? normalizeTaskStatus(task.status);
}

export function localOccurrenceHidden(task: Record<string, unknown>, occurrenceDate: string): boolean {
  return taskOccurrenceActions(task).some((action) => {
    const operation = occurrenceOperation(action);
    return (operation === "skipException" && occurrenceActionDate(action) === occurrenceDate)
      || (operation === "move" && asString(action.sourceDate) === occurrenceDate);
  });
}

export function shouldUpdateTaskStatusFromOccurrence(task: Record<string, unknown>, operation: string, status: unknown): boolean {
  return operation === "complete" && task.recurrence === "ONCE" && parseTaskStatus(status) !== undefined;
}

export function localTaskHasCalendarTime(task: Record<string, unknown>): boolean {
  return Boolean(asString(task.startTime) || asString(task.endTime));
}

export function scheduleItemOutboxPath(taskId: string, scheduleId: string | number): string {
  return `tasks/${taskId}/schedule-items/${scheduleId}`;
}

export function subtaskOutboxPath(taskId: string, occurrenceDate: string, subtaskId: string): string {
  return `tasks/${taskId}/subtasks/${occurrenceDate}/${subtaskId}`;
}

export function attachmentOutboxPath(taskId: string, attachmentId: string): string {
  return `tasks/${taskId}/attachments/${attachmentId}`;
}

export function occurrenceOutboxPath(taskId: string, operation: string, targetDate: string): string {
  return `tasks/${taskId}/occurrences/${operation}/${targetDate}`;
}

export function scheduleItemId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function scheduleItemIdValue(item: Record<string, unknown>): number | undefined {
  return scheduleItemId(item.id) ?? scheduleItemId(item.scheduleId);
}

export function normalizeScheduleItemPayload(taskId: string, input: Record<string, unknown>, existing?: Record<string, unknown>): Record<string, unknown> {
  const now = new Date().toISOString();
  const scheduledDate = asString(input.scheduledDate) ?? asString(existing?.scheduledDate) ?? new Date().toISOString().slice(0, 10);
  const occurrenceDate = asString(input.occurrenceDate) ?? asString(existing?.occurrenceDate) ?? scheduledDate;
  const id = scheduleItemId(input.id)
    ?? scheduleItemId(input.scheduleId)
    ?? scheduleItemId(existing?.id)
    ?? scheduleItemId(existing?.scheduleId)
    ?? nextLocalScheduleId();
  const payload: Record<string, unknown> = {
    ...(existing ?? {}),
    id,
    scheduleId: id,
    taskId,
    occurrenceDate,
    scheduledDate,
    createdAt: typeof existing?.createdAt === "string" ? existing.createdAt : now,
    updatedAt: now
  };
  for (const key of ["startTime", "endTime", "timezone"]) {
    if (key in input) {
      payload[key] = input[key] ?? undefined;
    } else if (key in (existing ?? {})) {
      payload[key] = existing?.[key];
    }
  }
  return payload;
}

export function updateTaskScheduleItems(
  state: DaemonState,
  taskId: string,
  updater: (items: Record<string, unknown>[]) => Record<string, unknown>[],
  updatedAt: string
): Record<string, unknown> | undefined {
  const task = localTaskPayloadForUpdate(state, taskId);
  if (!task || task.deleted === true) return undefined;
  const payload = {
    ...task,
    scheduleItems: updater(taskScheduleItems(task))
  };
  upsertLocalTaskPayload(state, taskId, payload, updatedAt);
  return payload;
}

export function findLocalScheduleItem(
  state: DaemonState,
  scheduleId: number
): { taskId: string; task: Record<string, unknown>; item: Record<string, unknown> } | undefined {
  for (const task of listLocalRemoteDomainItems(state, "tasks", { includeDeleted: false, limit: 1000 })) {
    const taskId = asString(task.id);
    if (!taskId) continue;
    const item = taskScheduleItems(task).find((candidate) => scheduleItemIdValue(candidate) === scheduleId);
    if (item) return { taskId, task, item };
  }
  return undefined;
}

export function localTodayTasks(state: DaemonState, date: string): Record<string, unknown>[] {
  const tasks: Record<string, unknown>[] = [];
  for (const task of listLocalRemoteDomainItems(state, "tasks", { includeDeleted: false, limit: 1000 })) {
    const taskId = asString(task.id);
    if (!taskId) continue;
    for (const item of taskScheduleItems(task)) {
      const dates = scheduleItemDates(item);
      if (!dates || dates.scheduledDate !== date) continue;
      tasks.push({
        ...task,
        status: localResolvedOccurrenceStatus(task, dates.occurrenceDate),
        occurrenceDate: dates.occurrenceDate,
        scheduledDate: dates.scheduledDate,
        scheduleId: scheduleItemIdValue(item),
        startTime: item.startTime,
        endTime: item.endTime,
        timezone: item.timezone
      });
    }
  }
  return tasks.sort((a, b) => String(a.startTime ?? "").localeCompare(String(b.startTime ?? "")));
}

export function localScheduleRow(
  task: Record<string, unknown>,
  occurrenceDate: string,
  scheduledDate: string,
  scheduleItem?: Record<string, unknown>
): Record<string, unknown> | undefined {
  const taskId = asString(task.id);
  if (!taskId) return undefined;
  return {
    scheduleId: scheduleItem ? scheduleItemIdValue(scheduleItem) : undefined,
    taskId,
    title: task.title,
    context: task.context,
    status: localResolvedOccurrenceStatus(task, occurrenceDate),
    occurrenceDate,
    scheduledDate,
    load: task.baseLoadScore,
    startTime: scheduleItem ? scheduleItem.startTime : task.startTime,
    endTime: scheduleItem ? scheduleItem.endTime : task.endTime,
    timezone: scheduleItem ? scheduleItem.timezone : task.timezone,
    isLocked: task.isLocked
  };
}

export function localGeneratedMoveTargets(
  task: Record<string, unknown>,
  startDate: string,
  endDate: string
): string[] {
  const targets = new Set<string>();
  for (const action of taskOccurrenceActions(task)) {
    if (occurrenceOperation(action) !== "move") continue;
    const targetDate = asString(action.targetDate);
    if (targetDate && targetDate >= startDate && targetDate <= endDate) {
      targets.add(targetDate);
    }
  }
  return [...targets].sort();
}

export function localScheduleRows(
  state: DaemonState,
  startDate: string,
  endDate: string,
  options: { includeGenerated: boolean; generatedRequiresTime: boolean; includeOnceDue: boolean }
): Record<string, unknown>[] {
  const dateKeys = dateRange(startDate, endDate);
  const rows: Record<string, unknown>[] = [];
  const generatedRowKeys = new Set<string>();

  for (const task of listLocalRemoteDomainItems(state, "tasks", { includeDeleted: false, limit: 1000 })) {
    const taskId = asString(task.id);
    if (!taskId) continue;
    const scheduleItems = taskScheduleItems(task);
    const explicitOccurrenceKeys = new Set<string>();

    for (const item of scheduleItems) {
      const dates = scheduleItemDates(item);
      if (!dates) continue;
      explicitOccurrenceKeys.add(`${taskId}::${dates.occurrenceDate}`);
      if (dates.scheduledDate < startDate || dates.scheduledDate > endDate) continue;
      const row = localScheduleRow(task, dates.occurrenceDate, dates.scheduledDate, item);
      if (row) rows.push(row);
    }

    if (!options.includeGenerated) continue;
    if (options.generatedRequiresTime && !localTaskHasCalendarTime(task)) continue;

    for (const dateKey of dateKeys) {
      if (!options.includeOnceDue && task.recurrence === "ONCE") continue;
      if (!localTaskOccursOnDateKey(task, dateKey)) continue;
      if (explicitOccurrenceKeys.has(`${taskId}::${dateKey}`)) continue;
      if (localOccurrenceHidden(task, dateKey)) continue;
      const key = `${taskId}::${dateKey}::${dateKey}`;
      if (generatedRowKeys.has(key)) continue;
      const row = localScheduleRow(task, dateKey, dateKey);
      if (row) {
        generatedRowKeys.add(key);
        rows.push(row);
      }
    }

    for (const targetDate of localGeneratedMoveTargets(task, startDate, endDate)) {
      if (explicitOccurrenceKeys.has(`${taskId}::${targetDate}`)) continue;
      if (localOccurrenceHidden(task, targetDate)) continue;
      const key = `${taskId}::${targetDate}::${targetDate}`;
      if (generatedRowKeys.has(key)) continue;
      const row = localScheduleRow(task, targetDate, targetDate);
      if (row) {
        generatedRowKeys.add(key);
        rows.push(row);
      }
    }
  }

  rows.sort((a, b) => {
    const scheduled = String(a.scheduledDate ?? "").localeCompare(String(b.scheduledDate ?? ""));
    if (scheduled !== 0) return scheduled;
    const time = String(a.startTime ?? "").localeCompare(String(b.startTime ?? ""));
    if (time !== 0) return time;
    return String(a.title ?? "").localeCompare(String(b.title ?? ""));
  });
  return rows;
}

export function dateRange(startDate: string, endDate: string): string[] {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];
  const days: string[] = [];
  for (let current = start; current <= end; current = new Date(current.getTime() + 24 * 60 * 60 * 1000)) {
    days.push(current.toISOString().slice(0, 10));
  }
  return days;
}

export function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function exportLocalTasksCsv(state: DaemonState): string {
  const headers = [
    "task_name", "context", "base_load_score", "active", "rule_type",
    "due_date", "mon", "tue", "wed", "thu", "fri", "sat", "sun",
    "interval_days", "anchor_date", "month_day", "nth_in_month", "weekday_mon1",
    "start_date", "end_date", "notes", "timezone"
  ];
  const rows = listLocalRemoteDomainItems(state, "tasks", { includeDeleted: false, limit: 1000 }).map((task) => [
    task.title,
    task.context,
    task.baseLoadScore,
    task.active,
    task.recurrence,
    task.dueDate ?? "",
    task.mon ?? false,
    task.tue ?? false,
    task.wed ?? false,
    task.thu ?? false,
    task.fri ?? false,
    task.sat ?? false,
    task.sun ?? false,
    task.intervalDays ?? "",
    task.anchorDate ?? "",
    task.monthDay ?? "",
    task.nthInMonth ?? "",
    uiWeekdayToLbsWeekdayMon1(task.weekdayMon1) ?? "",
    task.activeFrom ?? "",
    task.activeUntil ?? "",
    task.notes ?? "",
    task.timezone ?? ""
  ].map(csvEscape).join(","));
  return [headers.join(","), ...rows].join("\n");
}

export function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    if (quoted) {
      if (char === '"' && csv[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.length > 0) || rows.length === 0) rows.push(row);
  return rows;
}

export function csvBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}

export function csvNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function uiWeekdayToLbsWeekdayMon1(value: unknown): number | undefined {
  const parsed = finiteInteger(value);
  if (parsed === undefined) return undefined;
  if (parsed === 0) return 7;
  if (parsed >= 1 && parsed <= 6) return parsed;
  return undefined;
}

export function lbsWeekdayMon1ToUi(value: unknown): number | undefined {
  const parsed = finiteInteger(value);
  if (parsed === undefined) return undefined;
  if (parsed === 7) return 0;
  if (parsed >= 1 && parsed <= 6) return parsed;
  return undefined;
}

export function csvString(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

export function csvTaskPayload(record: Record<string, string>): Record<string, unknown> | undefined {
  const title = csvString(record.task_name) ?? csvString(record.title);
  const context = csvString(record.context);
  if (!title || !context) return undefined;
  return {
    title,
    context,
    baseLoadScore: csvNumber(record.base_load_score),
    active: csvBoolean(record.active),
    recurrence: csvString(record.rule_type),
    dueDate: csvString(record.due_date),
    mon: csvBoolean(record.mon),
    tue: csvBoolean(record.tue),
    wed: csvBoolean(record.wed),
    thu: csvBoolean(record.thu),
    fri: csvBoolean(record.fri),
    sat: csvBoolean(record.sat),
    sun: csvBoolean(record.sun),
    intervalDays: csvNumber(record.interval_days),
    anchorDate: csvString(record.anchor_date),
    monthDay: csvNumber(record.month_day),
    nthInMonth: csvNumber(record.nth_in_month),
    weekdayMon1: lbsWeekdayMon1ToUi(csvNumber(record.weekday_mon1)),
    activeFrom: csvString(record.start_date),
    activeUntil: csvString(record.end_date),
    notes: record.notes ?? "",
    timezone: csvString(record.timezone)
  };
}

export async function importLocalTasksCsv(state: DaemonState, csv: string): Promise<number> {
  const rows = parseCsvRows(csv);
  const headers = rows.shift()?.map((header) => header.trim()) ?? [];
  let imported = 0;
  for (const row of rows) {
    const record = Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""]));
    const payload = csvTaskPayload(record);
    if (!payload) continue;
    await createLocalTask(state, payload);
    imported += 1;
  }
  return imported;
}

export function localTaskHistory(state: DaemonState, taskId: string): Record<string, unknown>[] {
  const task = localTaskPayloadForUpdate(state, taskId);
  return taskOccurrenceActions(task).map((action, index) => ({
    id: action.id ?? `local-history-${index}`,
    taskId,
    targetDate: action.targetDate ?? action.sourceDate ?? "",
    status: action.status ?? action.operation ?? "",
    createdAt: action.updatedAt ?? action.syncedAt ?? ""
  }));
}

export function localScheduleCalendar(state: DaemonState, startDate: string, endDate: string): Record<string, unknown>[] {
  const rowsByDate = new Map<string, Record<string, unknown>[]>();
  for (const row of localScheduleRows(state, startDate, endDate, {
    includeGenerated: true,
    generatedRequiresTime: true,
    includeOnceDue: false
  })) {
    const scheduledDate = asString(row.scheduledDate);
    if (!scheduledDate) continue;
    const rows = rowsByDate.get(scheduledDate) ?? [];
    rows.push(row);
    rowsByDate.set(scheduledDate, rows);
  }
  return dateRange(startDate, endDate).map((date) => ({
    date,
    items: rowsByDate.get(date) ?? []
  }));
}

export function localTaskSchedule(state: DaemonState, startDate: string, endDate: string, context?: string, status?: string): Record<string, unknown>[] {
  const rowsByDate = new Map<string, Record<string, unknown>[]>();
  for (const row of localScheduleRows(state, startDate, endDate, {
    includeGenerated: true,
    generatedRequiresTime: false,
    includeOnceDue: true
  })) {
    const scheduledDate = asString(row.scheduledDate);
    if (!scheduledDate) continue;
    const rows = rowsByDate.get(scheduledDate) ?? [];
    rows.push(row);
    rowsByDate.set(scheduledDate, rows);
  }
  return dateRange(startDate, endDate).map((date) => {
    const tasks = (rowsByDate.get(date) ?? [])
      .filter((task) => !context || task.context === context)
      .filter((task) => !status || task.status === status)
      .map((task) => ({
        scheduleId: task.scheduleId,
        taskId: task.taskId,
        title: task.title,
        context: task.context,
        status: task.status,
        occurrenceDate: task.occurrenceDate,
        scheduledDate: task.scheduledDate,
        load: task.load,
        startTime: task.startTime,
        endTime: task.endTime,
        timezone: task.timezone,
        isLocked: task.isLocked
      }));
    return {
      date,
      totalLoad: tasks.reduce((sum, task) => sum + (typeof task.load === "number" ? task.load : 0), 0),
      tasks
    };
  });
}

export function enqueueTaskRelationOutbox(
  state: DaemonState,
  input: {
    path: string;
    action: "create" | "update" | "delete";
    taskId: string;
    payload: Record<string, unknown>;
    supersedeReason: string;
    updatedAt: string;
  }
): void {
  supersedeOpenOutboxForPath(state, input.path, () => true, input.supersedeReason, input.updatedAt);
  enqueueManifestOutbox(state.manifestStore, {
    relativePath: input.path,
    domain: "tasks",
    action: input.action,
    resourceId: input.taskId,
    payload: {
      taskId: input.taskId,
      ...input.payload
    }
  });
}

export function applyTaskScheduleResult(
  state: DaemonState,
  item: OutboxItem,
  appliedItem: NonNullable<SyncPushResponse["applied"]>[number],
  now: string
): boolean {
  const relationPayload = taskRelationPayload(item);
  if (!relationPayload || (relationPayload.relation !== "today" && relationPayload.relation !== "scheduleItem")) return false;
  const result = resultRecord(appliedItem.result);
  const taskId = appliedItem.resourceId ?? relationPayload.taskId;
  const localId = scheduleItemId(item.payload.scheduleId) ?? scheduleItemId(item.payload.id);
  const resultId = scheduleItemId(result?.id) ?? scheduleItemId(result?.scheduleId) ?? localId;

  updateTaskScheduleItems(state, taskId, (items) => {
    const identity = {
      scheduleId: resultId ?? localId,
      occurrenceDate: asString(item.payload.occurrenceDate) ?? asString(result?.occurrenceDate),
      scheduledDate: asString(item.payload.scheduledDate) ?? asString(result?.scheduledDate)
    };
    if (item.action === "delete") {
      return items.filter((candidate) => !scheduleItemIdentityMatches(taskId, candidate, identity, "exact"));
    }
    const nextItem = normalizeScheduleItemPayload(taskId, {
      ...item.payload,
      ...(result ?? {}),
      id: resultId ?? localId
    });
    const nextNaturalKey = scheduleItemNaturalKeyValue(taskId, nextItem);
    const nextId = scheduleItemIdValue(nextItem);
    const replaced = items.map((candidate) => {
      const candidateId = scheduleItemIdValue(candidate);
      const candidateNaturalKey = scheduleItemNaturalKeyValue(taskId, candidate);
      return candidateId === localId
        || candidateId === resultId
        || (nextNaturalKey !== undefined && candidateNaturalKey === nextNaturalKey)
        ? nextItem
        : candidate;
    });
    return replaced.some((candidate) => (
      (nextId !== undefined && scheduleItemIdValue(candidate) === nextId)
      || (nextNaturalKey !== undefined && scheduleItemNaturalKeyValue(taskId, candidate) === nextNaturalKey)
    ))
      ? replaced
      : [...replaced, nextItem];
  }, now);
  return true;
}

export function applyTaskSubtaskResult(
  state: DaemonState,
  item: OutboxItem,
  appliedItem: NonNullable<SyncPushResponse["applied"]>[number],
  now: string
): boolean {
  const relationPayload = taskRelationPayload(item);
  if (!relationPayload || relationPayload.relation !== "subtask") return false;
  const result = resultRecord(appliedItem.result);
  const taskId = appliedItem.resourceId ?? relationPayload.taskId;
  const localId = asString(item.payload.subtaskId) ?? asString(item.payload.id);
  const resultId = asString(result?.id) ?? asString(result?.subtaskId) ?? localId;

  const task = localTaskPayloadForUpdate(state, taskId);
  if (!task) return true;
  const subtasks = taskSubtasks(task);
  const nextSubtasks = item.action === "delete"
    ? subtasks.filter((candidate) => asString(candidate.id) !== localId && asString(candidate.id) !== resultId)
    : (() => {
      const nextSubtask = {
        ...item.payload,
        ...(result ?? {}),
        id: resultId,
        taskId,
        updatedAt: now
      };
      const replaced = subtasks.map((candidate) => {
        const candidateId = asString(candidate.id);
        return candidateId === localId || candidateId === resultId ? nextSubtask : candidate;
      });
      return replaced.some((candidate) => asString(candidate.id) === resultId)
        ? replaced
        : [...replaced, nextSubtask];
    })();
  upsertLocalTaskPayload(state, taskId, { ...task, subtasks: nextSubtasks }, now);
  return true;
}

export function applyTaskAttachmentResult(
  state: DaemonState,
  item: OutboxItem,
  appliedItem: NonNullable<SyncPushResponse["applied"]>[number],
  now: string
): boolean {
  const relationPayload = taskRelationPayload(item);
  if (!relationPayload || relationPayload.relation !== "attachment") return false;
  const result = resultRecord(appliedItem.result);
  const taskId = appliedItem.resourceId ?? relationPayload.taskId;
  const localId = asString(item.payload.attachmentId) ?? asString(item.payload.id);
  const resultId = asString(result?.id) ?? asString(result?.attachmentId) ?? localId;
  const task = localTaskPayloadForUpdate(state, taskId);
  if (!task) return true;
  const attachments = taskAttachments(task);
  const nextAttachments = item.action === "delete"
    ? attachments.filter((candidate) => asString(candidate.id) !== localId && asString(candidate.id) !== resultId)
    : (() => {
      const nextAttachment = {
        ...item.payload,
        ...(result ?? {}),
        id: resultId,
        taskId,
        updatedAt: now
      };
      const replaced = attachments.map((candidate) => {
        const candidateId = asString(candidate.id);
        return candidateId === localId || candidateId === resultId ? nextAttachment : candidate;
      });
      return replaced.some((candidate) => asString(candidate.id) === resultId)
        ? replaced
        : [...replaced, nextAttachment];
    })();
  upsertLocalTaskPayload(state, taskId, { ...task, attachments: nextAttachments }, now);
  return true;
}

export function applyTaskOccurrenceResult(
  state: DaemonState,
  item: OutboxItem,
  appliedItem: NonNullable<SyncPushResponse["applied"]>[number],
  now: string
): boolean {
  const relationPayload = taskRelationPayload(item);
  if (!relationPayload || relationPayload.relation !== "occurrence") return false;
  const taskId = appliedItem.resourceId ?? relationPayload.taskId;
  const task = localTaskPayloadForUpdate(state, taskId);
  if (!task) return true;
  const occurrence = {
    ...item.payload,
    ...(resultRecord(appliedItem.result) ?? {}),
    taskId,
    syncedAt: now
  };
  upsertLocalTaskPayload(state, taskId, {
    ...task,
    ...(shouldUpdateTaskStatusFromOccurrence(task, asString(item.payload.operation) ?? "", item.payload.status) ? { status: item.payload.status } : {}),
    occurrenceActions: [...taskOccurrenceActions(task), occurrence]
  }, now);
  return true;
}

export function applyTaskRelationPushResult(
  state: DaemonState,
  item: OutboxItem,
  appliedItem: NonNullable<SyncPushResponse["applied"]>[number],
  now: string
): boolean {
  return applyTaskPinPushResult(state, item, appliedItem, now)
    || applyTaskScheduleResult(state, item, appliedItem, now)
    || applyTaskSubtaskResult(state, item, appliedItem, now)
    || applyTaskAttachmentResult(state, item, appliedItem, now)
    || applyTaskOccurrenceResult(state, item, appliedItem, now);
}

export function enqueueLocalTaskPinOutbox(state: DaemonState, id: string, pinned: boolean, now: string): void {
  const outboxPath = taskRelationOutboxPath(id, "pin");
  supersedeOpenOutboxForPath(
    state,
    outboxPath,
    () => true,
    "Local task pin was changed through daemon facade; stale pin operation was superseded.",
    now
  );
  enqueueManifestOutbox(state.manifestStore, {
    relativePath: outboxPath,
    domain: "tasks",
    action: "update",
    resourceId: id,
    payload: {
      relation: "pin",
      taskId: id,
      pinned
    }
  });
}

export function enqueueLocalScheduleItemWriteOutbox(
  state: DaemonState,
  taskId: string,
  item: Record<string, unknown>,
  updatedAt: string,
  supersedeReason: string
): void {
  const scheduleId = scheduleItemIdValue(item);
  if (scheduleId === undefined) return;
  enqueueTaskRelationOutbox(state, {
    path: scheduleItemOutboxPath(taskId, scheduleId),
    action: scheduleId < 0 ? "create" : "update",
    taskId,
    payload: {
      relation: scheduleId < 0 ? "today" : "scheduleItem",
      scheduleId,
      id: scheduleId,
      ...item
    },
    supersedeReason,
    updatedAt
  });
}

export async function addLocalTaskToToday(
  state: DaemonState,
  taskId: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const now = new Date().toISOString();
  const task = localTaskPayloadForUpdate(state, taskId);
  if (!task || task.deleted === true) return undefined;
  const scheduledDate = asString(input.scheduledDate) ?? new Date().toISOString().slice(0, 10);
  const occurrenceDate = asString(input.occurrenceDate) ?? scheduledDate;
  const inputScheduleId = scheduleItemId(input.scheduleId) ?? scheduleItemId(input.id);
  const existing = taskScheduleItems(task).find((candidate) =>
    scheduleItemIdentityMatches(taskId, candidate, {
      scheduleId: inputScheduleId,
      occurrenceDate,
      scheduledDate
    }, "upsert")
  );
  const item = normalizeScheduleItemPayload(taskId, {
    ...input,
    occurrenceDate,
    scheduledDate
  }, existing);
  const scheduleId = scheduleItemIdValue(item);
  if (scheduleId === undefined) return undefined;
  updateTaskScheduleItems(state, taskId, (items) => {
    let inserted = false;
    const nextItems: Record<string, unknown>[] = [];
    for (const candidate of items) {
      const candidateId = scheduleItemIdValue(candidate);
      const sameId = candidateId !== undefined && candidateId === scheduleId;
      const sameInputId = inputScheduleId !== undefined && inputScheduleId > 0 && candidateId === inputScheduleId;
      const sameNaturalKey = scheduleItemNaturalKeyValue(taskId, candidate) === scheduleItemNaturalKey(taskId, occurrenceDate, scheduledDate);
      if (sameId || sameInputId || sameNaturalKey) {
        if (!inserted) {
          nextItems.push(item);
          inserted = true;
        }
        continue;
      }
      nextItems.push(candidate);
    }
    if (!inserted) nextItems.push(item);
    return nextItems;
  }, now);
  enqueueLocalScheduleItemWriteOutbox(
    state,
    taskId,
    item,
    now,
    "Local task schedule item was recreated; stale schedule operation was superseded."
  );
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return item;
}

export async function removeLocalTaskFromToday(
  state: DaemonState,
  taskId: string,
  scheduledDate: string,
  occurrenceDate?: string,
  scheduleId?: number
): Promise<Record<string, unknown> | undefined> {
  const now = new Date().toISOString();
  const task = localTaskPayloadForUpdate(state, taskId);
  if (!task || task.deleted === true) return undefined;
  const exactIdentityAvailable = scheduleId !== undefined || Boolean(occurrenceDate);
  const identity = { scheduleId, occurrenceDate, scheduledDate };
  const matches = (item: Record<string, unknown>): boolean => {
    if (exactIdentityAvailable) return scheduleItemIdentityMatches(taskId, item, identity, "exact");
    return scheduleItemDates(item)?.scheduledDate === scheduledDate;
  };
  const existing = taskScheduleItems(task).filter(matches);
  if (existing.length === 0) return { taskId, scheduledDate, occurrenceDate, scheduleId, removed: 0 };
  updateTaskScheduleItems(state, taskId, (items) => items.filter((item) => !matches(item)), now);
  for (const item of existing) {
    const itemScheduleId = scheduleItemIdValue(item);
    if (itemScheduleId === undefined) continue;
    const dates = scheduleItemDates(item);
    const path = scheduleItemOutboxPath(taskId, itemScheduleId);
    supersedeOpenOutboxForPath(
      state,
      path,
      () => true,
      "Local task schedule item was removed; stale schedule operation was superseded.",
      now
    );
    if (itemScheduleId > 0) {
      enqueueManifestOutbox(state.manifestStore, {
        relativePath: path,
        domain: "tasks",
        action: "delete",
        resourceId: taskId,
        payload: {
          relation: "today",
          taskId,
          scheduleId: itemScheduleId,
          id: itemScheduleId,
          scheduledDate: dates?.scheduledDate ?? scheduledDate,
          occurrenceDate: dates?.occurrenceDate ?? occurrenceDate ?? scheduledDate
        }
      });
    }
  }
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return { taskId, scheduledDate, occurrenceDate, scheduleId, removed: existing.length };
}

export async function updateLocalTaskScheduleItem(
  state: DaemonState,
  scheduleId: number,
  input: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const found = findLocalScheduleItem(state, scheduleId);
  if (!found) return undefined;
  const now = new Date().toISOString();
  const draftItem = normalizeScheduleItemPayload(found.taskId, { ...found.item, ...input, id: scheduleId }, found.item);
  const draftNaturalKey = scheduleItemNaturalKeyValue(found.taskId, draftItem);
  const conflictItem = draftNaturalKey
    ? taskScheduleItems(found.task).find((candidate) => (
      scheduleItemIdValue(candidate) !== scheduleId
      && scheduleItemNaturalKeyValue(found.taskId, candidate) === draftNaturalKey
    ))
    : undefined;
  const item = conflictItem
    ? normalizeScheduleItemPayload(found.taskId, {
      ...conflictItem,
      ...input,
      id: scheduleItemIdValue(conflictItem),
      scheduleId: scheduleItemIdValue(conflictItem)
    }, conflictItem)
    : draftItem;
  const itemId = scheduleItemIdValue(item);
  const itemNaturalKey = scheduleItemNaturalKeyValue(found.taskId, item);
  updateTaskScheduleItems(state, found.taskId, (items) => {
    let inserted = false;
    const nextItems: Record<string, unknown>[] = [];
    for (const candidate of items) {
      const candidateId = scheduleItemIdValue(candidate);
      const sameOriginal = candidateId === scheduleId;
      const sameTargetId = itemId !== undefined && candidateId === itemId;
      const sameNaturalKey = itemNaturalKey !== undefined
        && scheduleItemNaturalKeyValue(found.taskId, candidate) === itemNaturalKey;
      if (sameOriginal || sameTargetId || sameNaturalKey) {
        if (!inserted) {
          nextItems.push(item);
          inserted = true;
        }
        continue;
      }
      nextItems.push(candidate);
    }
    if (!inserted) nextItems.push(item);
    return nextItems;
  }, now);
  enqueueLocalScheduleItemWriteOutbox(
    state,
    found.taskId,
    item,
    now,
    "Local task schedule item was updated; stale schedule operation was superseded."
  );
  if (conflictItem) {
    const path = scheduleItemOutboxPath(found.taskId, scheduleId);
    supersedeOpenOutboxForPath(
      state,
      path,
      () => true,
      "Local task schedule item was merged into another occurrence membership; stale schedule operation was superseded.",
      now
    );
    if (scheduleId > 0) {
      enqueueManifestOutbox(state.manifestStore, {
        relativePath: path,
        domain: "tasks",
        action: "delete",
        resourceId: found.taskId,
        payload: {
          relation: "scheduleItem",
          taskId: found.taskId,
          scheduleId,
          id: scheduleId,
          scheduledDate: found.item.scheduledDate,
          occurrenceDate: found.item.occurrenceDate
        }
      });
    }
  }
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return item;
}

export async function removeLocalTaskScheduleItem(state: DaemonState, scheduleId: number): Promise<boolean> {
  const found = findLocalScheduleItem(state, scheduleId);
  if (!found) return false;
  const now = new Date().toISOString();
  updateTaskScheduleItems(state, found.taskId, (items) => items.filter((item) => scheduleItemIdValue(item) !== scheduleId), now);
  const path = scheduleItemOutboxPath(found.taskId, scheduleId);
  supersedeOpenOutboxForPath(
    state,
    path,
    () => true,
    "Local task schedule item was removed; stale schedule operation was superseded.",
    now
  );
  if (scheduleId > 0) {
    enqueueManifestOutbox(state.manifestStore, {
      relativePath: path,
      domain: "tasks",
      action: "delete",
      resourceId: found.taskId,
      payload: {
        relation: "scheduleItem",
        taskId: found.taskId,
        scheduleId,
        id: scheduleId,
        scheduledDate: found.item.scheduledDate,
        occurrenceDate: found.item.occurrenceDate
      }
    });
  }
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return true;
}

export async function recordLocalTaskOccurrence(
  state: DaemonState,
  taskId: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const task = localTaskPayloadForUpdate(state, taskId);
  if (!task || task.deleted === true) return undefined;
  const rawOperation = asString(input.operation);
  const operation = rawOperation === "skip-exception" ? "skipException" : rawOperation;
  const targetDate = asString(input.targetDate);
  if (!operation || !targetDate) return undefined;
  const now = new Date().toISOString();
  const sourceDate = asString(input.sourceDate);
  const occurrenceDate = operation === "move" ? sourceDate ?? targetDate : targetDate;
  const occurrence = {
    relation: "occurrence",
    taskId,
    ...input,
    operation,
    targetDate,
    occurrenceDate,
    updatedAt: now
  };
  const movedScheduleItems: Record<string, unknown>[] = [];
  let scheduleItems = taskScheduleItems(task);
  if (operation === "move" && sourceDate && sourceDate !== targetDate) {
    scheduleItems = scheduleItems.map((item) => {
      const dates = scheduleItemDates(item);
      if (!dates || dates.occurrenceDate !== sourceDate) return item;
      const moved = normalizeScheduleItemPayload(taskId, {
        ...item,
        occurrenceDate: targetDate
      }, item);
      movedScheduleItems.push(moved);
      return moved;
    });
  }
  upsertLocalTaskPayload(state, taskId, {
    ...task,
    ...(shouldUpdateTaskStatusFromOccurrence(task, operation, input.status) ? { status: input.status } : {}),
    scheduleItems,
    occurrenceActions: [...taskOccurrenceActions(task), occurrence]
  }, now);
  for (const item of movedScheduleItems) {
    enqueueLocalScheduleItemWriteOutbox(
      state,
      taskId,
      item,
      now,
      "Local task occurrence was moved; stale schedule operation was superseded."
    );
  }
  enqueueTaskRelationOutbox(state, {
    path: occurrenceOutboxPath(taskId, operation, targetDate),
    action: "update",
    taskId,
    payload: occurrence,
    supersedeReason: "Local task occurrence was updated; stale occurrence operation was superseded.",
    updatedAt: now
  });
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  if (operation === "move") {
    return { taskId, sourceDate: input.sourceDate, targetDate };
  }
  if (operation === "skipException") {
    return { taskId, targetDate };
  }
  return { taskId, targetDate, status: input.status };
}

export async function createLocalTaskSubtask(
  state: DaemonState,
  taskId: string,
  occurrenceDate: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const task = localTaskPayloadForUpdate(state, taskId);
  if (!task || task.deleted === true) return undefined;
  const title = asString(input.title);
  if (!title) return undefined;
  const now = new Date().toISOString();
  const subtask = {
    id: localSubtaskId(),
    taskId,
    occurrenceDate,
    title,
    isDone: false,
    sortOrder: taskSubtasks(task).length,
    createdAt: now,
    updatedAt: now
  };
  upsertLocalTaskPayload(state, taskId, { ...task, subtasks: [...taskSubtasks(task), subtask] }, now);
  enqueueTaskRelationOutbox(state, {
    path: subtaskOutboxPath(taskId, occurrenceDate, subtask.id),
    action: "create",
    taskId,
    payload: {
      relation: "subtask",
      subtaskId: subtask.id,
      ...subtask
    },
    supersedeReason: "Local task subtask was recreated; stale subtask operation was superseded.",
    updatedAt: now
  });
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return subtask;
}

export async function updateLocalTaskSubtask(
  state: DaemonState,
  taskId: string,
  occurrenceDate: string,
  subtaskId: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const task = localTaskPayloadForUpdate(state, taskId);
  if (!task || task.deleted === true) return undefined;
  const existing = taskSubtasks(task).find((item) => asString(item.id) === subtaskId && item.occurrenceDate === occurrenceDate);
  if (!existing) return undefined;
  const now = new Date().toISOString();
  const subtask = {
    ...existing,
    ...(typeof input.title === "string" ? { title: input.title } : {}),
    ...(typeof input.isDone === "boolean" ? { isDone: input.isDone } : {}),
    ...(typeof input.sortOrder === "number" ? { sortOrder: input.sortOrder } : {}),
    updatedAt: now
  };
  upsertLocalTaskPayload(state, taskId, {
    ...task,
    subtasks: taskSubtasks(task).map((item) => asString(item.id) === subtaskId ? subtask : item)
  }, now);
  enqueueTaskRelationOutbox(state, {
    path: subtaskOutboxPath(taskId, occurrenceDate, subtaskId),
    action: subtaskId.startsWith("local-subtask-") ? "create" : "update",
    taskId,
    payload: {
      relation: "subtask",
      subtaskId,
      ...subtask
    },
    supersedeReason: "Local task subtask was updated; stale subtask operation was superseded.",
    updatedAt: now
  });
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return subtask;
}

export async function deleteLocalTaskSubtask(
  state: DaemonState,
  taskId: string,
  occurrenceDate: string,
  subtaskId: string
): Promise<boolean> {
  const task = localTaskPayloadForUpdate(state, taskId);
  if (!task || task.deleted === true) return false;
  const existing = taskSubtasks(task).find((item) => asString(item.id) === subtaskId && item.occurrenceDate === occurrenceDate);
  if (!existing) return false;
  const now = new Date().toISOString();
  upsertLocalTaskPayload(state, taskId, {
    ...task,
    subtasks: taskSubtasks(task).filter((item) => asString(item.id) !== subtaskId)
  }, now);
  const path = subtaskOutboxPath(taskId, occurrenceDate, subtaskId);
  supersedeOpenOutboxForPath(
    state,
    path,
    () => true,
    "Local task subtask was removed; stale subtask operation was superseded.",
    now
  );
  if (!subtaskId.startsWith("local-subtask-")) {
    enqueueManifestOutbox(state.manifestStore, {
      relativePath: path,
      domain: "tasks",
      action: "delete",
      resourceId: taskId,
      payload: {
        relation: "subtask",
        taskId,
        occurrenceDate,
        subtaskId,
        id: subtaskId
      }
    });
  }
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return true;
}

export async function createLocalTaskAttachment(
  state: DaemonState,
  taskId: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const task = localTaskPayloadForUpdate(state, taskId);
  if (!task || task.deleted === true) return undefined;
  const filename = asString(input.filename) ?? asString(input.originalFilename);
  const contentBase64 = asString(input.contentBase64);
  if (!filename || !contentBase64) return undefined;
  const now = new Date().toISOString();
  const buffer = Buffer.from(contentBase64, "base64");
  const attachment = {
    id: `local-attachment-${randomUUID()}`,
    taskId,
    filename,
    mimeType: asString(input.mimeType) ?? "application/octet-stream",
    sizeBytes: buffer.byteLength,
    contentBase64,
    createdAt: now,
    updatedAt: now
  };
  upsertLocalTaskPayload(state, taskId, { ...task, attachments: [...taskAttachments(task), attachment] }, now);
  enqueueTaskRelationOutbox(state, {
    path: attachmentOutboxPath(taskId, attachment.id),
    action: "create",
    taskId,
    payload: {
      relation: "attachment",
      attachmentId: attachment.id,
      ...attachment
    },
    supersedeReason: "Local task attachment was recreated; stale attachment operation was superseded.",
    updatedAt: now
  });
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return attachment;
}

export async function updateLocalTaskAttachment(
  state: DaemonState,
  taskId: string,
  attachmentId: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const task = localTaskPayloadForUpdate(state, taskId);
  if (!task || task.deleted === true) return undefined;
  const existing = taskAttachments(task).find((item) => asString(item.id) === attachmentId);
  if (!existing) return undefined;
  const contentBase64 = asString(input.contentBase64) ?? asString(existing.contentBase64);
  if (!contentBase64) return undefined;
  const now = new Date().toISOString();
  const buffer = Buffer.from(contentBase64, "base64");
  const attachment = {
    ...existing,
    filename: asString(input.filename) ?? asString(existing.filename) ?? attachmentId,
    mimeType: asString(input.mimeType) ?? asString(existing.mimeType) ?? "application/octet-stream",
    sizeBytes: buffer.byteLength,
    contentBase64,
    updatedAt: now
  };
  upsertLocalTaskPayload(state, taskId, {
    ...task,
    attachments: taskAttachments(task).map((item) => asString(item.id) === attachmentId ? attachment : item)
  }, now);
  enqueueTaskRelationOutbox(state, {
    path: attachmentOutboxPath(taskId, attachmentId),
    action: attachmentId.startsWith("local-attachment-") ? "create" : "update",
    taskId,
    payload: {
      relation: "attachment",
      attachmentId,
      ...attachment
    },
    supersedeReason: "Local task attachment was updated; stale attachment operation was superseded.",
    updatedAt: now
  });
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return attachment;
}

export async function deleteLocalTaskAttachment(state: DaemonState, taskId: string, attachmentId: string): Promise<boolean> {
  const task = localTaskPayloadForUpdate(state, taskId);
  if (!task || task.deleted === true) return false;
  const existing = taskAttachments(task).find((item) => asString(item.id) === attachmentId);
  if (!existing) return false;
  const now = new Date().toISOString();
  upsertLocalTaskPayload(state, taskId, {
    ...task,
    attachments: taskAttachments(task).filter((item) => asString(item.id) !== attachmentId)
  }, now);
  const path = attachmentOutboxPath(taskId, attachmentId);
  supersedeOpenOutboxForPath(
    state,
    path,
    () => true,
    "Local task attachment was removed; stale attachment operation was superseded.",
    now
  );
  if (!attachmentId.startsWith("local-attachment-")) {
    enqueueManifestOutbox(state.manifestStore, {
      relativePath: path,
      domain: "tasks",
      action: "delete",
      resourceId: taskId,
      payload: {
        relation: "attachment",
        taskId,
        attachmentId,
        id: attachmentId
      }
    });
  }
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return true;
}

export async function createLocalTask(state: DaemonState, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = `${LOCAL_TASK_ID_PREFIX}${randomUUID()}`;
  const payload: Record<string, unknown> = {
    ...normalizeLocalTaskPayload(state, input),
    id
  };
  const now = new Date().toISOString();
  const outboxPath = taskOutboxPath(id);
  supersedeOpenOutboxForPath(
    state,
    outboxPath,
    () => true,
    "Local task was recreated through daemon facade; stale task operation was superseded.",
    now
  );
  enqueueManifestOutbox(state.manifestStore, {
    relativePath: outboxPath,
    domain: "tasks",
    action: "create",
    resourceId: id,
    payload
  });
  upsertRemoteResource(state.manifestStore, {
    domain: "tasks",
    resourceId: id,
    payload,
    updatedAt: asString(payload.updatedAt) ?? now
  });
  if (payload.isPinned === true) {
    enqueueLocalTaskPinOutbox(state, id, true, now);
  }
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return payload;
}

export async function updateLocalTask(
  state: DaemonState,
  id: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const existing = localRemoteDomainItem(state, "tasks", id);
  if (!existing) return undefined;
  const now = new Date().toISOString();
  const payload: Record<string, unknown> = {
    ...normalizeLocalTaskPayload(state, input, existing),
    id
  };
  const outboxPath = taskOutboxPath(id);
  const action = isLocalTaskId(id) ? "create" : "update";
  supersedeOpenOutboxForPath(
    state,
    outboxPath,
    () => true,
    "Local task was updated through daemon facade; stale task operation was superseded.",
    now
  );
  enqueueManifestOutbox(state.manifestStore, {
    relativePath: outboxPath,
    domain: "tasks",
    action,
    resourceId: id,
    payload
  });
  upsertRemoteResource(state.manifestStore, {
    domain: "tasks",
    resourceId: id,
    version: asNumber(existing.version),
    payload,
    updatedAt: asString(payload.updatedAt) ?? now,
    lastSyncedAt: asString(existing.lastSyncedAt)
  });
  if (typeof input.isPinned === "boolean") {
    enqueueLocalTaskPinOutbox(state, id, input.isPinned, now);
  }
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return payload;
}

export async function deleteLocalTask(state: DaemonState, id: string): Promise<boolean> {
  const existing = localRemoteDomainItem(state, "tasks", id);
  if (!existing) return false;
  const now = new Date().toISOString();
  const outboxPath = taskOutboxPath(id);
  supersedeOpenOutboxForPath(
    state,
    outboxPath,
    () => true,
    "Local task was deleted through daemon facade; stale task operation was superseded.",
    now
  );
  for (const item of listOpenOutboxForResource(state.manifestStore, id)) {
    if (item.domain === "tasks" && asString(item.payload.relation)) {
      markOutboxSuperseded(
        state.manifestStore,
        item.id,
        "Local task was deleted before a related task operation synced; stale relation operation was superseded.",
        now
      );
    }
  }

  if (isLocalTaskId(id)) {
    removeRemoteResource(state.manifestStore, "tasks", id);
  } else {
    enqueueManifestOutbox(state.manifestStore, {
      relativePath: outboxPath,
      domain: "tasks",
      action: "delete",
      resourceId: id,
      payload: existing
    });
    markRemoteResourceDeleted(state.manifestStore, {
      domain: "tasks",
      resourceId: id,
      version: asNumber(existing.version),
      payload: existing,
      deletedAt: now,
      lastSyncedAt: asString(existing.lastSyncedAt)
    });
  }

  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return true;
}

export async function setLocalTaskPin(state: DaemonState, id: string, pinned: boolean): Promise<Record<string, unknown> | undefined> {
  const existing = localRemoteDomainItem(state, "tasks", id);
  if (!existing) return undefined;
  const now = new Date().toISOString();
  const payload = {
    ...existing,
    id,
    isPinned: pinned,
    updatedAt: now
  };
  enqueueLocalTaskPinOutbox(state, id, pinned, now);
  upsertRemoteResource(state.manifestStore, {
    domain: "tasks",
    resourceId: id,
    version: asNumber(existing.version),
    payload,
    updatedAt: now,
    lastSyncedAt: asString(existing.lastSyncedAt)
  });
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return { taskId: id, pinned };
}

