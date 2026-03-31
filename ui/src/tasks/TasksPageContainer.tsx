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
  useCallback, useEffect, useMemo, useRef, useState,
  type DragEvent, type MouseEvent as ReactMouseEvent, type UIEvent
} from "react";
import { useLocation } from "react-router-dom";
import { readWorkbenchSession, tasksApi } from "../lib/api";
import { pushErrorNotification } from "../lib/notificationService";
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
  Task, TaskStatus
} from "../types/models";

// ── New architecture imports ────────────────────────────────────────────────
import { useOccurrencePaging } from "./hooks/useOccurrencePaging";
import { useTaskDataLoader } from "./hooks/useTaskDataLoader";
import { useTaskMutations } from "./hooks/useTaskMutations";
import { useTaskSelection } from "./hooks/useTaskSelection";
import { filterAndSortTasks, computeTaskCounters } from "./lib/taskFilterUtils";
import { sortOccurrenceRows, groupOccurrencesByProject } from "./lib/taskOccurrenceDisplayUtils";
import { buildTasksByDate, filterScheduleItems } from "./lib/taskCalendarUtils";
import { layoutTimedItems } from "./lib/timelineLayoutUtils";
import {
  emptyDraft,
  TIMELINE_END_HOUR, TIMELINE_HOUR_HEIGHT, TIMELINE_START_HOUR,
  taskToDraft,
  weekdays,
  type CalendarMode, type QuickFilter, type SidebarMode, type SortMode,
  type TaskOccurrenceRow,
} from "./types";
import { OccurrenceContextMenu } from "./components/OccurrenceContextMenu";
import { FileViewerModal } from "./components/FileViewerModal";
import { CalendarDayDetailPanel } from "./components/CalendarDayDetailPanel";
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

export function TasksPageContainer() {
  const location = useLocation();

  // ── UI-only local state ──────────────────────────────────────────────────
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("list");
  const [calendarMode, setCalendarMode] = useState<CalendarMode>("month");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("today");
  const [calendarStatusFilter, setCalendarStatusFilter] = useState<"all" | "open" | "done">("all");
  const [contextFilter, setContextFilter] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedOccurrenceDate, setSelectedOccurrenceDate] = useState<string | null>(null);
  const [monthCursor, setMonthCursor] = useState(() => startOfMonth(new Date()));
  const [weekCursor, setWeekCursor] = useState(() => startOfWeek(new Date()));
  const [nowMarker, setNowMarker] = useState(() => new Date());
  const [sortMode, setSortMode] = useState<SortMode>("load");
  const [todayCompletedOpen, setTodayCompletedOpen] = useState(false);
  const [inboxCompletedOpen, setInboxCompletedOpen] = useState(false);
  const [dayDetailDate, setDayDetailDate] = useState<Date | null>(null);
  const [scheduleDays, setScheduleDays] = useState<ScheduleCalendarDay[]>([]);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [scheduleRefreshTick, setScheduleRefreshTick] = useState(0);
  const [todaySuggestionHandled, setTodaySuggestionHandled] = useState(false);
  const [todaySuggestionApplying, setTodaySuggestionApplying] = useState(false);

  const importRef = useRef<HTMLInputElement>(null);
  const weekTimelineScrollRef = useRef<HTMLDivElement | null>(null);
  const autoScrolledWeekKeyRef = useRef<string>("");

  const today = useMemo(() => startOfDay(new Date()), []);
  const todayKey = useMemo(() => toDateKey(today), [today]);

  // ── Clock tick (every 30s for now-marker) ──────────────────────────────
  useEffect(() => {
    const timer = window.setInterval(() => setNowMarker(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // ── Data loader hook ──────────────────────────────────────────────────────
  const {
    tasks, projectOptions,
    todayTaskIds, myDayFlaggedIds, todayRows,
    inboxUpcomingRows, inboxDoneRows,
    plannedCount, overdueCount,
    calendarStatusMap,
    isLoading, error,
    load,
    setTasks, setProjectOptions,
    setTodayRows, setMyDayFlaggedIds,
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
    occurrenceDateGroups,
    occurrenceOrderedKeys,
    loadOccurrencePage,
    resetOccurrences,
    setOccurrenceRows,
  } = useOccurrencePaging(contextFilter);

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
    handleOccurrenceClick: _handleOccClick,
    ensureContextSelection,
    getSelectedOccurrenceRows,
    setOccurrenceMenu,
    setShowMoveDateInput,
    setMoveDateInput,
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
      onReload: load,
      onReloadOccurrences: async (filter) => {
        if (filter === "planned" || filter === "overdue") {
          resetOccurrences();
          await loadOccurrencePage(filter, true);
        } else {
          await load();
        }
      },
      quickFilter,
      projectOptions,
      contextFilter,
      today,
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
  } = mutations;

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

  const selectTask = useCallback((task: Task, occurrenceStatus?: TaskStatus, occurrenceDate?: string) => {
    setSelectedTaskId(task.id);
    const d = taskToDraft(task);
    setDraft(occurrenceStatus !== undefined ? { ...d, status: occurrenceStatus } : d);
    setShowAddPanel(false);
    const date = occurrenceDate ?? task.dueDate ?? new Date().toISOString().slice(0, 10);
    setSelectedOccurrenceDate(date);
    void loadAttachments(task.id);
    void loadSubtasks(task.id, date);
    void loadScheduleItem(task.id, date);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadAttachments, loadSubtasks, loadScheduleItem, setDraft, setShowAddPanel]);

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
    _handleOccClick(event, row, occurrenceOrderedKeys, (r) => {
      const task = tasks.find((t) => t.id === r.taskId);
      if (task) selectTask(task, r.status, r.date);
    });
  };

  const handleToggleOccurrenceDone = async (row: TaskOccurrenceRow) => {
    await _handleToggleOccDone(row, setTodayRows, setOccurrenceRows, setInboxUpcomingRows, setInboxDoneRows);
  };

  const closeMenu = () => setOccurrenceMenu((prev) => ({ ...prev, visible: false }));

  const handleMarkSelectedOccurrences = async (status: TaskStatus) => {
    const rows = getSelectedOccurrenceRows(activeOccurrenceRows);
    await _handleMarkSelected(status, rows, setTodayRows, setOccurrenceRows, setInboxUpcomingRows, setInboxDoneRows, closeMenu);
  };

  const handleSkipSelectedTasks = async () => {
    const rows = getSelectedOccurrenceRows(activeOccurrenceRows);
    await _handleSkipSelected(rows, closeMenu);
  };

  const handleConfirmMoveDate = async () => {
    const rows = getSelectedOccurrenceRows(activeOccurrenceRows);
    await _handleConfirmMove(rows, moveDateInput, setOccurrenceRows, setTodayRows, setInboxUpcomingRows, setInboxDoneRows, clearSelection, closeMenu, setShowMoveDateInput, setMoveDateInput);
  };

  const handleDeleteSelectedFromMenu = async () => {
    const rows = getSelectedOccurrenceRows(activeOccurrenceRows);
    await _handleDeleteSelected(rows, setOccurrenceRows, setTodayRows, setInboxUpcomingRows, setInboxDoneRows, clearSelection, closeMenu);
  };

  const handleToggleTodayForSelected = async (isToday: boolean) => {
    const rows = getSelectedOccurrenceRows(activeOccurrenceRows);
    await _handleToggleToday(isToday, rows, setTodayRows, setMyDayFlaggedIds, closeMenu);
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
      await load();
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
      myDayFlaggedIds, todayTaskIds, today, sortMode,
    }),
    [quickFilter, calendarStatusFilter, sidebarMode, tasks, today, todayTaskIds, myDayFlaggedIds, sortMode]
  );

  const counters = useMemo(
    () => computeTaskCounters(tasks, {
      myDayFlaggedIds, todayTaskIds, today,
      plannedCount, overdueCount, inboxUpcomingCount: inboxUpcomingRows.length,
    }),
    [tasks, today, todayTaskIds, myDayFlaggedIds, plannedCount, overdueCount, inboxUpcomingRows]
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
    return occurrenceRowsOrdered;
  }, [quickFilter, todayOccurrenceRowsOrdered, mydayOccurrenceRowsOrdered, occurrenceRowsOrdered, inboxUpcomingRows, inboxDoneRows]);

  const occurrenceProjectGroups = useMemo(
    () => groupOccurrencesByProject(occurrenceRowsOrdered, tasks, projectNameMap),
    [occurrenceRowsOrdered, tasks, projectNameMap]
  );

  const monthCells = useMemo(() => buildMonthCells(monthCursor), [monthCursor]);
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekCursor, i)), [weekCursor]);

  const tasksByDate = useMemo(() => {
    const visibleDates = calendarMode === "month"
      ? monthCells.map((cell) => startOfDay(cell.date))
      : weekDays.map((d) => startOfDay(d));
    return buildTasksByDate(filteredTasks, visibleDates, calendarStatusMap);
  }, [calendarMode, filteredTasks, monthCells, weekDays, calendarStatusMap]);

  const hasTasksInVisiblePeriod = useMemo(
    () => Array.from(tasksByDate.values()).some((items) => items.length > 0),
    [tasksByDate]
  );

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
  const timelineBodyHeight = useMemo(() => (TIMELINE_END_HOUR - TIMELINE_START_HOUR) * TIMELINE_HOUR_HEIGHT, []);
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

  // Initial + context-filter reload
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    try {
      setTodaySuggestionHandled(localStorage.getItem(todaySuggestionDecisionKey) !== null);
    } catch {
      setTodaySuggestionHandled(false);
    }
  }, [todaySuggestionDecisionKey]);

  // Load schedule calendar data when in schedule mode
  useEffect(() => {
    if (sidebarMode !== "schedule") return;
    let cancelled = false;
    setScheduleLoading(true);
    const fetchData = async () => {
      try {
        let startDate: string, endDate: string;
        if (calendarMode === "month") {
          const cells = buildMonthCells(monthCursor);
          startDate = toDateKey(cells[0].date);
          endDate = toDateKey(cells[cells.length - 1].date);
        } else {
          startDate = toDateKey(weekDays[0]);
          endDate = toDateKey(weekDays[6]);
        }
        const days = await tasksApi.scheduleCalendar(startDate, endDate);
        if (!cancelled) setScheduleDays(days);
      } catch (e) {
        console.error("[Schedule] Failed to load schedule calendar", e);
      } finally {
        if (!cancelled) setScheduleLoading(false);
      }
    };
    void fetchData();
    return () => { cancelled = true; };
  }, [sidebarMode, calendarMode, monthCursor, weekDays, scheduleRefreshTick]);

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
    const markerTop = ((nowMinuteOfDay - startMinutes) / 60) * TIMELINE_HOUR_HEIGHT;
    const target = Math.max(0, markerTop - (scrollElement.clientHeight * 0.35));
    scrollElement.scrollTop = target;
    autoScrolledWeekKeyRef.current = visibleWeekKey;
  }, [calendarMode, nowMinuteOfDay, sidebarMode, visibleWeekKey]);

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

  const jumpToday = () => {
    setMonthCursor(startOfMonth(new Date()));
    setWeekCursor(startOfWeek(new Date()));
  };

  const movePrevPeriod = () => {
    if (calendarMode === "month") setMonthCursor((p) => addMonths(p, -1));
    else setWeekCursor((p) => addDays(p, -7));
  };

  const moveNextPeriod = () => {
    if (calendarMode === "month") setMonthCursor((p) => addMonths(p, 1));
    else setWeekCursor((p) => addDays(p, 7));
  };

  const handleCenterScroll = (event: UIEvent<HTMLDivElement>) => {
    if (sidebarMode !== "list") return;
    if (quickFilter !== "planned" && quickFilter !== "overdue") return;
    const ct = event.currentTarget;
    const remaining = ct.scrollHeight - ct.scrollTop - ct.clientHeight;
    if (remaining < 140) void loadOccurrencePage(quickFilter, false);
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
    <section className={selectedTask ? "tasks-shell has-detail" : "tasks-shell"}>

      {/* Left secondary sidebar */}
      <TasksSecondarySidebar
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
      />

      {/* ── Center column ─────────────────────────────── */}
      <div className="tasks-center" onScroll={handleCenterScroll}>
        {/* Header */}
        <TasksCenterHeader
          sidebarMode={sidebarMode}
          calendarMode={calendarMode}
          periodLabel={periodLabel}
          onMovePrevPeriod={movePrevPeriod}
          onJumpToday={jumpToday}
          onMoveNextPeriod={moveNextPeriod}
          onSetCalendarMode={setCalendarMode}
          onRefreshList={() => { void load(); }}
          onRefreshSchedule={() => setScheduleRefreshTick((n) => n + 1)}
          sortMode={sortMode}
          onSetSortMode={setSortMode}
          onExport={handleExport}
          onImport={handleImport}
          importRef={importRef}
          onOpenAddPanel={openAddPanel}
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
        {showAddPanel && sidebarMode === "list" && (
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
              occurrenceDateGroups={occurrenceDateGroups}
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
              selectedOccurrenceKeys={selectedOccurrenceKeys}
              activeOccurrenceRows={activeOccurrenceRows}
              myDayFlaggedIds={myDayFlaggedIds}
              today={today}
              onMarkDone={() => void handleMarkSelectedOccurrences("done")}
              onSkip={() => void handleSkipSelectedTasks()}
              onShowMoveDate={() => setShowMoveDateInput(true)}
              onMoveDateChange={setMoveDateInput}
              onConfirmMove={() => void handleConfirmMoveDate()}
              onDeleteSelected={() => void handleDeleteSelectedFromMenu()}
              onToggleToday={(add) => void handleToggleTodayForSelected(add)}
            />
          </>

        ) : sidebarMode === "calendar" ? (
          /* ── Due Calendar ── */
          <section className="task-calendar-shell">
            {calendarMode === "month" ? (
              <>
                <div className="calendar-weekdays">{weekdays.map((d) => <span key={d}>{d}</span>)}</div>
                <div className="calendar-month-grid">
                  {monthCells.map((cell) => {
                    const key = `${cell.date.getFullYear()}-${cell.date.getMonth()}-${cell.date.getDate()}`;
                    const dayTasks = tasksByDate.get(key) || [];
                    const isToday = isSameDay(cell.date, today);
                    return (
                      <div key={cell.key}
                        className={["calendar-cell", !cell.inCurrentMonth ? "muted" : "", isToday ? "is-today" : ""].filter(Boolean).join(" ")}
                        onClick={() => setDayDetailDate(cell.date)} style={{ cursor: "pointer" }}>
                        <strong>{cell.date.getDate()}</strong>
                        {dayTasks.slice(0, 3).map((t) => (
                          <button key={t.id} type="button"
                            className={`calendar-task-pill${t.status === "done" ? " done" : ""}`}
                            onClick={(e) => { e.stopPropagation(); selectTask(t, t.status); }}>{t.title}</button>
                        ))}
                        {dayTasks.length > 3 && <small style={{ color: "#6b7280", fontSize: "0.62rem" }}>+{dayTasks.length - 3}</small>}
                      </div>
                    );
                  })}
                </div>
              </>
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
                            onClick={() => selectTask(t, t.status)}>{t.title}</button>
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
                        <span key={`time-${hour}`} className="calendar-week-time-label" style={{ top: (hour - TIMELINE_START_HOUR) * TIMELINE_HOUR_HEIGHT }}>{hourLabel(hour)}</span>
                      ))}
                    </div>
                    {weekDays.map((day) => {
                      const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
                      const timedTasks = (tasksByDate.get(key) || []).filter((t) => t.startTime || t.endTime);
                      const laidOut = layoutTimedItems(timedTasks.map((t) => ({ ...t, task: t })));
                      const isCurrentDay = isSameDay(day, nowDay);
                      const showNowLine = isCurrentDay && nowMinuteOfDay >= TIMELINE_START_HOUR * 60 && nowMinuteOfDay <= TIMELINE_END_HOUR * 60;
                      const nowLineTop = ((nowMinuteOfDay - TIMELINE_START_HOUR * 60) / 60) * TIMELINE_HOUR_HEIGHT;
                      return (
                        <div key={`col-${day.toISOString()}`} className="calendar-week-day-column" style={{ height: timelineBodyHeight }}>
                          {timelineHours.map((hour) => (
                            <span key={`line-${hour}`} className="calendar-week-hour-line" style={{ top: (hour - TIMELINE_START_HOUR) * TIMELINE_HOUR_HEIGHT }} />
                          ))}
                          {showNowLine && <span className="calendar-week-now-line" style={{ top: nowLineTop }} />}
                          {laidOut.map((event, idx) => {
                            const t = (event as unknown as { task: Task }).task;
                            const compactClass = event.height < 44 ? " title-only" : event.height < 64 ? " title-priority" : "";
                            const laneW = 100 / event.laneCount;
                            return (
                              <button key={`${t.id}-${idx}`} type="button"
                                className={`calendar-week-event-block${t.status === "done" ? " done" : ""}${compactClass}`}
                                style={{ top: event.top, height: event.height, left: `calc(${laneW * event.lane}% + 2px)`, width: `calc(${laneW}% - 4px)`, zIndex: event.lane + 1 }}
                                onClick={() => selectTask(t, t.status)}>
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
            {isAuthError && <div className="calendar-state-card"><h4>Sign in required</h4><p>Sign in to view your tasks calendar.</p><button type="button" onClick={() => void load()}>Retry</button></div>}
            {!isLoading && !isAuthError && !hasTasksInVisiblePeriod && <div className="calendar-empty-hint"><p>No tasks scheduled for this period.</p></div>}
          </section>

        ) : (
          /* ── Schedule view ── */
          <section className="task-calendar-shell">
            {scheduleLoading && <div className="calendar-empty-hint"><p>Loading schedule…</p></div>}
            {!scheduleLoading && calendarMode === "month" ? (
              <>
                <div className="calendar-weekdays">{weekdays.map((d) => <span key={d}>{d}</span>)}</div>
                <div className="calendar-month-grid">
                  {monthCells.map((cell) => {
                    const dateKey = toDateKey(cell.date);
                    const dayItems = filteredScheduleItemsByDate.get(dateKey) || [];
                    const isTodayCell = isSameDay(cell.date, today);
                    return (
                      <div key={cell.key} className={["calendar-cell", !cell.inCurrentMonth ? "muted" : "", isTodayCell ? "is-today" : ""].filter(Boolean).join(" ")}>
                        <strong>{cell.date.getDate()}</strong>
                        {dayItems.slice(0, 3).map((item) => {
                          const fullTask = tasks.find((t) => t.id === item.taskId);
                          return (
                            <button key={item.scheduleId} type="button"
                              className={`calendar-task-pill${item.status === "done" ? " done" : ""}`}
                              onClick={() => { if (fullTask) selectTask(fullTask, item.status as TaskStatus, item.occurrenceDate); }}
                              title={item.startTime ? `${item.startTime}${item.endTime ? `–${item.endTime}` : ""} ${item.title}` : item.title}>
                              {item.startTime ? <span className="schedule-pill-time">{item.startTime}</span> : null}
                              {item.title}
                            </button>
                          );
                        })}
                        {dayItems.length > 3 && <small style={{ color: "#6b7280", fontSize: "0.62rem" }}>+{dayItems.length - 3}</small>}
                      </div>
                    );
                  })}
                </div>
              </>
            ) : !scheduleLoading ? (
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
                        <span key={`sched-time-${hour}`} className="calendar-week-time-label" style={{ top: (hour - TIMELINE_START_HOUR) * TIMELINE_HOUR_HEIGHT }}>{hourLabel(hour)}</span>
                      ))}
                    </div>
                    {weekDays.map((day) => {
                      const dateKey = toDateKey(day);
                      const dayItems = filteredScheduleItemsByDate.get(dateKey) || [];
                      const timedItems = dayItems.filter((i) => i.startTime || i.endTime);
                      const laidOut = layoutTimedItems(timedItems);
                      const isCurrentDay = isSameDay(day, nowDay);
                      const showNowLine = isCurrentDay && nowMinuteOfDay >= TIMELINE_START_HOUR * 60 && nowMinuteOfDay <= TIMELINE_END_HOUR * 60;
                      const nowLineTop = ((nowMinuteOfDay - TIMELINE_START_HOUR * 60) / 60) * TIMELINE_HOUR_HEIGHT;
                      return (
                        <div key={`sched-col-${day.toISOString()}`} className="calendar-week-day-column" style={{ height: timelineBodyHeight }}>
                          {timelineHours.map((hour) => (
                            <span key={`sched-line-${hour}`} className="calendar-week-hour-line" style={{ top: (hour - TIMELINE_START_HOUR) * TIMELINE_HOUR_HEIGHT }} />
                          ))}
                          {showNowLine && <span className="calendar-week-now-line" style={{ top: nowLineTop }} />}
                          {laidOut.map((event, idx) => {
                            const item = event as typeof event & ScheduleCalendarItem;
                            const fullTask = tasks.find((t) => t.id === item.taskId);
                            const compactClass = event.height < 44 ? " title-only" : event.height < 64 ? " title-priority" : "";
                            const laneW = 100 / event.laneCount;
                            return (
                              <button key={`${item.scheduleId ?? idx}`} type="button"
                                className={`calendar-week-event-block${item.status === "done" ? " done" : ""}${compactClass}`}
                                style={{ top: event.top, height: event.height, left: `calc(${laneW * event.lane}% + 2px)`, width: `calc(${laneW}% - 4px)`, zIndex: event.lane + 1 }}
                                onClick={() => { if (fullTask) selectTask(fullTask, item.status as TaskStatus, item.occurrenceDate); }}>
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
            ) : null}
          </section>
        )}

        {/* Day tasks panel (calendar month click) */}
        {dayDetailDate && sidebarMode === "calendar" && (
          <CalendarDayDetailPanel
            dayDetailDate={dayDetailDate}
            dayDetailTasks={dayDetailTasks}
            onClose={() => setDayDetailDate(null)}
            onSelectTask={(task) => {
              selectTask(task);
              setDayDetailDate(null);
            }}
            resolveContextDisplayName={resolveContextDisplayName}
            contextColor={contextColor}
          />
        )}
      </div>

      {/* Right detail panel */}
      {selectedTask && (
        <TaskDetailPanel
          selectedTask={selectedTask}
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

