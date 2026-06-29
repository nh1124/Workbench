export interface ScheduleNaturalKeyInput {
  taskId: string;
  occurrenceDate: string;
  scheduledDate: string;
}

export interface ScheduleNaturalKey {
  taskId: string;
  occurrenceDate: string;
  scheduledDate: string;
}

export function resolveScheduleOccurrenceDate(
  scheduledDate: string,
  occurrenceDate?: string | null
): string {
  const normalizedScheduledDate = scheduledDate.trim();
  const normalizedOccurrenceDate = occurrenceDate?.trim() ?? "";
  return normalizedOccurrenceDate || normalizedScheduledDate;
}

export function hasExactScheduleOccurrenceDate(
  occurrenceDate?: string | null
): occurrenceDate is string {
  return (occurrenceDate?.trim() ?? "").length > 0;
}

export function normalizeScheduleNaturalKey(
  input: ScheduleNaturalKeyInput
): ScheduleNaturalKey {
  return {
    taskId: input.taskId.trim(),
    occurrenceDate: input.occurrenceDate.trim(),
    scheduledDate: input.scheduledDate.trim()
  };
}
