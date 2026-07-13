import { listPinnedTaskIds } from "./db.js";
import {
  type ScheduleItemRow,
  addScheduleItem,
  listItemsForCalendarWindow,
  listItemsByTask,
  listItemsByScheduledDate,
  removeItemByTaskScheduledDateAndOccurrenceDate,
  removeScheduleItem,
  removeItemsByTaskAndScheduledDate,
  updateItem as updateScheduleItemInStore
} from "./scheduleItemsStore.js";
import {
  hasExactScheduleOccurrenceDate,
  resolveScheduleOccurrenceDate
} from "./scheduleContract.js";
import {
  applyResolvedStatus,
  createTaskResolver,
  getLbsConfig,
  normalizeResponseTask,
  toUiStatus,
  type LbsTask
} from "./lbsTaskService.js";
import type { LbsScheduleDay } from "./lbsClient.js";
import { getLbsBackend } from "./lbs/backendFactory.js";
import type { LbsBackendContext, LbsDataPlane } from "./lbs/dataPlane.js";
import { listDateKeys, taskOccursOnDateKey } from "./taskRecurrenceUtils.js";
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

type TaskScheduleStoreDependencies = {
  listPinnedTaskIds: typeof listPinnedTaskIds;
  listItemsByScheduledDate: typeof listItemsByScheduledDate;
  listItemsForCalendarWindow: typeof listItemsForCalendarWindow;
  getLbsBackend: (context: LbsBackendContext) => LbsDataPlane;
};

const defaultDependencies: TaskScheduleStoreDependencies = {
  listPinnedTaskIds,
  listItemsByScheduledDate,
  listItemsForCalendarWindow,
  getLbsBackend
};

/**
 * List Today tasks for the given date.
 *
 * Today is explicit scheduled work: all schedule entries whose scheduledDate
 * matches the requested date.
 */
export async function listTaskToday(
  ownerUsername: string,
  date: string,
  backendContext: LbsBackendContext,
  dependencyOverrides: Partial<TaskScheduleStoreDependencies> = {}
): Promise<TodayTask[]> {
  console.log(`[tasks-service] listTaskToday owner=${ownerUsername} date=${date}`);

  const config = getLbsConfig();
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const client = dependencies.getLbsBackend(backendContext);
  const pinnedIds = new Set(await dependencies.listPinnedTaskIds(ownerUsername));

  const scheduleItems = await dependencies.listItemsByScheduledDate(ownerUsername, date);
  console.log(`[tasks-service] listTaskToday explicit schedule items=${scheduleItems.length} date=${date}`);

  if (scheduleItems.length === 0) return [];

  const occurrenceDates = scheduleItems.map((item) => item.occurrenceDate).sort();
  const minOccurrenceDate = occurrenceDates[0];
  const maxOccurrenceDate = occurrenceDates[occurrenceDates.length - 1];
  const [rawTasks, lbsSchedule] = await Promise.all([
    (client.listTasks(undefined, config.defaultActive) as unknown as Promise<LbsTask[]>).catch((error) => {
      console.warn(
        `[tasks-service] listTaskToday definition batch failed; using per-item fallback: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return [];
    }),
    client.getSchedule(minOccurrenceDate, maxOccurrenceDate).catch((error) => {
      console.warn(
        `[tasks-service] listTaskToday status batch failed; using per-item fallback: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return [];
    })
  ]);
  const resolveTask = createTaskResolver(client, rawTasks.map(normalizeResponseTask));
  const statusMap = buildScheduleStatusMap(lbsSchedule);

  const resolveEntry = async (
    taskId: string,
    occurrenceDate: string,
    scheduleItem?: ScheduleItemRow
  ): Promise<TodayTask | null> => {
    try {
      const normalized = await resolveTask(taskId);
      if (!normalized) return null;
      const mappedStatus = statusMap.get(`${taskId}::${occurrenceDate}`);
      const resolved = mappedStatus
        ? {
            ...normalized,
            status: mappedStatus.status,
            baseLoadScore: mappedStatus.load ?? normalized.baseLoadScore,
            isLocked: mappedStatus.isLocked ?? normalized.isLocked
          }
        : await applyResolvedStatus(normalized, client, config.timezone, occurrenceDate);
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
  const effectiveOccurrenceDate = resolveScheduleOccurrenceDate(
    scheduledDate,
    occurrenceDate
  );
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

export async function listTaskScheduleItems(
  ownerUsername: string,
  taskId: string
): Promise<ScheduleItemRow[]> {
  return listItemsByTask(ownerUsername, taskId);
}

export async function deleteTaskScheduleItem(
  ownerUsername: string,
  scheduleId: number
): Promise<boolean> {
  return removeScheduleItem(ownerUsername, scheduleId);
}

/**
 * Remove explicit schedule items from Today.
 */
export async function removeTaskFromToday(
  ownerUsername: string,
  taskId: string,
  scheduledDate: string,
  occurrenceDate?: string
): Promise<{ taskId: string; scheduledDate: string; occurrenceDate?: string; removed: number }> {
  const exactOccurrenceDate = hasExactScheduleOccurrenceDate(occurrenceDate)
    ? occurrenceDate.trim()
    : undefined;
  console.log(
    `[tasks-service] removeTaskFromToday owner=${ownerUsername} taskId=${taskId} scheduledDate=${scheduledDate} occurrenceDate=${exactOccurrenceDate ?? "compat-broad"}`
  );
  const removed = exactOccurrenceDate
    ? await removeItemByTaskScheduledDateAndOccurrenceDate(
        ownerUsername,
        taskId,
        scheduledDate,
        exactOccurrenceDate
      )
    : await removeItemsByTaskAndScheduledDate(
        ownerUsername,
        taskId,
        scheduledDate
      );
  console.log(`[tasks-service] removeTaskFromToday removed=${removed}`);
  return { taskId, scheduledDate, occurrenceDate: exactOccurrenceDate, removed };
}

/**
 * List scheduled calendar items in [startDate, endDate].
 */
export async function listTaskScheduleCalendar(
  ownerUsername: string,
  startDate: string,
  endDate: string,
  backendContext: LbsBackendContext,
  dependencyOverrides: Partial<TaskScheduleStoreDependencies> = {}
): Promise<ScheduleCalendarDay[]> {
  console.log(
    `[tasks-service] listTaskScheduleCalendar owner=${ownerUsername} ${startDate}->${endDate}`
  );

  const config = getLbsConfig();
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const client = dependencies.getLbsBackend(backendContext);
  const items = await dependencies.listItemsForCalendarWindow(ownerUsername, startDate, endDate);
  const explicitOccurrenceKeys = new Set(
    items.map((item) => `${item.taskId}::${item.occurrenceDate}`)
  );
  const explicitItemsInWindow = items.filter(
    (item) => item.scheduledDate >= startDate && item.scheduledDate <= endDate
  );

  const rawTasks = (await client.listTasks(undefined, config.defaultActive)) as unknown as LbsTask[];
  const tasks = rawTasks.map(normalizeResponseTask);
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const lbsSchedule = (await client.getSchedule(startDate, endDate)) as LbsScheduleDay[];
  const generatedStatusMap = buildScheduleStatusMap(lbsSchedule);
  const resolveTask = createTaskResolver(client, [...taskMap.values()]);

  const resolved = await Promise.all(
    explicitItemsInWindow.map(async (item): Promise<ScheduleCalendarItem | null> => {
      try {
        const normalized = await resolveTask(item.taskId);
        if (!normalized) return null;
        const mappedStatus = generatedStatusMap.get(`${item.taskId}::${item.occurrenceDate}`);
        const withStatus = mappedStatus
          ? { ...normalized, status: mappedStatus.status }
          : await applyResolvedStatus(normalized, client, config.timezone, item.occurrenceDate);
        return {
          scheduleId: item.id,
          taskId: item.taskId,
          title: withStatus.title,
          context: withStatus.context,
          status: withStatus.status,
          occurrenceDate: item.occurrenceDate,
          scheduledDate: item.scheduledDate,
          load: mappedStatus?.load ?? withStatus.baseLoadScore,
          startTime: item.startTime,
          endTime: item.endTime,
          timezone: item.timezone,
          isLocked: mappedStatus?.isLocked ?? withStatus.isLocked
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

  const generated = await Promise.all(
    tasks
      .filter((task) => task.recurrence !== "ONCE")
      .flatMap((task) =>
        listDateKeys(startDate, endDate)
          .filter((dateKey) => taskOccursOnDateKey(task, dateKey))
          .filter((dateKey) => !explicitOccurrenceKeys.has(`${task.id}::${dateKey}`))
          .map(async (dateKey): Promise<ScheduleCalendarItem> => {
            const lbsStatus = generatedStatusMap.get(`${task.id}::${dateKey}`);
            return {
              taskId: task.id,
              title: task.title,
              context: task.context,
              status: lbsStatus?.status ?? task.status,
              occurrenceDate: dateKey,
              scheduledDate: dateKey,
              load: lbsStatus?.load ?? task.baseLoadScore,
              startTime: task.startTime,
              endTime: task.endTime,
              timezone: task.timezone,
              isLocked: lbsStatus?.isLocked ?? task.isLocked
            };
          })
      )
  );

  const byDate = new Map<string, ScheduleCalendarItem[]>();
  for (const item of [...resolved, ...generated]) {
    if (!item) continue;
    const list = byDate.get(item.scheduledDate) ?? [];
    list.push(item);
    byDate.set(item.scheduledDate, list);
  }

  const days: ScheduleCalendarDay[] = [];
  for (const [date, dateItems] of [...byDate.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    dateItems.sort((a, b) => {
      const time = (a.startTime || "").localeCompare(b.startTime || "");
      if (time !== 0) return time;
      return a.title.localeCompare(b.title);
    });
    days.push({ date, items: dateItems });
  }
  console.log(`[tasks-service] listTaskScheduleCalendar returning days=${days.length}`);
  return days;
}

export type { ScheduleItemRow };

function buildScheduleStatusMap(lbsSchedule: LbsScheduleDay[]): Map<
  string,
  { status: ReturnType<typeof toUiStatus>; load?: number; isLocked?: boolean }
> {
  const statusMap = new Map<
    string,
    { status: ReturnType<typeof toUiStatus>; load?: number; isLocked?: boolean }
  >();
  for (const day of lbsSchedule) {
    for (const task of day.tasks || []) {
      statusMap.set(`${task.task_id}::${day.date}`, {
        status: toUiStatus(task.status),
        load: task.load,
        isLocked: task.is_locked === true
      });
    }
  }
  return statusMap;
}
