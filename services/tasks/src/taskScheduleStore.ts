import { listPinnedTaskIds } from "./db.js";
import {
  type ScheduleItemRow,
  addScheduleItem,
  listItemsByDateRange,
  listItemsByScheduledDate,
  removeItemsByTaskAndScheduledDate,
  updateItem as updateScheduleItemInStore
} from "./scheduleItemsStore.js";
import {
  applyResolvedStatus,
  createLbsClient,
  getLbsConfig,
  normalizeResponseTask,
  type LbsTask
} from "./lbsTaskService.js";
import type {
  ScheduleCalendarDay,
  ScheduleCalendarItem,
  TodayTask
} from "./types.js";

export interface ScheduleItemInput {
  taskId: string;
  occurrenceDate: string;
  scheduledDate: string;
  startTime?: string;
  endTime?: string;
  timezone?: string;
}

/**
 * List Today tasks for the given date.
 *
 * Merges:
 * 1) explicit schedule entries in task_occurrence_schedule,
 * 2) LBS due tasks for this date that are not explicitly scheduled.
 */
export async function listTaskToday(
  ownerUsername: string,
  date: string,
  lbsAccessToken: string
): Promise<TodayTask[]> {
  console.log(`[tasks-service] listTaskToday owner=${ownerUsername} date=${date}`);

  const config = getLbsConfig();
  const client = createLbsClient(config, lbsAccessToken);
  const pinnedIds = new Set(await listPinnedTaskIds(ownerUsername));

  const scheduleItems = await listItemsByScheduledDate(ownerUsername, date);
  console.log(`[tasks-service] listTaskToday explicit schedule items=${scheduleItems.length} date=${date}`);

  const resolveEntry = async (
    taskId: string,
    occurrenceDate: string,
    scheduleItem?: ScheduleItemRow
  ): Promise<TodayTask | null> => {
    try {
      const raw = (await client.getTask(taskId)) as unknown as LbsTask;
      const normalized = normalizeResponseTask(raw);
      const resolved = await applyResolvedStatus(
        normalized,
        lbsAccessToken,
        config.timezone,
        occurrenceDate
      );
      return {
        ...resolved,
        isPinned: pinnedIds.has(resolved.id),
        occurrenceDate,
        scheduledDate: scheduleItem?.scheduledDate ?? date,
        scheduleId: scheduleItem?.id,
        startTime: scheduleItem?.startTime,
        endTime: scheduleItem?.endTime,
        timezone: scheduleItem?.timezone
      };
    } catch (error) {
      console.warn(
        `[tasks-service] listTaskToday skipping ${taskId}@${occurrenceDate}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  };

  const explicitTasks = await Promise.all(
    scheduleItems.map((item) => resolveEntry(item.taskId, item.occurrenceDate, item))
  );

  const result = explicitTasks.filter(
    (task): task is TodayTask => task !== null
  );
  console.log(`[tasks-service] listTaskToday returning=${result.length} date=${date}`);
  return result;
}

/**
 * Add a schedule item ("add to today" / "schedule to date").
 */
export async function addTaskToToday(
  ownerUsername: string,
  taskId: string,
  scheduledDate: string,
  occurrenceDate: string,
  opts?: { startTime?: string; endTime?: string; timezone?: string }
): Promise<ScheduleItemRow> {
  const effectiveOccurrenceDate = occurrenceDate || scheduledDate;
  console.log(
    `[tasks-service] addTaskToToday owner=${ownerUsername} taskId=${taskId} scheduledDate=${scheduledDate} occurrenceDate=${effectiveOccurrenceDate}`
  );
  const result = await addScheduleItem(
    ownerUsername,
    taskId,
    effectiveOccurrenceDate,
    scheduledDate,
    opts
  );
  console.log(`[tasks-service] addTaskToToday created scheduleId=${result.id}`);
  return result;
}

/**
 * Update an existing schedule item's fields.
 */
export async function updateTaskScheduleItem(
  ownerUsername: string,
  scheduleId: number,
  patch: {
    scheduledDate?: string;
    occurrenceDate?: string;
    startTime?: string | null;
    endTime?: string | null;
    timezone?: string | null;
  }
): Promise<ScheduleItemRow | undefined> {
  console.log(
    `[tasks-service] updateTaskScheduleItem owner=${ownerUsername} scheduleId=${scheduleId}`
  );
  return updateScheduleItemInStore(ownerUsername, scheduleId, patch);
}

/**
 * Remove explicit schedule items for task + date.
 */
export async function removeTaskFromToday(
  ownerUsername: string,
  taskId: string,
  scheduledDate: string
): Promise<{ taskId: string; scheduledDate: string; removed: number }> {
  console.log(
    `[tasks-service] removeTaskFromToday owner=${ownerUsername} taskId=${taskId} scheduledDate=${scheduledDate}`
  );
  const removed = await removeItemsByTaskAndScheduledDate(
    ownerUsername,
    taskId,
    scheduledDate
  );
  console.log(`[tasks-service] removeTaskFromToday removed=${removed}`);
  return { taskId, scheduledDate, removed };
}

/**
 * List scheduled calendar items in [startDate, endDate].
 */
export async function listTaskScheduleCalendar(
  ownerUsername: string,
  startDate: string,
  endDate: string,
  lbsAccessToken: string
): Promise<ScheduleCalendarDay[]> {
  console.log(
    `[tasks-service] listTaskScheduleCalendar owner=${ownerUsername} ${startDate}->${endDate}`
  );

  const items = await listItemsByDateRange(ownerUsername, startDate, endDate);
  if (items.length === 0) return [];

  const config = getLbsConfig();
  const client = createLbsClient(config, lbsAccessToken);

  const resolved = await Promise.all(
    items.map(async (item): Promise<ScheduleCalendarItem | null> => {
      try {
        const raw = (await client.getTask(item.taskId)) as unknown as LbsTask;
        const normalized = normalizeResponseTask(raw);
        const withStatus = await applyResolvedStatus(
          normalized,
          lbsAccessToken,
          config.timezone,
          item.occurrenceDate
        );
        return {
          scheduleId: item.id,
          taskId: item.taskId,
          title: withStatus.title,
          context: withStatus.context,
          status: withStatus.status,
          occurrenceDate: item.occurrenceDate,
          scheduledDate: item.scheduledDate,
          startTime: item.startTime,
          endTime: item.endTime,
          timezone: item.timezone
        };
      } catch (error) {
        console.warn(
          `[tasks-service] listTaskScheduleCalendar skipping ${item.taskId}@${item.occurrenceDate}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return null;
      }
    })
  );

  const byDate = new Map<string, ScheduleCalendarItem[]>();
  for (const item of resolved) {
    if (!item) continue;
    const list = byDate.get(item.scheduledDate) ?? [];
    list.push(item);
    byDate.set(item.scheduledDate, list);
  }

  const days: ScheduleCalendarDay[] = [];
  for (const [date, dateItems] of [...byDate.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    days.push({ date, items: dateItems });
  }
  console.log(`[tasks-service] listTaskScheduleCalendar returning days=${days.length}`);
  return days;
}

export type { ScheduleItemRow };
