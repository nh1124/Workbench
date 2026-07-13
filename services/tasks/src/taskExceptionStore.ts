import { getLbsBackend } from "./lbs/backendFactory.js";
import type { LbsBackendContext, LbsDataPlane } from "./lbs/dataPlane.js";
import { toDueDateOnly } from "./lbsTaskService.js";

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
  client: LbsDataPlane,
  taskId: string,
  targetDate: string,
  exceptionType: "SKIP" | "FORCE_DO",
  notes: string,
  existing?: Record<string, unknown>
): Promise<number | undefined> {
  const payload = {
    task_id: taskId,
    target_date: targetDate,
    exception_type: exceptionType,
    notes,
    is_locked: false
  };
  const existingId = existing ? extractExceptionId(existing) : undefined;
  if (existingId !== undefined) {
    await client.updateException(
      existingId,
      {
        exception_type: exceptionType,
        notes,
        is_locked: false
      },
      true
    );
    return existingId;
  }

  try {
    const created = await client.createException(payload, true);
    return extractExceptionId(created);
  } catch {
    const listed = await client.listExceptions(taskId, targetDate, targetDate);
    const exact = listed.find((row: Record<string, unknown>) => extractExceptionDate(row) === targetDate);
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
    return exceptionId;
  }
}

function findExceptionForDate(
  exceptions: Record<string, unknown>[],
  targetDate: string
): Record<string, unknown> | undefined {
  return exceptions.find((row) => extractExceptionDate(row) === targetDate);
}

async function restoreTaskException(
  client: LbsDataPlane,
  taskId: string,
  targetDate: string,
  previous: Record<string, unknown> | undefined,
  mutatedExceptionId: number | undefined
): Promise<void> {
  if (previous) {
    const previousId = extractExceptionId(previous);
    if (!previousId) {
      throw new Error(`Cannot restore exception for ${taskId} on ${targetDate}: missing exception id`);
    }
    const restorePayload: Record<string, unknown> = {
      exception_type: previous.exception_type
    };
    if (Object.prototype.hasOwnProperty.call(previous, "notes")) {
      restorePayload.notes = previous.notes;
    }
    if (Object.prototype.hasOwnProperty.call(previous, "is_locked")) {
      restorePayload.is_locked = previous.is_locked;
    }
    await client.updateException(previousId, restorePayload, true);
    return;
  }

  let exceptionId = mutatedExceptionId;
  if (!exceptionId) {
    const listed = await client.listExceptions(taskId, targetDate, targetDate);
    const exact = findExceptionForDate(listed, targetDate);
    exceptionId = exact ? extractExceptionId(exact) : undefined;
  }
  if (!exceptionId) {
    throw new Error(`Cannot remove compensating exception for ${taskId} on ${targetDate}: missing exception id`);
  }
  await client.deleteException(exceptionId, true);
}

export async function moveTaskOccurrence(
  taskId: string,
  sourceDate: string,
  targetDate: string,
  backendContext: LbsBackendContext
): Promise<{ taskId: string; sourceDate: string; targetDate: string }> {
  const client = getLbsBackend(backendContext);
  const normalizedSource = toDueDateOnly(sourceDate);
  const normalizedTarget = toDueDateOnly(targetDate);
  if (!normalizedSource || !normalizedTarget) {
    throw new Error("sourceDate and targetDate must be in YYYY-MM-DD format");
  }
  if (normalizedSource === normalizedTarget) {
    return { taskId, sourceDate: normalizedSource, targetDate: normalizedTarget };
  }

  const [sourceExceptions, targetExceptions] = await Promise.all([
    client.listExceptions(taskId, normalizedSource, normalizedSource),
    client.listExceptions(taskId, normalizedTarget, normalizedTarget)
  ]);
  const previousSource = findExceptionForDate(sourceExceptions, normalizedSource);
  const previousTarget = findExceptionForDate(targetExceptions, normalizedTarget);

  const sourceExceptionId = await upsertTaskException(
    client,
    taskId,
    normalizedSource,
    "SKIP",
    `Moved to ${normalizedTarget}`,
    previousSource
  );
  try {
    await upsertTaskException(
      client,
      taskId,
      normalizedTarget,
      "FORCE_DO",
      `Moved from ${normalizedSource}`,
      previousTarget
    );
  } catch (error) {
    try {
      await restoreTaskException(
        client,
        taskId,
        normalizedSource,
        previousSource,
        sourceExceptionId
      );
    } catch (compensationError) {
      console.error(
        `[tasks-service] failed to compensate occurrence move ${taskId}@${normalizedSource}: ${
          compensationError instanceof Error ? compensationError.message : String(compensationError)
        }`
      );
    }
    throw error;
  }
  return { taskId, sourceDate: normalizedSource, targetDate: normalizedTarget };
}

export async function skipTaskOccurrenceException(
  taskId: string,
  targetDate: string,
  backendContext: LbsBackendContext
): Promise<{ taskId: string; targetDate: string }> {
  const client = getLbsBackend(backendContext);
  const normalizedDate = toDueDateOnly(targetDate);
  if (!normalizedDate) {
    throw new Error("targetDate must be in YYYY-MM-DD format");
  }
  await upsertTaskException(client, taskId, normalizedDate, "SKIP", "Removed via UI");
  return { taskId, targetDate: normalizedDate };
}
