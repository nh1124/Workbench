/**
 * Schedule items store — wraps DB CRUD with owner normalization.
 *
 * A "schedule item" maps a task occurrence (occurrence_date = LBS execution date)
 * to a calendar day the user intends to work on it (scheduled_date).
 * It optionally carries time info (start_time, end_time, timezone).
 *
 * Today view = all items where scheduled_date = today
 *            ∪ LBS-due tasks (occurrence_date = today) not already in the above set.
 * Schedule calendar view = items grouped by scheduled_date over a date range.
 */

import {
  type ScheduleItemRow,
  createScheduleItem,
  updateScheduleItem,
  deleteScheduleItem,
  deleteScheduleItemsByTaskAndScheduledDate,
  listScheduleItemsByScheduledDate,
  listScheduleItemsByDateRange,
  listScheduleItemsByTask
} from "./db.js";

export type { ScheduleItemRow };

function normalizeOwner(ownerCoreUserId: string): string {
  return ownerCoreUserId.trim().toLowerCase();
}

/** Return all schedule items whose scheduled_date matches the given date. */
export async function listItemsByScheduledDate(
  ownerCoreUserId: string,
  scheduledDate: string
): Promise<ScheduleItemRow[]> {
  return listScheduleItemsByScheduledDate(normalizeOwner(ownerCoreUserId), scheduledDate);
}

/** Return all schedule items in a date range (for the Schedule calendar view). */
export async function listItemsByDateRange(
  ownerCoreUserId: string,
  startDate: string,
  endDate: string
): Promise<ScheduleItemRow[]> {
  return listScheduleItemsByDateRange(normalizeOwner(ownerCoreUserId), startDate, endDate);
}

/** Return all schedule items for a specific task (all occurrences). */
export async function listItemsByTask(
  ownerCoreUserId: string,
  taskId: string
): Promise<ScheduleItemRow[]> {
  return listScheduleItemsByTask(normalizeOwner(ownerCoreUserId), taskId);
}

/**
 * Add a schedule item.
 * scheduledDate = the date the user plans to work on the task (Today's date when called via "My Day").
 * occurrenceDate = LBS execution date (for completion).
 */
export async function addScheduleItem(
  ownerCoreUserId: string,
  taskId: string,
  occurrenceDate: string,
  scheduledDate: string,
  opts?: { startTime?: string; endTime?: string; timezone?: string }
): Promise<ScheduleItemRow> {
  return createScheduleItem(normalizeOwner(ownerCoreUserId), taskId, occurrenceDate, scheduledDate, opts);
}

/**
 * Update an existing schedule item by id.
 */
export async function updateItem(
  ownerCoreUserId: string,
  id: number,
  patch: {
    scheduledDate?: string;
    occurrenceDate?: string;
    startTime?: string | null;
    endTime?: string | null;
    timezone?: string | null;
  }
): Promise<ScheduleItemRow | undefined> {
  return updateScheduleItem(normalizeOwner(ownerCoreUserId), id, patch);
}

/**
 * Delete a single schedule item by id.
 */
export async function removeScheduleItem(
  ownerCoreUserId: string,
  id: number
): Promise<boolean> {
  return deleteScheduleItem(normalizeOwner(ownerCoreUserId), id);
}

/**
 * Remove all schedule items for a task on a given scheduled_date.
 * Used when the user removes a task from Today via the "remove from My Day" button.
 */
export async function removeItemsByTaskAndScheduledDate(
  ownerCoreUserId: string,
  taskId: string,
  scheduledDate: string
): Promise<number> {
  return deleteScheduleItemsByTaskAndScheduledDate(normalizeOwner(ownerCoreUserId), taskId, scheduledDate);
}
