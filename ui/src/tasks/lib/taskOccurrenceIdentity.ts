import type { TaskOccurrenceRow } from "../types";

function encodeKeyPart(value: string | number): string {
  return encodeURIComponent(String(value));
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

export function rowOccurrenceDate(row: Pick<TaskOccurrenceRow, "date" | "occurrenceDate">): string {
  return row.occurrenceDate ?? row.date;
}

export function rowScheduledDate(row: Pick<TaskOccurrenceRow, "date" | "scheduledDate">): string {
  return row.scheduledDate ?? row.date;
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
