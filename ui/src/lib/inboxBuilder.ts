import type {
  ScheduleCalendarDay,
  ScheduleCalendarItem,
  Task,
  TaskScheduleDay,
  TaskStatus
} from "../types/models";
import { taskDefinitionRowKey, taskOccurrenceRowKey } from "../tasks/lib/taskOccurrenceIdentity";
import type { TaskOccurrenceRow } from "../tasks/types";

export interface InboxRows {
  upcomingRows: TaskOccurrenceRow[];
  doneRows: TaskOccurrenceRow[];
}

export interface InboxBuilderOptions {
  countSchedule?: TaskScheduleDay[];
  scheduleCalendar?: ScheduleCalendarDay[];
  todayKey: string;
}

type OccurrenceCandidate = {
  taskId: string;
  occurrenceDate: string;
  status: TaskStatus;
  calendarItem?: ScheduleCalendarItem;
};

function occurrenceKey(taskId: string, occurrenceDate: string): string {
  return taskOccurrenceRowKey({ taskId, occurrenceDate });
}

function taskRow(task: Task, status: TaskStatus = task.status): TaskOccurrenceRow {
  return {
    key: taskDefinitionRowKey(task.id),
    taskId: task.id,
    date: "",
    title: task.title,
    context: task.contextName ?? task.context,
    status,
    load: task.baseLoadScore,
    startTime: task.startTime ?? undefined,
    endTime: task.endTime ?? undefined,
    isLocked: task.isLocked
  };
}

function occurrenceRow(
  task: Task,
  occurrenceDate: string,
  status: TaskStatus,
  calendarItem?: ScheduleCalendarItem
): TaskOccurrenceRow {
  return {
    key: occurrenceKey(task.id, occurrenceDate),
    taskId: task.id,
    date: occurrenceDate,
    occurrenceDate,
    scheduledDate: calendarItem?.scheduledDate,
    scheduleId: calendarItem?.scheduleId,
    title: task.title,
    context: task.contextName ?? task.context,
    status,
    load: calendarItem?.load ?? task.baseLoadScore,
    startTime: calendarItem?.startTime ?? task.startTime ?? undefined,
    endTime: calendarItem?.endTime ?? task.endTime ?? undefined,
    isLocked: calendarItem?.isLocked ?? task.isLocked
  };
}

export function buildInboxRows(
  taskList: Task[],
  options: InboxBuilderOptions
): InboxRows {
  const countSchedule = options.countSchedule ?? [];
  const scheduleCalendar = options.scheduleCalendar ?? [];
  const taskById = new Map(taskList.map((task) => [task.id, task]));
  const occurrenceCandidates = new Map<string, OccurrenceCandidate>();
  const calendarItems = new Map<string, ScheduleCalendarItem>();
  const tasksWithScheduleEntries = new Set<string>();

  for (const day of scheduleCalendar) {
    for (const item of day.items) {
      const key = occurrenceKey(item.taskId, item.occurrenceDate);
      if (!calendarItems.has(key)) calendarItems.set(key, item);
      if (!occurrenceCandidates.has(key)) {
        occurrenceCandidates.set(key, {
          taskId: item.taskId,
          occurrenceDate: item.occurrenceDate,
          status: item.status,
          calendarItem: item
        });
      }
    }
  }

  const doneRowsByKey = new Map<string, TaskOccurrenceRow>();
  for (const day of countSchedule) {
    for (const item of day.tasks) {
      const key = occurrenceKey(item.taskId, day.date);
      tasksWithScheduleEntries.add(item.taskId);
      occurrenceCandidates.set(key, {
        taskId: item.taskId,
        occurrenceDate: day.date,
        status: item.status,
        calendarItem: calendarItems.get(key)
      });
      if (item.status === "done") {
        const task = taskById.get(item.taskId);
        if (task && !doneRowsByKey.has(key)) {
          doneRowsByKey.set(key, occurrenceRow(task, day.date, "done", calendarItems.get(key)));
        }
      }
    }
  }

  const upcomingRows: TaskOccurrenceRow[] = [];
  for (const task of taskList) {
    if (task.recurrence === "ONCE") {
      if (task.status === "done") {
        if (!tasksWithScheduleEntries.has(task.id)) {
          const legacyRow = task.dueDate
            ? occurrenceRow(task, task.dueDate, "done", calendarItems.get(occurrenceKey(task.id, task.dueDate)))
            : taskRow(task, "done");
          doneRowsByKey.set(legacyRow.key, legacyRow);
        }
        continue;
      }
      if (!task.dueDate) {
        if (task.status !== "skipped") upcomingRows.push(taskRow(task));
        continue;
      }
      const key = occurrenceKey(task.id, task.dueDate);
      const candidate = occurrenceCandidates.get(key);
      const status = candidate?.status ?? task.status;
      if (status !== "done" && status !== "skipped") {
        upcomingRows.push(occurrenceRow(task, task.dueDate, status, calendarItems.get(key)));
      }
      continue;
    }

    const nextOccurrence = [...occurrenceCandidates.values()]
      .filter((candidate) => (
        candidate.taskId === task.id
        && candidate.occurrenceDate >= options.todayKey
        && candidate.status !== "done"
        && candidate.status !== "skipped"
      ))
      .sort((left, right) => left.occurrenceDate.localeCompare(right.occurrenceDate))[0];

    if (nextOccurrence) {
      upcomingRows.push(occurrenceRow(
        task,
        nextOccurrence.occurrenceDate,
        nextOccurrence.status,
        nextOccurrence.calendarItem
      ));
    } else {
      upcomingRows.push(taskRow(task, task.status === "done" ? "todo" : task.status));
    }
  }

  upcomingRows.sort((left, right) => {
    const leftDate = left.occurrenceDate || left.date || "9999-12-31";
    const rightDate = right.occurrenceDate || right.date || "9999-12-31";
    return leftDate.localeCompare(rightDate) || left.taskId.localeCompare(right.taskId);
  });
  const doneRows = [...doneRowsByKey.values()].sort((left, right) => {
    const leftDate = left.occurrenceDate || left.date || "";
    const rightDate = right.occurrenceDate || right.date || "";
    return rightDate.localeCompare(leftDate) || left.taskId.localeCompare(right.taskId);
  });

  return { upcomingRows, doneRows };
}
