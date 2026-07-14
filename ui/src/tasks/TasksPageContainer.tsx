/**
 * TasksPageContainer.tsx
 * Assembly point: wires useTaskDataLoader, useOccurrencePaging,
 * useTaskSelection, and useTaskMutations together; manages UI-only
 * local state; and renders the full Tasks page JSX.
 *
 * This is a refactored replacement for TasksPage.tsx that uses the
 * extracted hooks instead of inlining all logic in one 3000-line file.
 * Behaviour, API contracts, and CSS class names are preserved exactly.
 */

import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type DragEvent, type MouseEvent as ReactMouseEvent, type UIEvent
} from "react";
import { useLocation } from "react-router-dom";
import { openCalendarWindow, readWorkbenchSession, tasksApi } from "../lib/api";
import { pushErrorNotification } from "../lib/notificationService";
import { subscribeSyncEvents } from "../lib/syncEvents";
import {
  buildMonthCells,
  contextColor,
  hourLabel,
  isAuthErrorMessage,
  normalizeText,
} from "../lib/taskDisplayUtils";
import {
  addDays, addMonths, formatDateHeading, isSameDay, startOfDay, startOfMonth,
  startOfWeek, toDateKey
} from "../lib/taskDateUtils";
import { taskOccursOnDate } from "../lib/taskRecurrenceUtils";
import type {
  ScheduleCalendarDay, ScheduleCalendarItem,
  Task, TaskScheduleDay, TaskStatus
} from "../types/models";

// ── New architecture imports ────────────────────────────────────────────────
import { useOccurrencePaging } from "./hooks/useOccurrencePaging";
import { useTaskDataLoader } from "./hooks/useTaskDataLoader";
import { useTaskMutations } from "./hooks/useTaskMutations";
import { useTaskSelection } from "./hooks/useTaskSelection";
import { filterAndSortTasks, computeTaskCounters } from "./lib/taskFilterUtils";
import {
  filterOccurrenceRowsForQuickFilter,
  sortOccurrenceRows,
  groupOccurrencesByProject
} from "./lib/taskOccurrenceDisplayUtils";
import { normalizeDateKey, rowOccurrenceDate, rowScheduledDate } from "./lib/taskOccurrenceIdentity";
import {
  buildMonthCellContextPayload,
  buildStandaloneCalendarUrl,
  timelineDragToSnappedRange,
  type MonthCellContextPayload,
  type TimelineDragRange,
} from "./lib/calendarInteractionUtils";
import {
  buildMonthWindow, buildTasksByDate, calendarMonthKey, extendMonthWindow, filterScheduleItems,
  monthWindowDirectionForScroll,
} from "./lib/taskCalendarUtils";
import { computeTimelineHourHeight, layoutTimedItems } from "./lib/timelineLayoutUtils";
import {
  emptyDraft,
  TIMELINE_END_HOUR, TIMELINE_START_HOUR,
  toTaskStatus,
  weekdays,
  type CalendarMode, type QuickFilter, type SidebarMode, type SortMode,
  type TaskOccurrenceRow,
} from "./types";
import { OccurrenceContextMenu } from "./components/OccurrenceContextMenu";
import { FileViewerModal } from "./components/FileViewerModal";
import { CalendarDayDetailPanel } from "./components/CalendarDayDetailPanel";
import { CalendarMonthGrid } from "./components/CalendarMonthGrid";
import { TaskDetailPanel } from "./components/TaskDetailPanel";
import { TaskListContent } from "./components/TaskListContent";
import { TaskOccurrenceRowItem } from "./components/TaskOccurrenceRowItem";
import { TaskQuickAddPanel } from "./components/TaskQuickAddPanel";
import { TodaySuggestionCard } from "./components/TodaySuggestionCard";
import { TasksCenterHeader } from "./components/TasksCenterHeader";
import { TasksSecondarySidebar } from "./components/TasksSecondarySidebar";
import { IcoClock } from "./components/icons";

// ── CSS ─────────────────────────────────────────────────────────────────────
import "./css/tasks-layout.css";
import "./css/tasks-list.css";
import "./css/tasks-calendar.css";
import "./css/tasks-detail.css";

// ── Exported component ───────────────────────────────────────────────────────

interface TasksPageContainerProps {
  standalone?: boolean;
  initialSidebarMode?: SidebarMode;
  initialCalendarMode?: CalendarMode;
}

type TimelineSelection = TimelineDragRange & {
  date: string;
  columnKey: string;
  dragging: boolean;
  popoverX: number;
  popoverY: number;
};

export function TasksPageContainer({
  standalone = false,
  initialSidebarMode = "list",
  initialCalendarMode = "month",
}: TasksPageContainerProps = {}) {
  const location = useLocation();

  // ── UI-only local state ──────────────────────────────────────────────────
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(initialSidebarMode);
  const [calendarMode, setCalendarMode] = useState<CalendarMode>(initialCalendarMode);
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("today");
  const [calendarStatusFilter, setCalendarStatusFilter] = useState<"all" | "open" | "done">("all");
  const [contextFilter, setContextFilter] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedOccurrenceDate, setSelectedOccurrenceDate] = useState<string | null>(null);
  const [monthCursor, setMonthCursor] = useState(() => startOfMonth(new Date()));
  const [monthWindow, setMonthWindow] = useState(() => buildMonthWindow(new Date()));
  const [weekCursor, setWeekCursor] = useState(() => startOfWeek(new Date()));
  const [nowMarker, setNowMarker] = useState(() => new Date());
  const [sortMode, setSortMode] = useState<SortMode>("load");
  const [todayCompletedOpen, setTodayCompletedOpen] = useState(false);
  const [inboxCompletedOpen, setInboxCompletedOpen] = useState(false);
  const [dayDetailDate, setDayDetailDate] = useState<Date | null>(null);
  const [scheduleDays, setScheduleDays] = useState<ScheduleCalendarDay[]>([]);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [calendarRangeStatusMap, setCalendarRangeStatusMap] = useState<Map<string, Map<string, TaskStatus>>>(new Map());
  const [timelineAvailableHeight, setTimelineAvailableHeight] = useState(0);
  const [scheduleRefreshTick, setScheduleRefreshTick] = useState(0);
  const [todaySuggestionHandled, setTodaySuggestionHandled] = useState(false);
  const [todaySuggestionApplying, setTodaySuggestionApplying] = useState(false);
  const [calendarCreateMenu, setCalendarCreateMenu] = useState<MonthCellContextPayload | null>(null);
  const [timelineSelection, setTimelineSelection] = useState<TimelineSelection | null>(null);
  const [taskPickerOpen, setTaskPickerOpen] = useState(false);
  const [taskPickerQuery, setTaskPickerQuery] = useState("");
  const [scheduleCreating, setScheduleCreating] = useState(false);

  const importRef = useRef<HTMLInputElement>(null);
  const weekTimelineScrollRef = useRef<HTMLDivElement | null>(null);
  const autoScrolledWeekKeyRef = useRef<string>("");
  const monthScrollRef = useRef<HTMLDivElement | null>(null);
  const monthElementRefs = useRef(new Map<string, HTMLElement>());
  const monthScrollAnchorRef = useRef<{ monthKey: string; top: number } | null>(null);
  const monthScrollTargetRef = useRef<{ monthKey: string; behavior: ScrollBehavior } | null>(null);
  const monthViewActivationRef = useRef("");
  const monthWindowExtendingRef = useRef(false);
  const monthScrollFrameRef = useRef<number | null>(null);
  const calendarStatusMonthCacheRef = useRef(new Set<string>());
  const scheduleMonthCacheRef = useRef(new Set<string>());
  const calendarStatusGenerationRef = useRef(0);
  const scheduleGenerationRef = useRef(0);
  const scheduleRequestCountRef = useRef(0);
  const timelineDragRef = useRef<{
    date: string;
    columnKey: string;
    anchorClientY: number;
    rect: DOMRect;
    hourHeight: number;
  } | null>(null);

  const todayKey = useMemo(() => toDateKey(startOfDay(nowMarker)), [nowMarker]);
  const today = useMemo(() => {
    const [year = 1970, month = 1, day = 1] = todayKey.split("-").map(Number);
    return new Date(year, month - 1, day);
  }, [todayKey]);
  const dayBoundaryKeyRef = useRef(todayKey);

  // ── Clock tick (every 30s for now-marker) ──────────────────────────────
  useEffect(() => {
    const timer = window.setInterval(() => setNowMarker(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // ── Data loader hook ──────────────────────────────────────────────────────
  const {
    tasks, projectOptions,
    todayTaskIds, todayScheduleOccurrenceStatuses, todayMembershipKeys, todayRows,
    inboxUpcomingRows, inboxDoneRows,
    plannedCount, overdueCount,
    calendarStatusMap,
    isLoading, error,
    load, isLoadInFlight,
    setTasks, setProjectOptions,
    setTodayRows, setTodayMembershipKeys,
    setInboxUpcomingRows, setInboxDoneRows,
  } = useTaskDataLoader(contextFilter, selectedTaskId, () => {
    setSelectedTaskId(null);
    setSelectedOccurrenceDate(null);
  });

  // ── Occurrence paging hook ────────────────────────────────────────────────
  const {
    occurrenceRows,
    occurrenceLoading,
    occurrenceHasMore,
    occurrenceRowsOrdered,
    loadOccurrencePage, isOccurrenceLoadInFlight,
    resetOccurrences,
    setOccurrenceRows,
  } = useOccurrencePaging(contextFilter);
  const backgroundRefreshActionRef = useRef<() => Promise<void>>(async () => {});

  // Reload occurrence page when quick filter switches to planned/overdue
  useEffect(() => {
    if (quickFilter === "planned" || quickFilter === "overdue") {
      resetOccurrences();
      void loadOccurrencePage(quickFilter, true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickFilter, contextFilter]);

  // ── Selection + context menu hook ─────────────────────────────────────────
  const {
    selectedOccurrenceKeys,
    occurrenceMenu,
    showMoveDateInput,
    moveDateInput,
    showMoveProjectInput,
    moveProjectInput,
    handleOccurrenceClick: _handleOccClick,
    ensureContextSelection,
    getSelectedOccurrenceRows,
    setOccurrenceMenu,
    setShowMoveDateInput,
    setMoveDateInput,
    setShowMoveProjectInput,
    setMoveProjectInput,
    clearSelection,
  } = useTaskSelection();

  // ── Mutations hook ────────────────────────────────────────────────────────
  const mutations = useTaskMutations(
    {
      selectedTaskId,
      selectedOccurrenceDate,
      onSelectTask: (task, occurrenceStatus, occurrenceDate) => {
        selectTask(task, occurrenceStatus, occurrenceDate);
      },
      onReload: async () => { await load({ silent: true }); },
      onBackgroundRefresh: () => backgroundRefreshActionRef.current(),
      isBackgroundRefreshBlocked: () => isLoadInFlight() || isOccurrenceLoadInFlight(),
      quickFilter,
      projectOptions,
      contextFilter,
      today,
      todayScheduleOccurrenceStatuses,
    },
    tasks,
    setTasks,
    setProjectOptions
  );

  const {
    draft, setDraft,
    isSaving,
    selectedTask,
    attachments,
    attachmentsLoading,
    isDraggingOver, setIsDraggingOver,
    subtasks,
    subtasksLoading,
    newSubtaskTitle, setNewSubtaskTitle,
    fileViewer,
    showAddPanel, setShowAddPanel,
    addAdvancedOpen, setAddAdvancedOpen,
    addDraft, setAddDraft,
    addContextInput, setAddContextInput,
    scheduleDraft, setScheduleDraft,
    scheduleItemId,
    scheduleItemLoading,
    history,
    historyOpen,
    historyLoading,
    advancedOpen, setAdvancedOpen,
    draftRef,
    attachmentInputRef,
    loadTaskDetail,
    applyAndSave,
    saveDetail,
    clearDetail: _clearDetail,
    openAddPanel: _openAddPanel,
    handleAddTask,
    handleDeleteDetail,
    handleToggleDone,
    handleTogglePin,
    handleToggleOccurrenceDone: _handleToggleOccDone,
    handleMarkSelectedOccurrences: _handleMarkSelected,
    handleSkipSelectedTasks: _handleSkipSelected,
    handleConfirmMoveDate: _handleConfirmMove,
    handleMoveSelectedToProject: _handleMoveToProject,
    handleDeleteSelectedFromMenu: _handleDeleteSelected,
    handleToggleTodayForSelected: _handleToggleToday,
    handleAttachmentDrop,
    handleDeleteAttachment,
    handleOpenFileViewer,
    closeFileViewer,
    handleAddSubtask,
    handleToggleSubtask,
    handleDeleteSubtask,
    handleSaveScheduleItem,
    handleRemoveScheduleItem,
    handleHistoryToggle,
    handleExport,
    handleImport,
    loadAttachments,
    loadSubtasks,
    loadScheduleItem,
    scheduleBackgroundRefresh,
    hasOccurrenceMutationsInFlight,
  } = mutations;

  backgroundRefreshActionRef.current = async () => {
    const shouldApply = () => !hasOccurrenceMutationsInFlight();
    const primaryApplied = await load({ silent: true, shouldApply });
    if (!primaryApplied) {
      if (hasOccurrenceMutationsInFlight() || isLoadInFlight()) scheduleBackgroundRefresh();
      return;
    }
    if (quickFilter !== "planned" && quickFilter !== "overdue") return;
    const occurrencesApplied = await loadOccurrencePage(quickFilter, true, {
      silent: true,
      shouldApply,
    });
    if (!occurrencesApplied && (hasOccurrenceMutationsInFlight() || isOccurrenceLoadInFlight())) {
      scheduleBackgroundRefresh();
    }
  };

  // Keep draftRef current every render (avoids stale closures in applyAndSave)
  draftRef.current = draft;

  const todaySuggestionDecisionKey = useMemo(() => {
    const username = readWorkbenchSession()?.username ?? "guest";
    return `tasks.today.suggestion.${username}.${todayKey}`;
  }, [todayKey]);
  const scheduledTodayTaskIds = useMemo(
    () => new Set(todayRows.map((row) => row.taskId)),
    [todayRows]
  );
  const dueTodayOutsideTodayTasks = useMemo(() => {
    return tasks.filter((task) => (
      task.status === "todo" &&
      task.dueDate === todayKey &&
      !scheduledTodayTaskIds.has(task.id)
    ));
  }, [tasks, todayKey, scheduledTodayTaskIds]);
  const showTodaySuggestion = sidebarMode === "list" &&
    !todaySuggestionHandled &&
    dueTodayOutsideTodayTasks.length > 0;

  // ── selectTask / clearDetail helpers (need local state setters) ──────────

  const selectTask = useCallback((
    task: Task,
    _occurrenceStatus?: TaskStatus,
    occurrenceDate?: string,
    scheduleId?: number,
    scheduledDate?: string
  ) => {
    setSelectedTaskId(task.id);
    loadTaskDetail(task);
    setShowAddPanel(false);
    const date = normalizeDateKey(occurrenceDate) ?? normalizeDateKey(task.dueDate);
    setSelectedOccurrenceDate(date ?? null);
    void loadAttachments(task.id);
    void loadSubtasks(task.id, date);
    void loadScheduleItem(task.id, date, {
      scheduleId,
      scheduledDate: normalizeDateKey(scheduledDate)
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadAttachments, loadSubtasks, loadScheduleItem, loadTaskDetail, setShowAddPanel]);

  const clearDetail = useCallback(() => {
    setSelectedTaskId(null);
    setSelectedOccurrenceDate(null);
    _clearDetail();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [_clearDetail]);

  const openAddPanel = useCallback(() => {
    setSelectedTaskId(null);
    setSelectedOccurrenceDate(null);
    _openAddPanel();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [_openAddPanel]);

  // ── Wrapper closures for multi-arg hook functions ─────────────────────────

  const handleOccurrenceClick = (event: ReactMouseEvent<HTMLButtonElement>, row: TaskOccurrenceRow) => {
    _handleOccClick(event, row, activeOccurrenceRows.map((item) => item.key), (r) => {
      const task = tasks.find((t) => t.id === r.taskId);
      if (task) selectTask(task, r.status, rowOccurrenceDate(r), r.scheduleId, rowScheduledDate(r));
    });
  };

  const occurrenceCollections = {
    todayRows,
    occurrenceRows,
    inboxUpcomingRows,
    inboxDoneRows
  };
  const occurrenceCollectionSetters = {
    setTodayRows,
    setOccurrenceRows,
    setInboxUpcomingRows,
    setInboxDoneRows
  };

  const handleToggleOccurrenceDone = async (row: TaskOccurrenceRow) => {
    await _handleToggleOccDone(row, occurrenceCollections, occurrenceCollectionSetters);
  };

  const closeMenu = () => setOccurrenceMenu((prev) => ({ ...prev, visible: false }));

  const handleMarkSelectedOccurrences = async (status: TaskStatus) => {
    const rows = getSelectedOccurrenceRows(activeOccurrenceRows);
    await _handleMarkSelected(
      status,
      rows,
      occurrenceCollections,
      occurrenceCollectionSetters,
      closeMenu
    );
  };

  const handleSkipSelectedTasks = async () => {
    const rows = getSelectedOccurrenceRows(activeOccurrenceRows);
    await _handleSkipSelected(rows, occurrenceCollections, occurrenceCollectionSetters, closeMenu);
  };

  const handleConfirmMoveDate = async () => {
    const rows = getSelectedOccurrenceRows(activeOccurrenceRows);
    await _handleConfirmMove(rows, moveDateInput, setOccurrenceRows, setTodayRows, setInboxUpcomingRows, setInboxDoneRows, clearSelection, closeMenu, setShowMoveDateInput, setMoveDateInput);
  };

  const handleMoveToProjectForSelected = async () => {
    const rows = getSelectedOccurrenceRows(activeOccurrenceRows);
    await _handleMoveToProject(
      rows,
      moveProjectInput,
      closeMenu,
      () => {
        setShowMoveProjectInput(false);
        setMoveProjectInput("");
      }
    );
  };

  const handleDeleteSelectedFromMenu = async () => {
    const rows = getSelectedOccurrenceRows(activeOccurrenceRows);
    await _handleDeleteSelected(rows, setOccurrenceRows, setTodayRows, setInboxUpcomingRows, setInboxDoneRows, clearSelection, closeMenu);
  };

  const handleToggleTodayForSelected = async (isToday: boolean) => {
    const rows = getSelectedOccurrenceRows(activeOccurrenceRows);
    await _handleToggleToday(isToday, rows, setTodayRows, setTodayMembershipKeys, closeMenu);
  };

  const markTodaySuggestionHandled = useCallback((action: "add" | "cancel") => {
    try {
      localStorage.setItem(todaySuggestionDecisionKey, action);
    } catch {
      // Ignore storage failures; keep in-memory behavior.
    }
    setTodaySuggestionHandled(true);
  }, [todaySuggestionDecisionKey]);

  const handleAddDueTodaySuggestion = useCallback(async () => {
    if (dueTodayOutsideTodayTasks.length === 0 || todaySuggestionApplying) return;
    markTodaySuggestionHandled("add");
    setTodaySuggestionApplying(true);
    try {
      const uniqueTaskIds = Array.from(new Set(dueTodayOutsideTodayTasks.map((task) => task.id)));
      await Promise.all(uniqueTaskIds.map((taskId) => tasksApi.addToToday(taskId, todayKey, todayKey)));
      await load({ silent: true });
    } catch {
      pushErrorNotification("Failed to add due-today tasks to Today.");
    } finally {
      setTodaySuggestionApplying(false);
    }
  }, [dueTodayOutsideTodayTasks, load, markTodaySuggestionHandled, todayKey, todaySuggestionApplying]);

  const handleDismissDueTodaySuggestion = useCallback(() => {
    markTodaySuggestionHandled("cancel");
  }, [markTodaySuggestionHandled]);

  // ── Resolve context display name ──────────────────────────────────────────

  const projectNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const option of projectOptions) {
      map.set(option.projectId, option.projectName?.trim() || option.projectId);
    }
    return map;
  }, [projectOptions]);

  const resolveContextDisplayName = (context: string, contextName?: string): string =>
    projectNameMap.get(context) || contextName || context;

  const resolveExistingContextOption = (rawValue: string) => {
    const value = rawValue.trim();
    if (!value) return undefined;
    const lower = normalizeText(value);
    return projectOptions.find((option) =>
      option.projectId === value ||
      normalizeText(option.projectId) === lower ||
      (option.projectName && normalizeText(option.projectName) === lower)
    );
  };

  // ── Derived state ─────────────────────────────────────────────────────────

  const filteredTasks = useMemo(
    () => filterAndSortTasks(tasks, {
      sidebarMode, calendarStatusFilter, quickFilter,
      todayMembershipKeys, todayTaskIds, today, sortMode,
    }),
    [quickFilter, calendarStatusFilter, sidebarMode, tasks, today, todayTaskIds, todayMembershipKeys, sortMode]
  );

  const counters = useMemo(
    () => computeTaskCounters(tasks, {
      todayMembershipKeys, todayTaskIds, today,
      plannedCount, overdueCount, inboxUpcomingCount: inboxUpcomingRows.length,
    }),
    [tasks, today, todayTaskIds, todayMembershipKeys, plannedCount, overdueCount, inboxUpcomingRows]
  );

  const pinnedTaskIds = useMemo(
    () => new Set(tasks.filter((t) => t.isPinned === true).map((t) => t.id)),
    [tasks]
  );

  const todayOccurrenceRowsOrdered = useMemo(
    () => sortOccurrenceRows(todayRows),
    [todayRows]
  );

  const mydayOccurrenceRowsOrdered = useMemo(
    () => todayOccurrenceRowsOrdered.filter((r) => pinnedTaskIds.has(r.taskId)),
    [todayOccurrenceRowsOrdered, pinnedTaskIds]
  );

  const activeOccurrenceRows = useMemo(() => {
    if (quickFilter === "today") return todayOccurrenceRowsOrdered;
    if (quickFilter === "myday") return mydayOccurrenceRowsOrdered;
    if (quickFilter === "inbox") return [...inboxUpcomingRows, ...inboxDoneRows];
    return filterOccurrenceRowsForQuickFilter(occurrenceRowsOrdered, quickFilter);
  }, [quickFilter, todayOccurrenceRowsOrdered, mydayOccurrenceRowsOrdered, occurrenceRowsOrdered, inboxUpcomingRows, inboxDoneRows]);

  const occurrenceProjectGroups = useMemo(
    () => groupOccurrencesByProject(activeOccurrenceRows, tasks, projectNameMap),
    [activeOccurrenceRows, tasks, projectNameMap]
  );

  const activeOccurrenceDateGroups = useMemo(() => {
    const groups = new Map<string, TaskOccurrenceRow[]>();
    for (const row of activeOccurrenceRows) {
      groups.set(row.date, [...(groups.get(row.date) ?? []), row]);
    }
    return Array.from(groups.entries()).map(([date, rows]) => ({ date, rows }));
  }, [activeOccurrenceRows]);

  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekCursor, i)), [weekCursor]);

  const effectiveCalendarStatusMap = useMemo(() => {
    const merged = new Map(calendarStatusMap);
    for (const [dateKey, statuses] of calendarRangeStatusMap) merged.set(dateKey, statuses);
    return merged;
  }, [calendarRangeStatusMap, calendarStatusMap]);

  const tasksByDate = useMemo(() => {
    return buildTasksByDate(filteredTasks, weekDays.map((day) => startOfDay(day)), effectiveCalendarStatusMap);
  }, [effectiveCalendarStatusMap, filteredTasks, weekDays]);

  const hasTasksInVisiblePeriod = useMemo(
    () => calendarMode === "month"
      ? filteredTasks.length > 0
      : Array.from(tasksByDate.values()).some((items) => items.length > 0),
    [calendarMode, filteredTasks.length, tasksByDate]
  );

  const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);

  const taskPickerTasks = useMemo(() => {
    const query = normalizeText(taskPickerQuery.trim());
    return tasks
      .filter((task) => !query || normalizeText(`${task.title} ${task.contextName ?? ""} ${task.context}`).includes(query))
      .slice(0, 30);
  }, [taskPickerQuery, tasks]);

  const scheduleItemsByDate = useMemo(() => {
    const map = new Map<string, ScheduleCalendarItem[]>();
    for (const day of scheduleDays) map.set(day.date, day.items);
    return map;
  }, [scheduleDays]);

  const filteredScheduleItemsByDate = useMemo(
    () => filterScheduleItems(scheduleItemsByDate, { calendarStatusFilter, contextFilter }),
    [scheduleItemsByDate, calendarStatusFilter, contextFilter]
  );

  const periodLabel = useMemo(() => (
    calendarMode === "month"
      ? monthCursor.toLocaleDateString("en-US", { year: "numeric", month: "long" })
      : `${weekDays[0].toLocaleDateString("en-US", { month: "short", day: "numeric" })} - ${weekDays[6].toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
  ), [calendarMode, monthCursor, weekDays]);

  const timelineHours = useMemo(
    () => Array.from({ length: (TIMELINE_END_HOUR - TIMELINE_START_HOUR) + 1 }, (_, i) => TIMELINE_START_HOUR + i),
    []
  );
  const visibleHourCount = TIMELINE_END_HOUR - TIMELINE_START_HOUR;
  const timelineHourHeight = useMemo(
    () => computeTimelineHourHeight(timelineAvailableHeight, visibleHourCount),
    [timelineAvailableHeight, visibleHourCount]
  );
  const timelineBodyHeight = visibleHourCount * timelineHourHeight;
  const nowDay = useMemo(() => startOfDay(nowMarker), [nowMarker]);
  const nowMinuteOfDay = useMemo(() => (nowMarker.getHours() * 60) + nowMarker.getMinutes(), [nowMarker]);

  const visibleWeekKey = useMemo(
    () => `${weekDays[0].getFullYear()}-${weekDays[0].getMonth()}-${weekDays[0].getDate()}_${weekDays[6].getFullYear()}-${weekDays[6].getMonth()}-${weekDays[6].getDate()}`,
    [weekDays]
  );

  const dayDetailTasks = useMemo(() => {
    if (!dayDetailDate) return [];
    return filteredTasks.filter((task) => taskOccursOnDate(task, dayDetailDate));
  }, [dayDetailDate, filteredTasks]);

  const isAuthError = useMemo(() => Boolean(error && isAuthErrorMessage(error)), [error]);
  const displayError = useMemo(() => (error && !isAuthError ? error : null), [error, isAuthError]);

  // ── Effects ───────────────────────────────────────────────────────────────

  useEffect(() => {
    return subscribeSyncEvents(["tasks"], scheduleBackgroundRefresh);
  }, [scheduleBackgroundRefresh]);

  // Initial + context-filter reload
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (dayBoundaryKeyRef.current === todayKey) return;
    dayBoundaryKeyRef.current = todayKey;
    scheduleBackgroundRefresh();
    setScheduleRefreshTick((n) => n + 1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todayKey]);

  useEffect(() => {
    try {
      setTodaySuggestionHandled(localStorage.getItem(todaySuggestionDecisionKey) !== null);
    } catch {
      setTodaySuggestionHandled(false);
    }
  }, [todaySuggestionDecisionKey]);

  useEffect(() => {
    calendarStatusGenerationRef.current += 1;
    calendarStatusMonthCacheRef.current.clear();
    setCalendarRangeStatusMap(new Map());
  }, [contextFilter]);

  useEffect(() => {
    if (!isLoading) return;
    calendarStatusGenerationRef.current += 1;
    calendarStatusMonthCacheRef.current.clear();
    setCalendarRangeStatusMap(new Map());
  }, [isLoading]);

  useEffect(() => {
    scheduleGenerationRef.current += 1;
    scheduleMonthCacheRef.current.clear();
    scheduleRequestCountRef.current = 0;
    setScheduleLoading(false);
    setScheduleDays([]);
  }, [scheduleRefreshTick]);

  // Fetch only the centered month and its neighbours (or the visible week),
  // caching by month so the rendered stack can grow without repeat requests.
  useEffect(() => {
    if (sidebarMode !== "calendar" && sidebarMode !== "schedule") return;
    if (sidebarMode === "calendar" && isLoading) return;

    const timer = window.setTimeout(() => {
      const requestedMonths = calendarMode === "month"
      ? [-1, 0, 1].map((offset) => startOfMonth(addMonths(monthCursor, offset)))
      : Array.from(new Map(weekDays.map((day) => {
          const month = startOfMonth(day);
          return [calendarMonthKey(month), month] as const;
        })).values());
      const cache = sidebarMode === "calendar" ? calendarStatusMonthCacheRef.current : scheduleMonthCacheRef.current;
      const missingMonths = requestedMonths.filter((month) => !cache.has(calendarMonthKey(month)));
      if (missingMonths.length === 0) return;
      for (const month of missingMonths) cache.add(calendarMonthKey(month));

      const generation = sidebarMode === "calendar"
        ? calendarStatusGenerationRef.current
        : scheduleGenerationRef.current;
      if (sidebarMode === "schedule") {
        scheduleRequestCountRef.current += 1;
        setScheduleLoading(true);
      }

      const fetchMonth = async (month: Date) => {
        const cells = buildMonthCells(month);
        const startDate = toDateKey(cells[0].date);
        const endDate = toDateKey(cells[cells.length - 1].date);
        if (sidebarMode === "calendar") {
          const days = await tasksApi.schedule(startDate, endDate, contextFilter || undefined);
          return { month, startDate, endDate, scheduleDays: days as TaskScheduleDay[] };
        }
        const days = await tasksApi.scheduleCalendar(startDate, endDate);
        return { month, startDate, endDate, calendarDays: days };
      };

      void Promise.all(missingMonths.map(fetchMonth)).then((results) => {
      if (sidebarMode === "calendar") {
        if (calendarStatusGenerationRef.current !== generation) return;
        setCalendarRangeStatusMap((previous) => {
          const next = new Map(previous);
          for (const result of results) {
            for (const day of result.scheduleDays ?? []) {
              const statuses = new Map<string, TaskStatus>();
              for (const item of day.tasks) statuses.set(item.taskId, toTaskStatus(item.status));
              next.set(day.date, statuses);
            }
          }
          return next;
        });
      } else {
        if (scheduleGenerationRef.current !== generation) return;
        setScheduleDays((previous) => {
          const byDate = new Map(previous.map((day) => [day.date, day]));
          for (const result of results) {
            for (const day of result.calendarDays ?? []) byDate.set(day.date, day);
          }
          return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
        });
      }
    }).catch((reason: unknown) => {
      for (const month of missingMonths) cache.delete(calendarMonthKey(month));
      console.error(`[${sidebarMode === "calendar" ? "Due Calendar" : "Schedule"}] Failed to load calendar range`, reason);
      }).finally(() => {
      if (sidebarMode === "schedule" && scheduleGenerationRef.current === generation) {
        scheduleRequestCountRef.current = Math.max(0, scheduleRequestCountRef.current - 1);
        setScheduleLoading(scheduleRequestCountRef.current > 0);
      }
      });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [calendarMode, contextFilter, isLoading, monthCursor, scheduleRefreshTick, sidebarMode, weekDays]);

  useLayoutEffect(() => {
    if ((sidebarMode !== "calendar" && sidebarMode !== "schedule") || calendarMode !== "week") return;
    const scrollElement = weekTimelineScrollRef.current;
    if (!scrollElement) return;
    const updateHeight = () => setTimelineAvailableHeight(scrollElement.clientHeight);
    updateHeight();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(scrollElement);
    return () => observer.disconnect();
  }, [calendarMode, sidebarMode]);

  // Reset auto-scroll tracking when leaving week view
  useEffect(() => {
    if ((sidebarMode !== "calendar" && sidebarMode !== "schedule") || calendarMode !== "week") {
      autoScrolledWeekKeyRef.current = "";
    }
  }, [sidebarMode, calendarMode]);

  // Auto-scroll week timeline to current time
  useEffect(() => {
    if ((sidebarMode !== "calendar" && sidebarMode !== "schedule") || calendarMode !== "week") return;
    if (autoScrolledWeekKeyRef.current === visibleWeekKey) return;
    const scrollElement = weekTimelineScrollRef.current;
    if (!scrollElement) return;
    const startMinutes = TIMELINE_START_HOUR * 60;
    const endMinutes = TIMELINE_END_HOUR * 60;
    if (nowMinuteOfDay < startMinutes || nowMinuteOfDay > endMinutes) return;
    const markerTop = ((nowMinuteOfDay - startMinutes) / 60) * timelineHourHeight;
    const target = Math.max(0, markerTop - (scrollElement.clientHeight * 0.35));
    scrollElement.scrollTop = target;
    autoScrolledWeekKeyRef.current = visibleWeekKey;
  }, [calendarMode, nowMinuteOfDay, sidebarMode, timelineHourHeight, visibleWeekKey]);

  // Handle navigation from other pages with a task to open
  const openTaskIdHandledRef = useRef<string | null>(null);
  useEffect(() => {
    const state = location.state as { openTaskId?: string; occurrenceStatus?: TaskStatus } | null;
    const openTaskId = state?.openTaskId;
    if (!openTaskId || tasks.length === 0 || openTaskId === openTaskIdHandledRef.current) return;
    const task = tasks.find((t) => t.id === openTaskId);
    if (task) {
      openTaskIdHandledRef.current = openTaskId;
      setSidebarMode("list");
      selectTask(task, state?.occurrenceStatus);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, location.state]);

  // ── Navigation helpers ────────────────────────────────────────────────────

  const setMonthElement = useCallback((key: string, element: HTMLElement | null) => {
    if (element) monthElementRefs.current.set(key, element);
    else monthElementRefs.current.delete(key);
  }, []);

  const updateCenteredMonth = useCallback(() => {
    const container = monthScrollRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const centerY = containerRect.top + (container.clientHeight / 2);
    let closest: { element: HTMLElement; distance: number } | null = null;
    for (const element of monthElementRefs.current.values()) {
      const rect = element.getBoundingClientRect();
      const distance = centerY < rect.top
        ? rect.top - centerY
        : centerY > rect.bottom
          ? centerY - rect.bottom
          : 0;
      if (!closest || distance < closest.distance) closest = { element, distance };
    }
    const key = closest?.element.dataset.monthKey;
    if (!key || key === calendarMonthKey(monthCursor)) return;
    const [year, month] = key.split("-").map(Number);
    setMonthCursor(new Date(year, month - 1, 1));
  }, [monthCursor]);

  const preserveMonthScrollAnchor = useCallback(() => {
    const container = monthScrollRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const centerY = containerRect.top + (container.clientHeight / 2);
    let anchor: HTMLElement | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const element of monthElementRefs.current.values()) {
      const rect = element.getBoundingClientRect();
      const distance = Math.abs((rect.top + rect.bottom) / 2 - centerY);
      if (distance < bestDistance) {
        anchor = element;
        bestDistance = distance;
      }
    }
    const key = anchor?.dataset.monthKey;
    if (anchor && key) monthScrollAnchorRef.current = { monthKey: key, top: anchor.getBoundingClientRect().top };
  }, []);

  const extendVisibleMonthWindow = useCallback((direction: "earlier" | "later") => {
    if (monthWindowExtendingRef.current) return;
    monthWindowExtendingRef.current = true;
    preserveMonthScrollAnchor();
    setMonthWindow((current) => extendMonthWindow(current, direction).months);
  }, [preserveMonthScrollAnchor]);

  const handleMonthScroll = useCallback(() => {
    const container = monthScrollRef.current;
    if (!container) return;
    if (monthScrollFrameRef.current !== null) window.cancelAnimationFrame(monthScrollFrameRef.current);
    monthScrollFrameRef.current = window.requestAnimationFrame(() => {
      monthScrollFrameRef.current = null;
      updateCenteredMonth();
      const direction = monthWindowDirectionForScroll(container);
      if (direction) extendVisibleMonthWindow(direction);
    });
  }, [extendVisibleMonthWindow, updateCenteredMonth]);

  useLayoutEffect(() => {
    if ((sidebarMode !== "calendar" && sidebarMode !== "schedule") || calendarMode !== "month") {
      monthViewActivationRef.current = "";
      return;
    }
    const container = monthScrollRef.current;
    if (!container) return;

    const anchor = monthScrollAnchorRef.current;
    if (anchor) {
      const element = monthElementRefs.current.get(anchor.monthKey);
      if (element) container.scrollTop += element.getBoundingClientRect().top - anchor.top;
      monthScrollAnchorRef.current = null;
      monthWindowExtendingRef.current = false;
      updateCenteredMonth();
      return;
    }

    const pendingTarget = monthScrollTargetRef.current;
    const activationKey = `${sidebarMode}:month`;
    const targetKey = pendingTarget?.monthKey ?? calendarMonthKey(monthCursor);
    if (pendingTarget || monthViewActivationRef.current !== activationKey) {
      const element = monthElementRefs.current.get(targetKey);
      if (element) {
        container.scrollTo({ top: element.offsetTop, behavior: pendingTarget?.behavior ?? "auto" });
        monthScrollTargetRef.current = null;
        monthViewActivationRef.current = activationKey;
      }
    }
  }, [calendarMode, monthCursor, monthWindow, sidebarMode, updateCenteredMonth]);

  useEffect(() => () => {
    if (monthScrollFrameRef.current !== null) window.cancelAnimationFrame(monthScrollFrameRef.current);
  }, []);

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      const drag = timelineDragRef.current;
      if (!drag) return;
      const range = timelineDragToSnappedRange(
        drag.anchorClientY - drag.rect.top,
        event.clientY - drag.rect.top,
        drag.hourHeight,
        TIMELINE_START_HOUR,
        TIMELINE_END_HOUR
      );
      setTimelineSelection((current) => current ? { ...current, ...range } : current);
    };
    const onMouseUp = (event: MouseEvent) => {
      const drag = timelineDragRef.current;
      if (!drag) return;
      timelineDragRef.current = null;
      if (Math.abs(event.clientY - drag.anchorClientY) < 4) {
        setTimelineSelection(null);
        return;
      }
      const range = timelineDragToSnappedRange(
        drag.anchorClientY - drag.rect.top,
        event.clientY - drag.rect.top,
        drag.hourHeight,
        TIMELINE_START_HOUR,
        TIMELINE_END_HOUR
      );
      setTimelineSelection({
        ...range,
        date: drag.date,
        columnKey: drag.columnKey,
        dragging: false,
        popoverX: Math.max(12, Math.min(window.innerWidth - 300, drag.rect.left + drag.rect.width / 2)),
        popoverY: Math.max(12, Math.min(window.innerHeight - 260, drag.rect.top + range.top + range.height + 8)),
      });
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  useEffect(() => {
    if (!calendarCreateMenu && !timelineSelection) return;
    const cancel = (event: MouseEvent) => {
      if ((event.target as HTMLElement).closest("[data-calendar-interaction-popup='true']")) return;
      setCalendarCreateMenu(null);
      setTimelineSelection(null);
      setTaskPickerOpen(false);
      setTaskPickerQuery("");
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setCalendarCreateMenu(null);
      setTimelineSelection(null);
      setTaskPickerOpen(false);
      setTaskPickerQuery("");
    };
    document.addEventListener("mousedown", cancel);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", cancel);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [calendarCreateMenu, timelineSelection]);

  const scrollToMonth = (target: Date, behavior: ScrollBehavior) => {
    const normalizedTarget = startOfMonth(target);
    const key = calendarMonthKey(normalizedTarget);
    setMonthCursor(normalizedTarget);
    const element = monthElementRefs.current.get(key);
    const container = monthScrollRef.current;
    if (element && container) {
      container.scrollTo({ top: element.offsetTop, behavior });
      return;
    }
    monthScrollTargetRef.current = { monthKey: key, behavior };
    setMonthWindow(buildMonthWindow(normalizedTarget));
  };

  const jumpToday = () => {
    if (calendarMode === "month") scrollToMonth(new Date(), "smooth");
    else setMonthCursor(startOfMonth(new Date()));
    setWeekCursor(startOfWeek(new Date()));
  };

  const movePrevPeriod = () => {
    if (calendarMode === "month") scrollToMonth(addMonths(monthCursor, -1), "smooth");
    else setWeekCursor((p) => addDays(p, -7));
  };

  const moveNextPeriod = () => {
    if (calendarMode === "month") scrollToMonth(addMonths(monthCursor, 1), "smooth");
    else setWeekCursor((p) => addDays(p, 7));
  };

  const handleCenterScroll = (event: UIEvent<HTMLDivElement>) => {
    if (sidebarMode !== "list") return;
    if (quickFilter !== "planned" && quickFilter !== "overdue") return;
    const ct = event.currentTarget;
    const remaining = ct.scrollHeight - ct.scrollTop - ct.clientHeight;
    if (remaining < 140) void loadOccurrencePage(quickFilter, false);
  };

  const openCalendarQuickAdd = (date: string, startTime = "", endTime = "") => {
    const dueDate = normalizeDateKey(date);
    if (!dueDate) return;
    openAddPanel();
    setAddDraft((current) => ({
      ...current,
      recurrence: "ONCE",
      dueDate,
      startTime,
      endTime,
    }));
    setCalendarCreateMenu(null);
    setTimelineSelection(null);
    setTaskPickerOpen(false);
    setTaskPickerQuery("");
  };

  const handleMonthCreateContextMenu = (event: ReactMouseEvent<HTMLDivElement>, date: Date) => {
    event.preventDefault();
    event.stopPropagation();
    setTimelineSelection(null);
    setCalendarCreateMenu(buildMonthCellContextPayload(date, event.clientX, event.clientY));
  };

  const handleTimelineMouseDown = (event: ReactMouseEvent<HTMLDivElement>, day: Date) => {
    if (event.button !== 0 || event.target !== event.currentTarget) return;
    const date = normalizeDateKey(toDateKey(day));
    if (!date) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const columnKey = `timeline-${date}`;
    const range = timelineDragToSnappedRange(
      event.clientY - rect.top,
      event.clientY - rect.top,
      timelineHourHeight,
      TIMELINE_START_HOUR,
      TIMELINE_END_HOUR
    );
    timelineDragRef.current = {
      date,
      columnKey,
      anchorClientY: event.clientY,
      rect,
      hourHeight: timelineHourHeight,
    };
    setCalendarCreateMenu(null);
    setTaskPickerOpen(false);
    setTaskPickerQuery("");
    setTimelineSelection({
      ...range,
      date,
      columnKey,
      dragging: true,
      popoverX: 0,
      popoverY: 0,
    });
    event.preventDefault();
  };

  const handleScheduleExistingTask = async (task: Task) => {
    if (!timelineSelection || scheduleCreating) return;
    const date = normalizeDateKey(timelineSelection.date);
    if (!date) return;
    setScheduleCreating(true);
    try {
      await tasksApi.addToToday(task.id, date, date, {
        startTime: timelineSelection.startTime,
        endTime: timelineSelection.endTime,
      });
      setScheduleRefreshTick((value) => value + 1);
      setTimelineSelection(null);
      setTaskPickerOpen(false);
      setTaskPickerQuery("");
    } catch {
      pushErrorNotification("Failed to add the task to the selected schedule range.");
    } finally {
      setScheduleCreating(false);
    }
  };

  // ── Inline row render helpers ─────────────────────────────────────────────

  const renderOccurrenceRow = (row: TaskOccurrenceRow) => {
    const masterTask = tasks.find((t) => t.id === row.taskId);
    const contextName = resolveContextDisplayName(row.context, masterTask?.contextName);
    return (
      <TaskOccurrenceRowItem
        key={row.key}
        row={row}
        selected={selectedOccurrenceKeys.has(row.key)}
        contextName={contextName}
        contextColorValue={contextColor(row.context)}
        onToggleDone={(item) => { void handleToggleOccurrenceDone(item); }}
        onOpen={(event, item) => { handleOccurrenceClick(event, item); }}
        onOpenContextMenu={(event, item) => {
          ensureContextSelection(item, event.clientX, event.clientY);
        }}
      />
    );
  };

  // ── JSX ───────────────────────────────────────────────────────────────────

  return (
    <section className={[
      "tasks-shell",
      selectedTask ? "has-detail" : "",
      standalone ? "tasks-shell-standalone" : "",
    ].filter(Boolean).join(" ")}>

      {/* Left secondary sidebar */}
      {!standalone && <TasksSecondarySidebar
        sidebarMode={sidebarMode}
        setSidebarMode={setSidebarMode}
        quickFilter={quickFilter}
        setQuickFilter={setQuickFilter}
        counters={counters}
        contextFilter={contextFilter}
        setContextFilter={setContextFilter}
        projectOptions={projectOptions}
        calendarStatusFilter={calendarStatusFilter}
        setCalendarStatusFilter={setCalendarStatusFilter}
        calendarMode={calendarMode}
        onOpenCalendarWindow={(calendar, view) => {
          void openCalendarWindow(buildStandaloneCalendarUrl(calendar, view));
        }}
      />}

      {/* ── Center column ─────────────────────────────── */}
      <div
        className={sidebarMode === "calendar" || sidebarMode === "schedule" ? "tasks-center tasks-center-calendar" : "tasks-center"}
        onScroll={handleCenterScroll}
      >
        {/* Header */}
        <TasksCenterHeader
          sidebarMode={sidebarMode}
          calendarMode={calendarMode}
          periodLabel={periodLabel}
          onMovePrevPeriod={movePrevPeriod}
          onJumpToday={jumpToday}
          onMoveNextPeriod={moveNextPeriod}
          onSetCalendarMode={setCalendarMode}
          onRefreshList={() => { void load({ silent: true }); }}
          onRefreshSchedule={() => setScheduleRefreshTick((n) => n + 1)}
          sortMode={sortMode}
          onSetSortMode={setSortMode}
          onExport={handleExport}
          onImport={handleImport}
          importRef={importRef}
          onOpenAddPanel={openAddPanel}
          standalone={standalone}
          onSetStandaloneView={(mode) => {
            if (mode === "list") setQuickFilter("today");
            setSidebarMode(mode);
          }}
        />

        {displayError && <p className="error" style={{ margin: "0 0 0.5rem", fontSize: "0.8rem" }}>{displayError}</p>}
        {showTodaySuggestion && (
          <TodaySuggestionCard
            count={dueTodayOutsideTodayTasks.length}
            onAddToToday={() => { void handleAddDueTodaySuggestion(); }}
            onCancel={handleDismissDueTodaySuggestion}
            disabled={todaySuggestionApplying}
          />
        )}

        {/* Quick Add Panel */}
        {showAddPanel && (
          <TaskQuickAddPanel
            addDraft={addDraft}
            setAddDraft={setAddDraft}
            addContextInput={addContextInput}
            setAddContextInput={setAddContextInput}
            addAdvancedOpen={addAdvancedOpen}
            setAddAdvancedOpen={setAddAdvancedOpen}
            projectOptions={projectOptions}
            resolveExistingContextOption={resolveExistingContextOption}
            isSaving={isSaving}
            onCancel={() => {
              setShowAddPanel(false);
              setAddAdvancedOpen(false);
              setAddContextInput("");
            }}
            onAddTask={() => { void handleAddTask(); }}
          />
        )}

        {sidebarMode === "list" ? (
          <>
            <TaskListContent
              quickFilter={quickFilter}
              sortMode={sortMode}
              isLoading={isLoading}
              activeOccurrenceRows={activeOccurrenceRows}
              tasks={tasks}
              inboxUpcomingRows={inboxUpcomingRows}
              inboxDoneRows={inboxDoneRows}
              inboxCompletedOpen={inboxCompletedOpen}
              setInboxCompletedOpen={setInboxCompletedOpen}
              todayCompletedOpen={todayCompletedOpen}
              setTodayCompletedOpen={setTodayCompletedOpen}
              occurrenceProjectGroups={occurrenceProjectGroups}
              occurrenceDateGroups={activeOccurrenceDateGroups}
              occurrenceLoading={occurrenceLoading}
              resolveContextDisplayName={resolveContextDisplayName}
              renderOccurrenceRow={renderOccurrenceRow}
            />
            <OccurrenceContextMenu
              visible={occurrenceMenu.visible}
              x={occurrenceMenu.x}
              y={occurrenceMenu.y}
              showMoveDateInput={showMoveDateInput}
              moveDateInput={moveDateInput}
              showMoveProjectInput={showMoveProjectInput}
              moveProjectInput={moveProjectInput}
              selectedOccurrenceKeys={selectedOccurrenceKeys}
              activeOccurrenceRows={activeOccurrenceRows}
              todayMembershipKeys={todayMembershipKeys}
              today={today}
              projectOptions={projectOptions}
              onMarkDone={() => void handleMarkSelectedOccurrences("done")}
              onSkip={() => void handleSkipSelectedTasks()}
              onShowMoveDate={() => {
                setShowMoveProjectInput(false);
                setMoveProjectInput("");
                setShowMoveDateInput(true);
              }}
              onMoveDateChange={setMoveDateInput}
              onConfirmMove={() => void handleConfirmMoveDate()}
              onShowMoveProject={() => {
                setShowMoveDateInput(false);
                setMoveDateInput("");
                setShowMoveProjectInput(true);
              }}
              onMoveProjectChange={setMoveProjectInput}
              onConfirmMoveProject={() => void handleMoveToProjectForSelected()}
              onDeleteSelected={() => void handleDeleteSelectedFromMenu()}
              onToggleToday={(add) => void handleToggleTodayForSelected(add)}
            />
          </>

        ) : sidebarMode === "calendar" ? (
          /* ── Due Calendar ── */
          <section className="task-calendar-shell">
            {calendarMode === "month" ? (
              <div ref={monthScrollRef} className="calendar-month-scroll" onScroll={handleMonthScroll}>
                {monthWindow.map((month) => (
                  <CalendarMonthGrid
                    key={calendarMonthKey(month)}
                    monthCursor={month}
                    mode="due"
                    today={today}
                    filteredTasks={filteredTasks}
                    calendarStatusMap={effectiveCalendarStatusMap}
                    scheduleItemsByDate={filteredScheduleItemsByDate}
                    tasksById={tasksById}
                    setMonthElement={setMonthElement}
                    onOpenDayDetail={setDayDetailDate}
                    onSelectDueTask={(task, date) => selectTask(task, task.status, toDateKey(date))}
                    onSelectScheduleItem={() => undefined}
                    onOpenCreateMenu={handleMonthCreateContextMenu}
                  />
                ))}
              </div>
            ) : (
              /* Week timeline */
              <div className="calendar-week-timeline">
                <div className="calendar-week-timeline-head">
                  <div className="calendar-week-time-col calendar-week-time-col-head"><IcoClock /></div>
                  {weekDays.map((day) => (
                    <div key={`head-${day.toISOString()}`} className={isSameDay(day, today) ? "calendar-week-day-head is-today" : "calendar-week-day-head"}>
                      <small>{weekdays[day.getDay()]}</small>
                      <strong>{day.getDate()}</strong>
                    </div>
                  ))}
                </div>
                <div className="calendar-week-all-day-row">
                  <div className="calendar-week-time-col calendar-week-all-day-label">All Day</div>
                  {weekDays.map((day) => {
                    const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
                    const allDayTasks = (tasksByDate.get(key) || []).filter((t) => !t.startTime && !t.endTime);
                    return (
                      <div key={`allday-${day.toISOString()}`} className="calendar-week-all-day-cell">
                        {allDayTasks.slice(0, 2).map((t) => (
                          <button key={t.id} type="button"
                            className={`calendar-task-pill${t.status === "done" ? " done" : ""}`}
                            onClick={() => selectTask(t, t.status, toDateKey(day))}>{t.title}</button>
                        ))}
                        {allDayTasks.length > 2 && <span className="calendar-week-more">+{allDayTasks.length - 2} more</span>}
                      </div>
                    );
                  })}
                </div>
                <div className="calendar-week-scroll" ref={weekTimelineScrollRef}>
                  <div className="calendar-week-grid">
                    <div className="calendar-week-time-axis" style={{ height: timelineBodyHeight }}>
                      {timelineHours.map((hour) => (
                        <span key={`time-${hour}`} className="calendar-week-time-label" style={{ top: (hour - TIMELINE_START_HOUR) * timelineHourHeight }}>{hourLabel(hour)}</span>
                      ))}
                    </div>
                    {weekDays.map((day) => {
                      const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
                      const timedTasks = (tasksByDate.get(key) || []).filter((t) => t.startTime || t.endTime);
                      const laidOut = layoutTimedItems(timedTasks.map((t) => ({ ...t, task: t })), timelineHourHeight);
                      const isCurrentDay = isSameDay(day, nowDay);
                      const showNowLine = isCurrentDay && nowMinuteOfDay >= TIMELINE_START_HOUR * 60 && nowMinuteOfDay <= TIMELINE_END_HOUR * 60;
                      const nowLineTop = ((nowMinuteOfDay - TIMELINE_START_HOUR * 60) / 60) * timelineHourHeight;
                      return (
                        <div key={`col-${day.toISOString()}`} className="calendar-week-day-column" style={{ height: timelineBodyHeight }} onMouseDown={(event) => handleTimelineMouseDown(event, day)}>
                          {timelineHours.map((hour) => (
                            <span key={`line-${hour}`} className="calendar-week-hour-line" style={{ top: (hour - TIMELINE_START_HOUR) * timelineHourHeight }} />
                          ))}
                          {showNowLine && <span className="calendar-week-now-line" style={{ top: nowLineTop }} />}
                          {timelineSelection?.columnKey === `timeline-${toDateKey(day)}` && (
                            <span className="calendar-week-drag-selection" style={{ top: timelineSelection.top, height: timelineSelection.height }} />
                          )}
                          {laidOut.map((event, idx) => {
                            const t = (event as unknown as { task: Task }).task;
                            const compactClass = event.height < 44 ? " title-only" : event.height < 64 ? " title-priority" : "";
                            const laneW = 100 / event.laneCount;
                            return (
                              <button key={`${t.id}-${idx}`} type="button"
                                className={`calendar-week-event-block${t.status === "done" ? " done" : ""}${compactClass}`}
                                style={{ top: event.top, height: event.height, left: `calc(${laneW * event.lane}% + 2px)`, width: `calc(${laneW}% - 4px)`, zIndex: event.lane + 1 }}
                                onClick={() => selectTask(t, t.status, toDateKey(day))}>
                                <strong>{t.title}</strong>
                                <span>{resolveContextDisplayName(t.context, t.contextName)}</span>
                                <small className="calendar-week-event-time">{event.timeLabel}</small>
                              </button>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
            {isAuthError && <div className="calendar-state-card"><h4>Sign in required</h4><p>Sign in to view your tasks calendar.</p><button type="button" onClick={() => void load({ silent: true })}>Retry</button></div>}
            {!isLoading && !isAuthError && !hasTasksInVisiblePeriod && <div className="calendar-empty-hint"><p>No tasks scheduled for this period.</p></div>}
          </section>

        ) : (
          /* ── Schedule view ── */
          <section className="task-calendar-shell">
            {scheduleLoading && <div className="calendar-empty-hint"><p>Loading schedule…</p></div>}
            {calendarMode === "month" ? (
              <div ref={monthScrollRef} className="calendar-month-scroll" onScroll={handleMonthScroll}>
                {monthWindow.map((month) => (
                  <CalendarMonthGrid
                    key={calendarMonthKey(month)}
                    monthCursor={month}
                    mode="schedule"
                    today={today}
                    filteredTasks={filteredTasks}
                    calendarStatusMap={effectiveCalendarStatusMap}
                    scheduleItemsByDate={filteredScheduleItemsByDate}
                    tasksById={tasksById}
                    setMonthElement={setMonthElement}
                    onOpenDayDetail={() => undefined}
                    onSelectDueTask={() => undefined}
                    onSelectScheduleItem={(item, task) => selectTask(task, item.status as TaskStatus, item.occurrenceDate, item.scheduleId, item.scheduledDate)}
                    onOpenCreateMenu={handleMonthCreateContextMenu}
                  />
                ))}
              </div>
            ) : (
              /* Schedule week timeline */
              <div className="calendar-week-timeline">
                <div className="calendar-week-timeline-head">
                  <div className="calendar-week-time-col calendar-week-time-col-head"><IcoClock /></div>
                  {weekDays.map((day) => (
                    <div key={`sched-head-${day.toISOString()}`} className={isSameDay(day, today) ? "calendar-week-day-head is-today" : "calendar-week-day-head"}>
                      <small>{weekdays[day.getDay()]}</small>
                      <strong>{day.getDate()}</strong>
                    </div>
                  ))}
                </div>
                <div className="calendar-week-scroll" ref={weekTimelineScrollRef}>
                  <div className="calendar-week-grid">
                    <div className="calendar-week-time-axis" style={{ height: timelineBodyHeight }}>
                      {timelineHours.map((hour) => (
                        <span key={`sched-time-${hour}`} className="calendar-week-time-label" style={{ top: (hour - TIMELINE_START_HOUR) * timelineHourHeight }}>{hourLabel(hour)}</span>
                      ))}
                    </div>
                    {weekDays.map((day) => {
                      const dateKey = toDateKey(day);
                      const dayItems = filteredScheduleItemsByDate.get(dateKey) || [];
                      const timedItems = dayItems.filter((i) => i.startTime || i.endTime);
                      const laidOut = layoutTimedItems(timedItems, timelineHourHeight);
                      const isCurrentDay = isSameDay(day, nowDay);
                      const showNowLine = isCurrentDay && nowMinuteOfDay >= TIMELINE_START_HOUR * 60 && nowMinuteOfDay <= TIMELINE_END_HOUR * 60;
                      const nowLineTop = ((nowMinuteOfDay - TIMELINE_START_HOUR * 60) / 60) * timelineHourHeight;
                      return (
                        <div key={`sched-col-${day.toISOString()}`} className="calendar-week-day-column" style={{ height: timelineBodyHeight }} onMouseDown={(event) => handleTimelineMouseDown(event, day)}>
                          {timelineHours.map((hour) => (
                            <span key={`sched-line-${hour}`} className="calendar-week-hour-line" style={{ top: (hour - TIMELINE_START_HOUR) * timelineHourHeight }} />
                          ))}
                          {showNowLine && <span className="calendar-week-now-line" style={{ top: nowLineTop }} />}
                          {timelineSelection?.columnKey === `timeline-${toDateKey(day)}` && (
                            <span className="calendar-week-drag-selection" style={{ top: timelineSelection.top, height: timelineSelection.height }} />
                          )}
                          {laidOut.map((event, idx) => {
                            const item = event as typeof event & ScheduleCalendarItem;
                            const fullTask = tasks.find((t) => t.id === item.taskId);
                            const compactClass = event.height < 44 ? " title-only" : event.height < 64 ? " title-priority" : "";
                            const laneW = 100 / event.laneCount;
                            return (
                              <button key={`${item.scheduleId ?? idx}`} type="button"
                                className={`calendar-week-event-block${item.status === "done" ? " done" : ""}${compactClass}`}
                                style={{ top: event.top, height: event.height, left: `calc(${laneW * event.lane}% + 2px)`, width: `calc(${laneW}% - 4px)`, zIndex: event.lane + 1 }}
                                onClick={() => { if (fullTask) selectTask(fullTask, item.status as TaskStatus, item.occurrenceDate, item.scheduleId, item.scheduledDate); }}>
                                <strong>{item.title}</strong>
                                <span>{resolveContextDisplayName(item.context ?? "", item.context)}</span>
                                <small className="calendar-week-event-time">{event.timeLabel}</small>
                              </button>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </section>
        )}

        {/* Day tasks panel (calendar month click) */}
        {dayDetailDate && sidebarMode === "calendar" && (
          <CalendarDayDetailPanel
            dayDetailDate={dayDetailDate}
            dayDetailTasks={dayDetailTasks}
            onClose={() => setDayDetailDate(null)}
            onSelectTask={(task) => {
              selectTask(task, undefined, toDateKey(dayDetailDate));
              setDayDetailDate(null);
            }}
            resolveContextDisplayName={resolveContextDisplayName}
            contextColor={contextColor}
          />
        )}

        {calendarCreateMenu && (
          <div
            className="task-occurrence-menu calendar-create-menu"
            data-calendar-interaction-popup="true"
            style={{ left: calendarCreateMenu.x, top: calendarCreateMenu.y }}
            onContextMenu={(event) => event.preventDefault()}
          >
            <button type="button" onClick={() => openCalendarQuickAdd(calendarCreateMenu.date)}>
              この日にタスクを追加
            </button>
          </div>
        )}

        {timelineSelection && !timelineSelection.dragging && (
          <div
            className="calendar-range-popover"
            data-calendar-interaction-popup="true"
            style={{ left: timelineSelection.popoverX, top: timelineSelection.popoverY }}
          >
            <p>{timelineSelection.date} {timelineSelection.startTime}–{timelineSelection.endTime}</p>
            {!taskPickerOpen ? (
              <div className="calendar-range-actions">
                <button type="button" onClick={() => openCalendarQuickAdd(timelineSelection.date, timelineSelection.startTime, timelineSelection.endTime)}>
                  新規タスク（この日時）
                </button>
                <button type="button" onClick={() => setTaskPickerOpen(true)}>
                  既存タスクを予定
                </button>
              </div>
            ) : (
              <div className="calendar-task-picker">
                <input
                  type="search"
                  value={taskPickerQuery}
                  onChange={(event) => setTaskPickerQuery(event.target.value)}
                  placeholder="タスクを検索"
                  aria-label="Search existing tasks"
                  autoFocus
                />
                <div className="calendar-task-picker-list">
                  {taskPickerTasks.map((task) => (
                    <button key={task.id} type="button" disabled={scheduleCreating} onClick={() => { void handleScheduleExistingTask(task); }}>
                      <strong>{task.title}</strong>
                      <small>{resolveContextDisplayName(task.context, task.contextName)}</small>
                    </button>
                  ))}
                  {taskPickerTasks.length === 0 && <small className="calendar-task-picker-empty">該当するタスクはありません</small>}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Right detail panel */}
      {selectedTask && (
        <TaskDetailPanel
          selectedTask={selectedTask}
          hasOccurrenceDate={selectedOccurrenceDate != null}
          draft={draft}
          setDraft={setDraft}
          isSaving={isSaving}
          displayError={displayError}
          clearDetail={clearDetail}
          applyAndSave={applyAndSave}
          subtasksLoading={subtasksLoading}
          subtasks={subtasks}
          newSubtaskTitle={newSubtaskTitle}
          setNewSubtaskTitle={setNewSubtaskTitle}
          handleAddSubtask={handleAddSubtask}
          handleToggleSubtask={handleToggleSubtask}
          handleDeleteSubtask={handleDeleteSubtask}
          projectOptions={projectOptions}
          scheduleItemId={scheduleItemId}
          scheduleItemLoading={scheduleItemLoading}
          scheduleDraft={scheduleDraft}
          setScheduleDraft={setScheduleDraft}
          handleSaveScheduleItem={handleSaveScheduleItem}
          handleRemoveScheduleItem={handleRemoveScheduleItem}
          advancedOpen={advancedOpen}
          setAdvancedOpen={setAdvancedOpen}
          attachmentsLoading={attachmentsLoading}
          attachments={attachments}
          attachmentInputRef={attachmentInputRef}
          isDraggingOver={isDraggingOver}
          setIsDraggingOver={setIsDraggingOver}
          handleAttachFiles={mutations.handleAttachFiles}
          handleAttachmentDrop={handleAttachmentDrop}
          handleOpenFileViewer={handleOpenFileViewer}
          handleDeleteAttachment={handleDeleteAttachment}
          historyOpen={historyOpen}
          historyLoading={historyLoading}
          history={history}
          handleHistoryToggle={handleHistoryToggle}
          handleDeleteDetail={handleDeleteDetail}
        />
      )}

      <FileViewerModal fileViewer={fileViewer} onClose={closeFileViewer} />
    </section>
  );
}

