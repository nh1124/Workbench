import type { ScheduleCalendarDay, TaskScheduleDay } from "../../types/models";

export function countDistinctPlannedTasks(
  scheduleCalendar: ScheduleCalendarDay[],
  todayKey: string,
  contextFilter = ""
): number {
  const taskIds = new Set<string>();
  for (const day of scheduleCalendar) {
    if (day.date <= todayKey) continue;
    for (const item of day.items) {
      if (!contextFilter || item.context === contextFilter) {
        taskIds.add(item.taskId);
      }
    }
  }
  return taskIds.size;
}

export function countDistinctOverdueTasks(
  schedule: TaskScheduleDay[],
  todayKey: string,
  contextFilter = ""
): number {
  const taskIds = new Set<string>();
  for (const day of schedule) {
    if (day.date >= todayKey) continue;
    for (const task of day.tasks) {
      if (task.status !== "done" && (!contextFilter || task.context === contextFilter)) {
        taskIds.add(task.taskId);
      }
    }
  }
  return taskIds.size;
}
