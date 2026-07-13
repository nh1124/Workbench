/**
 * useTaskDataLoader.ts
 * Owns the primary data-fetch lifecycle: tasks, projects, today-list,
 * calendar status map, inbox rows, and planned/overdue counters.
 *
 * Behavior is identical to the `load()` function that lived in TasksPage.tsx.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { projectsApi, tasksApi } from "../../lib/api";
import { buildInboxRows } from "../../lib/inboxBuilder";
import { pushErrorNotification } from "../../lib/notificationService";
import { addDays, startOfDay, toDateKey } from "../../lib/taskDateUtils";
import {
  filterProjectOptionsByAllowedIds,
  isAuthErrorMessage,
  mergeProjectOptions,
  type ProjectOption
} from "../../lib/taskDisplayUtils";
import type { ScheduleCalendarDay, Task, TaskScheduleDay, TaskStatus, TodayTask } from "../../types/models";
import {
  OCCURRENCE_PAGE_DAYS,
  type TaskOccurrenceRow,
  toTaskStatus
} from "../types";
import { buildTodayRows } from "../lib/taskTodayRows";
import { countDistinctOverdueTasks, countDistinctPlannedTasks } from "../lib/taskOccurrenceCounts";
import { taskOccurrenceRowKey } from "../lib/taskOccurrenceIdentity";

export interface TaskDataState {
  tasks: Task[];
  projectOptions: ProjectOption[];
  todayTaskIds: Set<string>;
  todayScheduleOccurrenceStatuses: Map<string, TaskStatus>;
  todayMembershipKeys: Set<string>;
  todayRows: TaskOccurrenceRow[];
  inboxUpcomingRows: TaskOccurrenceRow[];
  inboxDoneRows: TaskOccurrenceRow[];
  plannedCount: number;
  overdueCount: number;
  /** date-key ↁEtaskId ↁETaskStatus (for calendar per-date display) */
  calendarStatusMap: Map<string, Map<string, TaskStatus>>;
  isLoading: boolean;
  error: string | null;
}

export interface TaskDataLoaderActions {
  load: () => Promise<void>;
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  setProjectOptions: React.Dispatch<React.SetStateAction<ProjectOption[]>>;
  setTodayRows: React.Dispatch<React.SetStateAction<TaskOccurrenceRow[]>>;
  setTodayMembershipKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  setInboxUpcomingRows: React.Dispatch<React.SetStateAction<TaskOccurrenceRow[]>>;
  setInboxDoneRows: React.Dispatch<React.SetStateAction<TaskOccurrenceRow[]>>;
}

/**
 * @param contextFilter - currently active project/context filter (empty = all)
 * @param selectedTaskId - if set and the task disappears after reload, caller should clear it
 * @param onTaskGone - called when selectedTaskId is no longer in the refreshed task list
 */
export function useTaskDataLoader(
  contextFilter: string,
  selectedTaskId: string | null,
  onTaskGone: () => void
): TaskDataState & TaskDataLoaderActions {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projectOptions, setProjectOptions] = useState<ProjectOption[]>([]);
  const [todayTaskIds, setTodayTaskIds] = useState<Set<string>>(new Set());
  const [todayScheduleOccurrenceStatuses, setTodayScheduleOccurrenceStatuses] = useState<Map<string, TaskStatus>>(new Map());
  const [todayMembershipKeys, setTodayMembershipKeys] = useState<Set<string>>(new Set());
  const [todayRows, setTodayRows] = useState<TaskOccurrenceRow[]>([]);
  const [inboxUpcomingRows, setInboxUpcomingRows] = useState<TaskOccurrenceRow[]>([]);
  const [inboxDoneRows, setInboxDoneRows] = useState<TaskOccurrenceRow[]>([]);
  const [plannedCount, setPlannedCount] = useState(0);
  const [overdueCount, setOverdueCount] = useState(0);
  const [calendarStatusMap, setCalendarStatusMap] = useState<Map<string, Map<string, TaskStatus>>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const selectedTaskIdRef = useRef<string | null>(selectedTaskId);
  const onTaskGoneRef = useRef(onTaskGone);

  useEffect(() => {
    selectedTaskIdRef.current = selectedTaskId;
  }, [selectedTaskId]);

  useEffect(() => {
    onTaskGoneRef.current = onTaskGone;
  }, [onTaskGone]);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const todayDate = startOfDay(new Date());
      const todayKey = toDateKey(todayDate);
      const countFrom = toDateKey(addDays(todayDate, -(OCCURRENCE_PAGE_DAYS - 1)));
      const countTo = toDateKey(addDays(todayDate, OCCURRENCE_PAGE_DAYS - 1));

      const [
        taskList,
        taskProjects,
        projectsResult,
        todaySchedule,
        countSchedule,
        countScheduleCalendar,
        myDayTasks
      ] = await Promise.all([
        tasksApi.list(contextFilter || undefined),
        tasksApi.projects(),
        projectsApi.list(undefined, "active", 200)
          .then((result) => ({ ok: true as const, result }))
          .catch(() => ({ ok: false as const, result: { items: [] } })),
        tasksApi.schedule(todayKey, todayKey, contextFilter || undefined).catch(() => [] as TaskScheduleDay[]),
        tasksApi.schedule(countFrom, countTo, contextFilter || undefined).catch(() => [] as TaskScheduleDay[]),
        tasksApi.scheduleCalendar(countFrom, countTo).catch(() => [] as ScheduleCalendarDay[]),
        tasksApi.todayList(todayKey).catch(() => [] as TodayTask[])
      ]);

      // Build Today status map from LBS schedule (used to merge live status into task list)
      const todayIds = new Set<string>();
      const todayStatusMap = new Map<string, TaskStatus>();
      const todayOccurrenceStatuses = new Map<string, TaskStatus>();
      for (const day of todaySchedule) {
        for (const item of day.tasks) {
          const status = toTaskStatus(item.status);
          todayIds.add(item.taskId);
          todayStatusMap.set(item.taskId, status);
          todayOccurrenceStatuses.set(taskOccurrenceRowKey({
            taskId: item.taskId,
            occurrenceDate: day.date
          }), status);
        }
      }

      const {
        rows: builtTodayRows,
        membershipKeys: todayMemberships
      } = buildTodayRows(taskList, myDayTasks, todaySchedule, todayKey);
      setTodayRows(builtTodayRows);

      setPlannedCount(countDistinctPlannedTasks(countScheduleCalendar, todayKey, contextFilter));
      setOverdueCount(countDistinctOverdueTasks(countSchedule, todayKey, contextFilter));

      const { upcomingRows: builtInboxUpcoming, doneRows: builtInboxDone } =
        buildInboxRows(taskList, {
          countSchedule,
          scheduleCalendar: countScheduleCalendar,
          todayKey
        });
      setInboxUpcomingRows(builtInboxUpcoming);
      setInboxDoneRows(builtInboxDone);

      // Build per-date execution status map for calendar display
      const csMap = new Map<string, Map<string, TaskStatus>>();
      for (const day of countSchedule) {
        for (const item of day.tasks) {
          if (!csMap.has(day.date)) csMap.set(day.date, new Map());
          csMap.get(day.date)!.set(item.taskId, toTaskStatus(item.status));
        }
      }
      setCalendarStatusMap(csMap);

      // Merge live today-status into the task list
      const mergedTasks = taskList.map((task) => {
        const status = todayStatusMap.get(task.id);
        if (!status) return task;
        return { ...task, status };
      });

      const serviceProjects = projectsResult.result.items.map((project) => ({
        projectId: project.id,
        projectName: project.name
      }));
      const activeProjectIds = new Set(serviceProjects.map((project) => project.projectId));
      const taskProjectOptions = taskProjects.map((p) => ({
        projectId: p.projectId,
        projectName: p.projectName
      }));

      setTasks(mergedTasks);
      setTodayTaskIds(todayIds);
      setTodayScheduleOccurrenceStatuses(todayOccurrenceStatuses);
      setTodayMembershipKeys(todayMemberships);
      setProjectOptions(
        projectsResult.ok
          ? mergeProjectOptions(
              filterProjectOptionsByAllowedIds(taskProjectOptions, activeProjectIds),
              serviceProjects
            )
          : mergeProjectOptions(taskProjectOptions)
      );

      const currentSelectedTaskId = selectedTaskIdRef.current;
      if (currentSelectedTaskId && !mergedTasks.find((t) => t.id === currentSelectedTaskId)) {
        onTaskGoneRef.current();
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to load tasks.";
      setTodayTaskIds(new Set());
      setTodayScheduleOccurrenceStatuses(new Map());
      setTodayMembershipKeys(new Set());
      if (isAuthErrorMessage(message)) {
        setError(message);
      } else {
        pushErrorNotification(message, "Failed to load tasks");
      }
    } finally {
      setIsLoading(false);
    }
  }, [contextFilter]);

  return {
    tasks,
    projectOptions,
    todayTaskIds,
    todayScheduleOccurrenceStatuses,
    todayMembershipKeys,
    todayRows,
    inboxUpcomingRows,
    inboxDoneRows,
    plannedCount,
    overdueCount,
    calendarStatusMap,
    isLoading,
    error,
    load,
    setTasks,
    setProjectOptions,
    setTodayRows,
    setTodayMembershipKeys,
    setInboxUpcomingRows,
    setInboxDoneRows
  };
}

