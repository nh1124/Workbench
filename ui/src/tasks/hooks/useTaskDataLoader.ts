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
import type { Task, TaskScheduleDay, TaskStatus, TodayTask } from "../../types/models";
import {
  OCCURRENCE_PAGE_DAYS,
  type TaskOccurrenceRow,
  toTaskStatus
} from "../types";

export interface TaskDataState {
  tasks: Task[];
  projectOptions: ProjectOption[];
  todayTaskIds: Set<string>;
  myDayFlaggedIds: Set<string>;
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
  setMyDayFlaggedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
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
  const [myDayFlaggedIds, setMyDayFlaggedIds] = useState<Set<string>>(new Set());
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
        myDayTasks
      ] = await Promise.all([
        tasksApi.list(contextFilter || undefined),
        tasksApi.projects(),
        projectsApi.list(undefined, "active", 200)
          .then((result) => ({ ok: true as const, result }))
          .catch(() => ({ ok: false as const, result: { items: [] } })),
        tasksApi.schedule(todayKey, todayKey, contextFilter || undefined).catch(() => [] as TaskScheduleDay[]),
        tasksApi.schedule(countFrom, countTo, contextFilter || undefined).catch(() => [] as TaskScheduleDay[]),
        tasksApi.todayList(todayKey).catch(() => [] as TodayTask[])
      ]);

      // Build Today status map from LBS schedule (used to merge live status into task list)
      const todayIds = new Set<string>();
      const todayStatusMap = new Map<string, TaskStatus>();
      for (const day of todaySchedule) {
        for (const item of day.tasks) {
          todayIds.add(item.taskId);
          todayStatusMap.set(item.taskId, toTaskStatus(item.status));
        }
      }

      // Today rows: built ENTIRELY from the task_today DB table (myDayTasks).
      // Each TodayTask has occurrenceDate = the LBS execution date for that task.
      // This is the single source of truth for the Today view display.
      const builtTodayRows: TaskOccurrenceRow[] = myDayTasks.map((t) => ({
        key: `${t.occurrenceDate}::${t.id}`,
        taskId: t.id,
        date: t.occurrenceDate,
        title: t.title,
        context: t.contextName ?? t.context,
        status: todayStatusMap.get(t.id) ?? t.status, // prefer live LBS status
        load: t.baseLoadScore,
        startTime: t.startTime ?? undefined,
        endTime: t.endTime ?? undefined,
        isLocked: t.isLocked
      }));
      setTodayRows(builtTodayRows);

      // Planned/overdue counts
      let pCnt = 0;
      let oCnt = 0;
      for (const day of countSchedule) {
        if (day.date > todayKey) {
          pCnt += day.tasks.length;
        } else if (day.date < todayKey) {
          oCnt += day.tasks.filter((t) => toTaskStatus(t.status) !== "done").length;
        }
      }
      setPlannedCount(pCnt);
      setOverdueCount(oCnt);

      // Inbox: DueDate-based, one row per task. See src/lib/inboxBuilder.ts for spec.
      const { upcomingRows: builtInboxUpcoming, doneRows: builtInboxDone } =
        buildInboxRows(taskList);
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
      // myDayFlaggedIds: task IDs in Today DB (the authoritative source for Today filter)
      setMyDayFlaggedIds(new Set(myDayTasks.map((t: TodayTask) => t.id)));
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
    myDayFlaggedIds,
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
    setMyDayFlaggedIds,
    setInboxUpcomingRows,
    setInboxDoneRows
  };
}

