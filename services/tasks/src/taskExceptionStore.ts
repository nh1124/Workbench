import type { LbsClient } from "./lbsClient.js";
import { createLbsClient, getLbsConfig, toDueDateOnly } from "./lbsTaskService.js";

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
