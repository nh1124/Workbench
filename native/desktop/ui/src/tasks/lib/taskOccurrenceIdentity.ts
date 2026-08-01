import type { TaskOccurrenceRow } from "../types";

function encodeKeyPart(value: string | number): string {
  return encodeURIComponent(String(value));
}

export function normalizeDateKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return normalized;
}

export function scheduleItemKey(scheduleId: string | number): string {
  return `schedule:${encodeKeyPart(scheduleId)}`;
}

export function taskDefinitionRowKey(taskId: string): string {
  return `task:${encodeKeyPart(taskId)}`;
}

export function occurrenceMembershipKey(
  taskId: string,
  occurrenceDate: string,
  scheduledDate: string
): string {
  return [
    "occurrence",
    encodeKeyPart(taskId),
    encodeKeyPart(occurrenceDate),
    encodeKeyPart(scheduledDate)
  ].join(":");
}

export function rowOccurrenceDate(
  row: Pick<TaskOccurrenceRow, "date" | "occurrenceDate">
): string | undefined {
  return normalizeDateKey(row.occurrenceDate) ?? normalizeDateKey(row.date);
}

export function rowScheduledDate(
  row: Pick<TaskOccurrenceRow, "date" | "scheduledDate">
): string | undefined {
  return normalizeDateKey(row.scheduledDate) ?? normalizeDateKey(row.date);
}

export function rowTodayMembershipKey(
  row: Pick<TaskOccurrenceRow, "taskId" | "date" | "occurrenceDate" | "scheduledDate">,
  todayKey: string
): string {
  return occurrenceMembershipKey(row.taskId, rowOccurrenceDate(row) || todayKey, todayKey);
}

export function taskOccurrenceRowKey(identity: {
  taskId: string;
  occurrenceDate: string;
  scheduledDate?: string;
  scheduleId?: number | null;
}): string {
  if (identity.scheduleId != null) return scheduleItemKey(identity.scheduleId);
  return occurrenceMembershipKey(
    identity.taskId,
    identity.occurrenceDate,
    identity.scheduledDate ?? identity.occurrenceDate
  );
}
