import type { Task, TaskScheduleDay, TodayTask } from "../../types/models";
import type { TaskOccurrenceRow } from "../types";
import { toTaskStatus } from "../types";
import {
  occurrenceMembershipKey,
  taskOccurrenceRowKey
} from "./taskOccurrenceIdentity";

export interface TodayRowComposition {
  rows: TaskOccurrenceRow[];
  membershipKeys: Set<string>;
}

/**
 * Compose explicit Today memberships with today's generated LBS occurrences.
 *
 * When `contextFilter` is set, explicit Today entries from other projects are
 * dropped so the Today list (and its badge count) stays scoped to the active
 * project — the generated occurrences are already filtered upstream. Explicit
 * `skipped` entries are hidden like generated skipped ones, but still cover
 * their occurrence so the generated row does not resurrect them.
 */
export function buildTodayRows(
  taskList: Task[],
  explicitTodayTasks: TodayTask[],
  todaySchedule: TaskScheduleDay[],
  todayKey: string,
  contextFilter?: string
): TodayRowComposition {
  const taskById = new Map(taskList.map((task) => [task.id, task]));
  const membershipKeys = new Set<string>();
  const coveredOccurrences = new Set<string>();

  const rows: TaskOccurrenceRow[] = [];
  for (const task of explicitTodayTasks) {
    if (contextFilter && task.context !== contextFilter) continue;
    const occurrenceDate = task.occurrenceDate || task.scheduledDate || todayKey;
    const scheduledDate = task.scheduledDate || todayKey;
    if (toTaskStatus(task.status) === "skipped") {
      coveredOccurrences.add(taskOccurrenceRowKey({ taskId: task.id, occurrenceDate }));
      continue;
    }
    membershipKeys.add(occurrenceMembershipKey(task.id, occurrenceDate, scheduledDate));
    coveredOccurrences.add(taskOccurrenceRowKey({ taskId: task.id, occurrenceDate }));
    rows.push({
      key: taskOccurrenceRowKey({
        taskId: task.id,
        occurrenceDate,
        scheduledDate,
        scheduleId: task.scheduleId
      }),
      taskId: task.id,
      date: scheduledDate,
      occurrenceDate,
      scheduledDate,
      scheduleId: task.scheduleId,
      title: task.title,
      context: task.contextName ?? task.context,
      status: toTaskStatus(task.status),
      load: task.baseLoadScore,
      startTime: task.startTime ?? undefined,
      endTime: task.endTime ?? undefined,
      isLocked: task.isLocked
    });
  }

  for (const day of todaySchedule) {
    for (const item of day.tasks) {
      const occurrenceKey = taskOccurrenceRowKey({
        taskId: item.taskId,
        occurrenceDate: todayKey
      });
      if (coveredOccurrences.has(occurrenceKey)) continue;
      const status = toTaskStatus(item.status);
      if (status === "skipped") {
        coveredOccurrences.add(occurrenceKey);
        continue;
      }

      const fallback = taskById.get(item.taskId);
      rows.push({
        key: taskOccurrenceRowKey({
          taskId: item.taskId,
          occurrenceDate: todayKey,
          scheduledDate: todayKey
        }),
        taskId: item.taskId,
        date: todayKey,
        occurrenceDate: todayKey,
        scheduledDate: todayKey,
        scheduleId: undefined,
        title: item.title || fallback?.title || "",
        context: item.context || fallback?.contextName || fallback?.context || "",
        status,
        load: item.load ?? fallback?.baseLoadScore,
        startTime: item.startTime ?? fallback?.startTime ?? undefined,
        endTime: item.endTime ?? fallback?.endTime ?? undefined,
        isLocked: item.isLocked ?? fallback?.isLocked
      });
      coveredOccurrences.add(occurrenceKey);
    }
  }

  return { rows, membershipKeys };
}
