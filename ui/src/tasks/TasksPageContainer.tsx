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
import { tasksApi } from "../lib/api";
import { formatDateTime } from "../lib/format";
import {
  buildMonthCells,
  contextColor,
  hourLabel,
  isAuthErrorMessage,
  loadScoreColor,
  normalizeText,
  parseTimeToMinutes,
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
import {
  emptyDraft,
  RECURRENCE_LABELS, RECURRENCE_TYPES,
  TIMELINE_END_HOUR, TIMELINE_HOUR_HEIGHT, TIMELINE_START_HOUR,
  taskToDraft,
  weekdays,
  type CalendarMode, type QuickFilter, type SidebarMode, type SortMode,
  type TaskOccurrenceRow,
} from "./types";
import { OccurrenceContextMenu } from "./components/OccurrenceContextMenu";
import {
  IcoCal, IcoCalSmall, IcoCheckCircle, IcoChevron, IcoChevronDown,
  IcoClock, IcoCircle, IcoClipboard, IcoDownload, IcoFile, IcoFolder,
  IcoHistory, IcoInbox, IcoList, IcoLock, IcoPin, IcoPlus,
  IcoRefresh, IcoRepeat, IcoSkipped, IcoSun, IcoTrash, IcoUnlock,
  IcoUpload, IcoX, IcoZap, StatusCircle,
} from "./components/icons";

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

  const importRef = useRef<HTMLInputElement>(null);
  const weekTimelineScrollRef = useRef<HTMLDivElement | null>(null);
  const autoScrolledWeekKeyRef = useRef<string>("");

  const today = useMemo(() => startOfDay(new Date()), []);

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
  } = useOccurrencePaging(contextFilter, quickFilter);

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
    const selected = selectedOccurrenceKeys.has(row.key);
    const itemClass = [
      selected ? "task-list-item active" : "task-list-item",
      selected ? "occurrence-selected" : "",
    ].filter(Boolean).join(" ");
    return (
      <li key={row.key}>
        <div className={itemClass}>
          <button type="button" className="task-circle"
            onClick={() => void handleToggleOccurrenceDone(row)} aria-label="Toggle done">
            <StatusCircle status={row.status} />
          </button>
          <button type="button" className="task-list-main"
            onClick={(event) => handleOccurrenceClick(event, row)}
            onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); ensureContextSelection(row, event.clientX, event.clientY); }}>
            <span className={`task-title${row.status === "done" ? " done" : ""}`}>{row.title}</span>
            <span className="task-meta-row">
              {typeof row.load === "number" && (
                <span className="load-badge" style={{ color: loadScoreColor(row.load), borderColor: loadScoreColor(row.load) }}>
                  <IcoZap />{row.load}
                </span>
              )}
              <span className="context-badge" style={{ color: contextColor(row.context) }}>{contextName}</span>
              {row.status !== "done" && <span className="due-badge">{formatDateHeading(row.date)}</span>}
              {(row.startTime || row.endTime) && (
                <span className="time-badge"><IcoClock />{row.startTime || "--:--"}{row.endTime ? ` - ${row.endTime}` : ""}</span>
              )}
              {row.isLocked && <span style={{ color: "#fbbf24" }}><IcoLock /></span>}
            </span>
          </button>
          <span style={{ color: "#374151", flexShrink: 0 }}><IcoChevron /></span>
        </div>
      </li>
    );
  };

  // ── Timeline event layout helper ──────────────────────────────────────────
  type TimedEvent<T> = T & { clippedStart: number; clippedEnd: number; top: number; height: number; timeLabel: string; lane: number; laneCount: number };

  function layoutTimedItems<T extends { startTime?: string; endTime?: string }>(items: T[]): TimedEvent<T>[] {
    const sorted = items
      .map((item) => {
        const startMinuteRaw = parseTimeToMinutes(item.startTime);
        const endMinuteRaw = parseTimeToMinutes(item.endTime);
        const fallbackStart = endMinuteRaw !== null ? Math.max(TIMELINE_START_HOUR * 60, endMinuteRaw - 60) : TIMELINE_START_HOUR * 60;
        const startMinute = startMinuteRaw ?? fallbackStart;
        const fallbackEnd = Math.min(TIMELINE_END_HOUR * 60, startMinute + 60);
        const rawEnd = endMinuteRaw ?? fallbackEnd;
        const clippedStart = Math.max(TIMELINE_START_HOUR * 60, Math.min(startMinute, TIMELINE_END_HOUR * 60));
        const boundedEnd = Math.max(clippedStart + 30, rawEnd);
        const clippedEnd = Math.min(TIMELINE_END_HOUR * 60, boundedEnd);
        if (clippedStart >= TIMELINE_END_HOUR * 60 || clippedEnd <= TIMELINE_START_HOUR * 60) return null;
        const top = ((clippedStart - TIMELINE_START_HOUR * 60) / 60) * TIMELINE_HOUR_HEIGHT;
        const height = Math.max(22, ((clippedEnd - clippedStart) / 60) * TIMELINE_HOUR_HEIGHT);
        const timeLabel = item.startTime ? `${item.startTime}${item.endTime ? ` - ${item.endTime}` : ""}` : hourLabel(Math.floor(clippedStart / 60));
        return { ...item, clippedStart, clippedEnd, top, height, timeLabel, lane: 0, laneCount: 1 };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.clippedStart !== b.clippedStart ? a.clippedStart - b.clippedStart : a.clippedEnd - b.clippedEnd);

    // Lane assignment for overlapping events
    const active: Array<{ lane: number; end: number }> = [];
    let clusterIndexes: number[] = [];
    let clusterMax = 1;
    for (let i = 0; i < sorted.length; i++) {
      const ev = sorted[i];
      for (let ai = active.length - 1; ai >= 0; ai--) {
        if (active[ai].end <= ev.clippedStart) active.splice(ai, 1);
      }
      if (active.length === 0 && clusterIndexes.length > 0) {
        for (const ci of clusterIndexes) sorted[ci].laneCount = clusterMax;
        clusterIndexes = []; clusterMax = 1;
      }
      const used = new Set(active.map((a) => a.lane));
      let lane = 0;
      while (used.has(lane)) lane++;
      ev.lane = lane;
      active.push({ lane, end: ev.clippedEnd });
      clusterIndexes.push(i);
      clusterMax = Math.max(clusterMax, lane + 1);
    }
    if (clusterIndexes.length > 0) for (const ci of clusterIndexes) sorted[ci].laneCount = clusterMax;
    return sorted;
  }

  // ── JSX ───────────────────────────────────────────────────────────────────

  return (
    <section className={selectedTask ? "tasks-shell has-detail" : "tasks-shell"}>

      {/* ── Left secondary sidebar ─────────────────────── */}
      <aside className="tasks-secondary">
        <header className="tasks-secondary-head">
          <h2><IcoClipboard /> Tasks</h2>
        </header>
        <div className="tasks-secondary-group" style={{ borderTop: 0, paddingTop: 0 }}>
          <button type="button" className={sidebarMode === "list" ? "sidebar-tab active" : "sidebar-tab"} onClick={() => setSidebarMode("list")}><IcoList /> Task List</button>
          <button type="button" className={sidebarMode === "calendar" ? "sidebar-tab active" : "sidebar-tab"} onClick={() => setSidebarMode("calendar")}><IcoCal /> Due Calendar</button>
          <button type="button" className={sidebarMode === "schedule" ? "sidebar-tab active" : "sidebar-tab"} onClick={() => setSidebarMode("schedule")}><IcoCal /> Schedule</button>
        </div>

        {sidebarMode === "list" && (
          <>
            <div className="tasks-secondary-group">
              <p>Task Filters</p>
              <button type="button" className={quickFilter === "today" ? "filter-item active" : "filter-item"} onClick={() => setQuickFilter("today")}>
                <span className="filter-item-left"><IcoSun /><span>Today</span></span><small>{counters.today}</small>
              </button>
              <button type="button" className={quickFilter === "myday" ? "filter-item active" : "filter-item"} onClick={() => setQuickFilter("myday")}>
                <span className="filter-item-left"><IcoCheckCircle /><span>My Day</span></span><small>{counters.myday}</small>
              </button>
              <button type="button" className={quickFilter === "planned" ? "filter-item active" : "filter-item"} onClick={() => setQuickFilter("planned")}>
                <span className="filter-item-left"><IcoCalSmall /><span>Planned</span></span><small>{counters.planned}</small>
              </button>
              <button type="button" className={quickFilter === "overdue" ? "filter-item active" : "filter-item"} onClick={() => setQuickFilter("overdue")}>
                <span className="filter-item-left"><IcoClock /><span>Overdue</span></span><small>{counters.overdue}</small>
              </button>
              <button type="button" className={quickFilter === "inbox" ? "filter-item active" : "filter-item"} onClick={() => setQuickFilter("inbox")}>
                <span className="filter-item-left"><IcoInbox /><span>Inbox</span></span><small>{counters.inbox}</small>
              </button>
            </div>
            <div className="tasks-secondary-group">
              <p>Projects</p>
              <button type="button" className={contextFilter === "" ? "filter-item active" : "filter-item"} onClick={() => setContextFilter("")}>
                <span className="filter-item-left"><IcoFolder /><span>All Projects</span></span>
              </button>
              {projectOptions.map((p) => (
                <button key={p.projectId} type="button"
                  className={contextFilter === p.projectId ? "filter-item active" : "filter-item"}
                  onClick={() => setContextFilter(p.projectId)}>
                  <span className="filter-item-left">
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: contextColor(p.projectId), flexShrink: 0, display: "inline-block" }} />
                    <span>{p.projectName || p.projectId}</span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {(sidebarMode === "calendar" || sidebarMode === "schedule") && (
          <>
            <div className="tasks-secondary-group">
              <p>Calendar Status</p>
              <button type="button" className={calendarStatusFilter === "all" ? "filter-item active" : "filter-item"} onClick={() => setCalendarStatusFilter("all")}>
                <span className="filter-item-left"><IcoFolder /><span>All Status</span></span>
              </button>
              <button type="button" className={calendarStatusFilter === "open" ? "filter-item active" : "filter-item"} onClick={() => setCalendarStatusFilter("open")}>
                <span className="filter-item-left"><IcoCircle /><span>Open Only</span></span>
              </button>
              <button type="button" className={calendarStatusFilter === "done" ? "filter-item active" : "filter-item"} onClick={() => setCalendarStatusFilter("done")}>
                <span className="filter-item-left"><IcoCheckCircle /><span>Done Only</span></span>
              </button>
            </div>
            <div className="tasks-secondary-group">
              <p>Projects</p>
              <button type="button" className={contextFilter === "" ? "filter-item active" : "filter-item"} onClick={() => setContextFilter("")}>
                <span className="filter-item-left"><IcoFolder /><span>All Projects</span></span>
              </button>
              {projectOptions.map((p) => (
                <button key={p.projectId} type="button"
                  className={contextFilter === p.projectId ? "filter-item active" : "filter-item"}
                  onClick={() => setContextFilter(p.projectId)}>
                  <span className="filter-item-left">
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: contextColor(p.projectId), flexShrink: 0, display: "inline-block" }} />
                    <span>{p.projectName || p.projectId}</span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </aside>

      {/* ── Center column ─────────────────────────────── */}
      <div className="tasks-center" onScroll={handleCenterScroll}>
        {/* Header */}
        {(sidebarMode === "calendar" || sidebarMode === "schedule") ? (
          <header className="tasks-center-head tasks-center-head-calendar">
            <div className="calendar-nav-cluster">
              <button type="button" className="calendar-nav-btn" onClick={movePrevPeriod}>{"<"}</button>
              <button type="button" className="calendar-nav-today" onClick={jumpToday}>Today</button>
              <button type="button" className="calendar-nav-btn" onClick={moveNextPeriod}>{">"}</button>
              <strong>{periodLabel}</strong>
            </div>
            <div className="tasks-head-actions calendar-head-actions">
              <div className="calendar-view-toggle">
                <button type="button" className={calendarMode === "month" ? "active" : ""} onClick={() => setCalendarMode("month")} aria-label="Month view"><IcoCal /></button>
                <button type="button" className={calendarMode === "week" ? "active" : ""} onClick={() => setCalendarMode("week")} aria-label="Week view"><IcoList /></button>
              </div>
              {sidebarMode === "schedule"
                ? <button type="button" className="icon-button" onClick={() => setScheduleRefreshTick((n) => n + 1)} title="Refresh Schedule"><IcoRefresh /></button>
                : <button type="button" className="icon-button" onClick={() => void load()} title="Refresh"><IcoRefresh /></button>
              }
            </div>
          </header>
        ) : (
          <header className="tasks-center-head">
            <div>
              <p>{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</p>
            </div>
            <div className="tasks-head-actions">
              <select className="sort-select" value={sortMode} onChange={(e) => setSortMode(e.target.value as SortMode)}>
                <option value="load">Sort: Load</option>
                <option value="due">Sort: Due Date</option>
                <option value="project">Sort: Project</option>
              </select>
              <button type="button" className="icon-button" onClick={handleExport} title="Export CSV"><IcoDownload /></button>
              <button type="button" className="icon-button" onClick={() => importRef.current?.click()} title="Import CSV"><IcoUpload /></button>
              <input ref={importRef} type="file" accept=".csv" style={{ display: "none" }} onChange={handleImport} />
              <button type="button" className="icon-button" onClick={() => void load()} title="Refresh"><IcoRefresh /></button>
              <button type="button" className="tasks-add-btn" onClick={openAddPanel}>+ Add</button>
            </div>
          </header>
        )}

        {displayError && <p className="error" style={{ margin: "0 0 0.5rem", fontSize: "0.8rem" }}>{displayError}</p>}

        {/* ── Quick Add Panel ── */}
        {showAddPanel && sidebarMode === "list" && (
          <div className="task-add-panel">
            <p className="task-add-panel-kicker">New Task</p>
            <div className="task-add-panel-body">
              <div className="task-add-row">
                <input className="task-add-title-input" placeholder="Task name..." value={addDraft.title}
                  onChange={(e) => setAddDraft((p) => ({ ...p, title: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && void handleAddTask()} />
              </div>
              <div className={addDraft.recurrence === "ONCE" ? "task-add-compact-row" : "task-add-compact-row without-date"}>
                <label className="task-add-select task-add-select-context">
                  <span className="task-add-select-icon"><IcoFolder /></span>
                  <input list="task-context-options" className="task-add-context-input"
                    placeholder="Type or select context" value={addContextInput}
                    onChange={(e) => {
                      const value = e.target.value;
                      setAddContextInput(value);
                      const matched = resolveExistingContextOption(value);
                      setAddDraft((p) => ({ ...p, context: matched?.projectId || "" }));
                    }} />
                  <datalist id="task-context-options">
                    {projectOptions.map((p) => <option key={p.projectId} value={p.projectName || p.projectId} />)}
                  </datalist>
                </label>
                <label className="task-add-select task-add-select-load">
                  <span className="task-add-select-icon">#</span>
                  <input type="number" min={0} max={10} value={addDraft.baseLoadScore}
                    onChange={(e) => setAddDraft((p) => ({ ...p, baseLoadScore: Number(e.target.value) }))} />
                </label>
                {addDraft.recurrence === "ONCE" && (
                  <label className="task-add-select task-add-select-date">
                    <span className="task-add-select-icon"><IcoCalSmall /></span>
                    <input type="date" value={addDraft.dueDate}
                      onChange={(e) => setAddDraft((p) => ({ ...p, dueDate: e.target.value }))} />
                  </label>
                )}
              </div>
              <button type="button" className="task-add-more-btn" onClick={() => setAddAdvancedOpen((prev) => !prev)}>
                <span className={addAdvancedOpen ? "task-add-more-chevron open" : "task-add-more-chevron"}><IcoChevron /></span>
                More options
              </button>
              {addAdvancedOpen && (
                <div className="task-add-advanced-grid">
                  <div className="edit-section task-add-advanced-span">
                    <div className="edit-section-label">Recurrence</div>
                    <select className="edit-input" value={addDraft.recurrence}
                      onChange={(e) => {
                        const recurrence = e.target.value as typeof addDraft.recurrence;
                        setAddDraft((p) => ({ ...p, recurrence, dueDate: recurrence === "ONCE" ? p.dueDate : "", activeFrom: recurrence === "ONCE" ? "" : p.activeFrom, activeUntil: recurrence === "ONCE" ? "" : p.activeUntil }));
                      }}>
                      {RECURRENCE_TYPES.map((r) => <option key={r} value={r}>{RECURRENCE_LABELS[r]}</option>)}
                    </select>
                  </div>
                  {addDraft.recurrence === "WEEKLY" && (
                    <div className="edit-section task-add-advanced-span">
                      <div className="weekday-picker">
                        {(["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const).map((d, i) => (
                          <button key={d} type="button" className={addDraft[d] ? "weekday-btn active" : "weekday-btn"}
                            onClick={() => setAddDraft((p) => ({ ...p, [d]: !p[d] }))}>{weekdays[i]}</button>
                        ))}
                      </div>
                    </div>
                  )}
                  {addDraft.recurrence === "EVERY_N_DAYS" && (
                    <>
                      <div className="edit-section task-add-advanced-span">
                        <div className="edit-section-label">Every N Days</div>
                        <input type="number" min={1} className="edit-input" value={addDraft.intervalDays}
                          onChange={(e) => setAddDraft((p) => ({ ...p, intervalDays: Number(e.target.value) }))} />
                      </div>
                      <div className="edit-section task-add-advanced-span">
                        <div className="edit-section-label">Anchor Date</div>
                        <input type="date" className="edit-input" value={addDraft.anchorDate}
                          onChange={(e) => setAddDraft((p) => ({ ...p, anchorDate: e.target.value }))} />
                      </div>
                    </>
                  )}
                  {addDraft.recurrence === "MONTHLY_DAY" && (
                    <div className="edit-section">
                      <div className="edit-section-label">Day of Month</div>
                      <input type="number" min={1} max={31} className="edit-input" value={addDraft.monthDay}
                        onChange={(e) => setAddDraft((p) => ({ ...p, monthDay: Number(e.target.value) }))} />
                    </div>
                  )}
                  {addDraft.recurrence === "MONTHLY_NTH_WEEKDAY" && (
                    <>
                      <div className="edit-section">
                        <div className="edit-section-label">Nth Week</div>
                        <input type="number" min={1} max={5} className="edit-input" value={addDraft.nthInMonth}
                          onChange={(e) => setAddDraft((p) => ({ ...p, nthInMonth: Number(e.target.value) }))} />
                      </div>
                      <div className="edit-section">
                        <div className="edit-section-label">Weekday</div>
                        <select className="edit-input" value={addDraft.weekdayMon1}
                          onChange={(e) => setAddDraft((p) => ({ ...p, weekdayMon1: Number(e.target.value) }))}>
                          {weekdays.map((d, i) => <option key={d} value={i}>{d}</option>)}
                        </select>
                      </div>
                    </>
                  )}
                  {addDraft.recurrence !== "ONCE" && (
                    <>
                      <div className="edit-section">
                        <div className="edit-section-label">Active From</div>
                        <input type="date" className="edit-input" value={addDraft.activeFrom}
                          onChange={(e) => setAddDraft((p) => ({ ...p, activeFrom: e.target.value }))} />
                      </div>
                      <div className="edit-section">
                        <div className="edit-section-label">Active Until</div>
                        <input type="date" className="edit-input" value={addDraft.activeUntil}
                          onChange={(e) => setAddDraft((p) => ({ ...p, activeUntil: e.target.value }))} />
                      </div>
                    </>
                  )}
                  <div className="edit-two-col task-add-advanced-span">
                    <div className="edit-section">
                      <div className="edit-section-label">Start Time</div>
                      <input type="time" className="edit-input" value={addDraft.startTime}
                        onChange={(e) => setAddDraft((p) => ({ ...p, startTime: e.target.value }))} />
                    </div>
                    <div className="edit-section">
                      <div className="edit-section-label">End Time</div>
                      <input type="time" className="edit-input" value={addDraft.endTime}
                        onChange={(e) => setAddDraft((p) => ({ ...p, endTime: e.target.value }))} />
                    </div>
                  </div>
                  <div className="edit-section">
                    <div className="edit-section-label">Timezone</div>
                    <input className="edit-input" value={addDraft.timezone}
                      onChange={(e) => setAddDraft((p) => ({ ...p, timezone: e.target.value }))} />
                  </div>
                  <div className="edit-section task-add-advanced-notes">
                    <div className="edit-section-label">Notes</div>
                    <textarea className="edit-input" value={addDraft.notes}
                      onChange={(e) => setAddDraft((p) => ({ ...p, notes: e.target.value }))} />
                  </div>
                </div>
              )}
              <div className="task-add-actions">
                <button type="button" className="task-add-cancel"
                  onClick={() => { setShowAddPanel(false); setAddAdvancedOpen(false); setAddContextInput(""); }}>Cancel</button>
                <button type="button" className="task-add-submit" onClick={handleAddTask} disabled={isSaving}>
                  {isSaving ? "Creating..." : "Add Task"}
                </button>
              </div>
            </div>
          </div>
        )}

        {sidebarMode === "list" ? (
          /* ── Task List ── */
          <section className="task-list-section">
            {activeOccurrenceRows.length === 0 && !isLoading && (
              <div style={{ textAlign: "center", opacity: 0.35, padding: "3rem 0" }}>
                <IcoPlus />
                <p style={{ margin: "0.5rem 0 0", fontSize: "0.7rem", fontWeight: 900, textTransform: "uppercase", letterSpacing: "0.15em" }}>No Tasks</p>
              </div>
            )}

            {quickFilter === "inbox" ? (
              /* ── Inbox ── */
              (() => {
                let upcomingGroups: { key: string; label: string; color?: string; rows: TaskOccurrenceRow[] }[];
                if (sortMode === "project") {
                  const pgm = new Map<string, TaskOccurrenceRow[]>();
                  for (const row of inboxUpcomingRows) {
                    const key = row.context || "";
                    pgm.set(key, [...(pgm.get(key) || []), row]);
                  }
                  upcomingGroups = Array.from(pgm.entries())
                    .sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()))
                    .map(([key, rows]) => {
                      const masterTask = tasks.find((t) => t.context === key);
                      return { key, label: resolveContextDisplayName(key, masterTask?.contextName), color: contextColor(key), rows };
                    });
                } else {
                  const dgm = new Map<string, TaskOccurrenceRow[]>();
                  for (const row of inboxUpcomingRows) dgm.set(row.date, [...(dgm.get(row.date) || []), row]);
                  upcomingGroups = Array.from(dgm.entries()).sort(([a], [b]) => a.localeCompare(b))
                    .map(([date, rows]) => ({ key: date, label: formatDateHeading(date), rows }));
                }
                return (
                  <>
                    {upcomingGroups.map((group) => (
                      <article key={group.key} className="task-date-group">
                        <header>
                          <h4 style={group.color ? { color: group.color } : undefined}>{group.label}</h4>
                          <small>{group.rows.length}</small>
                        </header>
                        <ul>{group.rows.map(renderOccurrenceRow)}</ul>
                      </article>
                    ))}
                    {inboxDoneRows.length > 0 && (
                      <article className="task-project-block task-completed-section">
                        <header style={{ cursor: "pointer" }} onClick={() => setInboxCompletedOpen((v) => !v)}>
                          <h4 style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
                            <span className={inboxCompletedOpen ? "task-add-more-chevron open" : "task-add-more-chevron"}><IcoChevron /></span>
                            Completed
                          </h4>
                          <small>{inboxDoneRows.length}</small>
                        </header>
                        {inboxCompletedOpen && <ul className="task-flat-occurrence-list">{inboxDoneRows.map(renderOccurrenceRow)}</ul>}
                      </article>
                    )}
                  </>
                );
              })()
            ) : (quickFilter === "today" || quickFilter === "myday") ? (
              /* ── Today / MyDay ── */
              (() => {
                const activeRows = activeOccurrenceRows.filter((r) => r.status !== "done");
                const doneRows = activeOccurrenceRows.filter((r) => r.status === "done");
                return (
                  <>
                    {activeRows.length > 0 && <ul className="task-flat-occurrence-list">{activeRows.map(renderOccurrenceRow)}</ul>}
                    {doneRows.length > 0 && (
                      <article className="task-project-block task-completed-section">
                        <header style={{ cursor: "pointer" }} onClick={() => setTodayCompletedOpen((v) => !v)}>
                          <h4 style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
                            <span className={todayCompletedOpen ? "task-add-more-chevron open" : "task-add-more-chevron"}><IcoChevron /></span>
                            Completed
                          </h4>
                          <small>{doneRows.length}</small>
                        </header>
                        {todayCompletedOpen && <ul className="task-flat-occurrence-list">{doneRows.map(renderOccurrenceRow)}</ul>}
                      </article>
                    )}
                  </>
                );
              })()
            ) : (quickFilter === "planned" || quickFilter === "overdue") ? (
              /* ── Planned / Overdue ── */
              <>
                {(sortMode === "project"
                  ? occurrenceProjectGroups.map((g) => ({ key: g.context, label: g.contextName, dotColor: contextColor(g.context) as string | undefined, rows: g.rows }))
                  : occurrenceDateGroups.map((g) => ({ key: g.date, label: formatDateHeading(g.date), dotColor: undefined as string | undefined, rows: g.rows }))
                ).map((group) => (
                  <article key={group.key} className="task-date-group">
                    <header>
                      <h4 style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
                        {group.dotColor && <span style={{ width: 6, height: 6, borderRadius: "50%", background: group.dotColor, display: "inline-block", flexShrink: 0 }} />}
                        {group.label}
                      </h4>
                      <small>{group.rows.length}</small>
                    </header>
                    <ul>{group.rows.map(renderOccurrenceRow)}</ul>
                  </article>
                ))}
                {occurrenceLoading && <p style={{ color: "#64748b", fontSize: "0.74rem", margin: "0.5rem 0 0.25rem" }}>Loading more...</p>}
              </>
            ) : null}

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
          </section>

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
          <>
            <div className="day-tasks-backdrop" onClick={() => setDayDetailDate(null)} />
            <div className="day-tasks-panel">
              <div className="day-tasks-head">
                <div>
                  <h3>{dayDetailDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</h3>
                </div>
                <button type="button" className="tasks-detail-close" onClick={() => setDayDetailDate(null)}><IcoX /></button>
              </div>
              <div className="day-tasks-body">
                {dayDetailTasks.length === 0 ? (
                  <div className="day-tasks-empty"><IcoPlus /><p>Clear Schedule</p></div>
                ) : dayDetailTasks.map((t) => (
                  <div key={t.id} className="day-task-card" onClick={() => { selectTask(t); setDayDetailDate(null); }}>
                    <div className="day-task-card-top">
                      <StatusCircle status={t.status} />
                      <span>{t.title}</span>
                    </div>
                    <div className="day-task-card-meta">
                      <span style={{ color: contextColor(t.context) }}>{resolveContextDisplayName(t.context, t.contextName)}</span>
                      <span><IcoZap /> {t.baseLoadScore}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Right detail panel ─────────────────────────── */}
      {selectedTask && (
        <button type="button" className="tasks-detail-backdrop" onClick={clearDetail} aria-label="Close detail panel" />
      )}
      {selectedTask && (
        <aside className="tasks-detail">
          <div className="tasks-detail-head">
            <div className="tasks-detail-head-left">
              <button type="button" className={`detail-status-btn ${draft.status}`}
                onClick={() => applyAndSave({ status: draft.status === "todo" ? "done" : draft.status === "done" ? "skipped" : "todo" })}
                title={`Status: ${draft.status}`}>
                {draft.status === "done" ? <IcoCheckCircle /> : draft.status === "skipped" ? <IcoSkipped /> : <IcoCircle />}
              </button>
              <input className="tasks-detail-title-input" value={draft.title}
                onChange={(e) => setDraft((p) => ({ ...p, title: e.target.value }))}
                onBlur={(e) => applyAndSave({ title: e.target.value })} placeholder="Task title" />
            </div>
            <div className="tasks-detail-head-actions">
              {isSaving && <span className="auto-save-dot" title="Saving…" />}
              <button type="button" className={`detail-lock-btn${draft.isLocked ? " active" : ""}`}
                onClick={() => applyAndSave({ isLocked: !draft.isLocked })}
                title={draft.isLocked ? "Locked — click to unlock" : "Unlocked — click to lock"}>
                {draft.isLocked ? <IcoLock /> : <IcoUnlock />}
              </button>
              <button type="button" className="tasks-detail-close" onClick={clearDetail} aria-label="Close"><IcoX /></button>
            </div>
          </div>

          <div className="tasks-detail-body">
            {displayError && <p className="error" style={{ margin: 0, fontSize: "0.8rem" }}>{displayError}</p>}

            {/* Subtasks */}
            <div className="edit-section subtask-section-top">
              {subtasksLoading ? (
                <p style={{ color: "#6b7280", fontSize: "0.75rem", margin: "0.4rem 0" }}>Loading...</p>
              ) : (
                <div className="subtask-list">
                  {subtasks.map((s) => (
                    <div key={s.id} className="subtask-row">
                      <button type="button" className={`subtask-check${s.isDone ? " done" : ""}`}
                        onClick={() => void handleToggleSubtask(s)}>
                        {s.isDone ? <IcoCheckCircle /> : <IcoCircle />}
                      </button>
                      <span className={`subtask-title${s.isDone ? " done" : ""}`}>{s.title}</span>
                      <button type="button" className="attachment-delete" onClick={() => void handleDeleteSubtask(s.id)}><IcoX /></button>
                    </div>
                  ))}
                  <div className="subtask-add-row">
                    <input className="subtask-add-input" placeholder="+ Next step" value={newSubtaskTitle}
                      onChange={(e) => setNewSubtaskTitle(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") void handleAddSubtask(); }} />
                  </div>
                </div>
              )}
            </div>

            {/* Context + Load */}
            <div className="edit-two-col">
              <div className="edit-section">
                <div className="edit-section-label">Context</div>
                <select className="edit-input" value={draft.context} onChange={(e) => applyAndSave({ context: e.target.value })}>
                  <option value="">Select context</option>
                  {projectOptions.map((p) => <option key={p.projectId} value={p.projectId}>{p.projectName || p.projectId}</option>)}
                </select>
              </div>
              <div className="edit-section">
                <div className="edit-section-label">Load (0‒10)</div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  <input type="range" min={0} max={10} step={1} value={draft.baseLoadScore}
                    onChange={(e) => setDraft((p) => ({ ...p, baseLoadScore: Number(e.target.value) }))}
                    onMouseUp={(e) => applyAndSave({ baseLoadScore: Number((e.target as HTMLInputElement).value) })}
                    onTouchEnd={(e) => applyAndSave({ baseLoadScore: Number((e.target as HTMLInputElement).value) })}
                    style={{ flex: 1 }} />
                  <span className="load-badge" style={{ color: loadScoreColor(draft.baseLoadScore), borderColor: loadScoreColor(draft.baseLoadScore), flexShrink: 0 }}>{draft.baseLoadScore}</span>
                </div>
              </div>
            </div>

            {/* Recurrence */}
            <div className="edit-section">
              <div className="edit-section-label">Recurrence</div>
              <select className="edit-input" value={draft.recurrence} onChange={(e) => applyAndSave({ recurrence: e.target.value as typeof draft.recurrence })}>
                {RECURRENCE_TYPES.map((r) => <option key={r} value={r}>{RECURRENCE_LABELS[r]}</option>)}
              </select>
            </div>

            {draft.recurrence === "WEEKLY" && (
              <div className="edit-section">
                <div className="edit-section-label">Days</div>
                <div className="weekday-picker">
                  {(["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const).map((d, i) => (
                    <button key={d} type="button" className={draft[d] ? "weekday-btn active" : "weekday-btn"}
                      onClick={() => applyAndSave({ [d]: !draft[d] })}>{weekdays[i]}</button>
                  ))}
                </div>
              </div>
            )}
            {draft.recurrence === "EVERY_N_DAYS" && (
              <>
                <div className="edit-section">
                  <div className="edit-section-label">Every N Days</div>
                  <input type="number" min={1} className="edit-input" value={draft.intervalDays}
                    onChange={(e) => setDraft((p) => ({ ...p, intervalDays: Number(e.target.value) }))}
                    onBlur={(e) => applyAndSave({ intervalDays: Number(e.target.value) })} />
                </div>
                <div className="edit-section">
                  <div className="edit-section-label">Anchor Date</div>
                  <input type="date" className="edit-input" value={draft.anchorDate}
                    onChange={(e) => applyAndSave({ anchorDate: e.target.value })} />
                </div>
              </>
            )}
            {draft.recurrence === "MONTHLY_DAY" && (
              <div className="edit-section">
                <div className="edit-section-label">Day of Month</div>
                <input type="number" min={1} max={31} className="edit-input" value={draft.monthDay}
                  onChange={(e) => setDraft((p) => ({ ...p, monthDay: Number(e.target.value) }))}
                  onBlur={(e) => applyAndSave({ monthDay: Number(e.target.value) })} />
              </div>
            )}
            {draft.recurrence === "MONTHLY_NTH_WEEKDAY" && (
              <div className="edit-two-col">
                <div className="edit-section">
                  <div className="edit-section-label">Nth Week</div>
                  <input type="number" min={1} max={5} className="edit-input" value={draft.nthInMonth}
                    onChange={(e) => setDraft((p) => ({ ...p, nthInMonth: Number(e.target.value) }))}
                    onBlur={(e) => applyAndSave({ nthInMonth: Number(e.target.value) })} />
                </div>
                <div className="edit-section">
                  <div className="edit-section-label">Weekday</div>
                  <select className="edit-input" value={draft.weekdayMon1} onChange={(e) => applyAndSave({ weekdayMon1: Number(e.target.value) })}>
                    {weekdays.map((d, i) => <option key={d} value={i}>{d}</option>)}
                  </select>
                </div>
              </div>
            )}

            {/* Due Date card */}
            <div className="detail-card">
              <div className="detail-card-label">Due Date</div>
              {draft.recurrence === "ONCE" ? (
                <input type="date" className="edit-input detail-card-date" value={draft.dueDate}
                  onChange={(e) => applyAndSave({ dueDate: e.target.value })} />
              ) : (
                <p className="detail-card-recurring-note">Recurring — controlled by schedule</p>
              )}
              <div className="edit-two-col" style={{ marginTop: "0.45rem" }}>
                <div className="edit-section">
                  <div className="edit-section-label">Start Time</div>
                  <input type="time" className="edit-input" value={draft.startTime}
                    onChange={(e) => applyAndSave({ startTime: e.target.value })} />
                </div>
                <div className="edit-section">
                  <div className="edit-section-label">End Time</div>
                  <input type="time" className="edit-input" value={draft.endTime}
                    onChange={(e) => applyAndSave({ endTime: e.target.value })} />
                </div>
              </div>
              <div className="edit-section" style={{ marginTop: "0.45rem" }}>
                <div className="edit-section-label">Timezone</div>
                <input className="edit-input" value={draft.timezone}
                  onChange={(e) => setDraft((p) => ({ ...p, timezone: e.target.value }))}
                  onBlur={(e) => applyAndSave({ timezone: e.target.value })} placeholder="e.g. Asia/Tokyo" />
              </div>
            </div>

            {/* Scheduled Date card */}
            <div className="detail-card">
              <div className="detail-card-label-row">
                <span className="detail-card-label">Scheduled Date</span>
                {scheduleItemId != null && (
                  <button type="button" className="detail-card-remove-btn" onClick={() => void handleRemoveScheduleItem()}>✕</button>
                )}
              </div>
              {scheduleItemLoading ? (
                <p className="detail-card-loading">Loading…</p>
              ) : scheduleDraft ? (
                <>
                  <input type="date"
                    className={`edit-input detail-card-date${scheduleItemId != null ? " has-value" : ""}`}
                    value={scheduleDraft.scheduledDate}
                    onChange={(e) => setScheduleDraft((p) => p ? { ...p, scheduledDate: e.target.value } : p)}
                    onBlur={() => void handleSaveScheduleItem()} />
                  <div className="edit-two-col" style={{ marginTop: "0.45rem" }}>
                    <div className="edit-section">
                      <div className="edit-section-label">Start Time</div>
                      <input type="time" className="edit-input" value={scheduleDraft.startTime}
                        onChange={(e) => setScheduleDraft((p) => p ? { ...p, startTime: e.target.value } : p)}
                        onBlur={() => void handleSaveScheduleItem()} />
                    </div>
                    <div className="edit-section">
                      <div className="edit-section-label">End Time</div>
                      <input type="time" className="edit-input" value={scheduleDraft.endTime}
                        onChange={(e) => setScheduleDraft((p) => p ? { ...p, endTime: e.target.value } : p)}
                        onBlur={() => void handleSaveScheduleItem()} />
                    </div>
                  </div>
                  <div className="edit-section" style={{ marginTop: "0.45rem" }}>
                    <div className="edit-section-label">Timezone</div>
                    <input className="edit-input" value={scheduleDraft.timezone}
                      onChange={(e) => setScheduleDraft((p) => p ? { ...p, timezone: e.target.value } : p)}
                      onBlur={() => void handleSaveScheduleItem()} placeholder="e.g. Asia/Tokyo" />
                  </div>
                </>
              ) : null}
            </div>

            {/* Notes */}
            <div className="edit-section">
              <div className="edit-section-label">Notes</div>
              <textarea className="edit-input" rows={4} value={draft.notes}
                onChange={(e) => setDraft((p) => ({ ...p, notes: e.target.value }))}
                onBlur={(e) => applyAndSave({ notes: e.target.value })} placeholder="Notes..." />
            </div>

            {/* Advanced settings */}
            <div className="edit-section">
              <button type="button" className="history-toggle" onClick={() => setAdvancedOpen((v) => !v)}>
                <IcoHistory /><span>Advanced Setting</span>
                <span style={{ marginLeft: "auto", transform: advancedOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.15s" }}><IcoChevronDown /></span>
              </button>
              {advancedOpen && (
                <div className="history-body advanced-body">
                  {draft.recurrence !== "ONCE" && (
                    <div className="edit-two-col" style={{ padding: "0 0.2rem 0.45rem" }}>
                      <div className="edit-section">
                        <div className="edit-section-label">Active From</div>
                        <input type="date" className="edit-input" value={draft.activeFrom}
                          onChange={(e) => applyAndSave({ activeFrom: e.target.value })} />
                      </div>
                      <div className="edit-section">
                        <div className="edit-section-label">Active Until</div>
                        <input type="date" className="edit-input" value={draft.activeUntil}
                          onChange={(e) => applyAndSave({ activeUntil: e.target.value })} />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Attachments */}
            <div className="edit-section">
              <div className="edit-section-label" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span>Files</span>
                <button type="button" className="ghost-button" style={{ fontSize: "0.72rem", padding: "0.15rem 0.5rem" }}
                  onClick={() => attachmentInputRef.current?.click()}>+ Add</button>
              </div>
              <input ref={attachmentInputRef} type="file" multiple style={{ display: "none" }}
                onChange={(e) => { if (e.target.files) { void mutations.handleAttachFiles(e.target.files); e.target.value = ""; } }} />
              <div className={`attachment-drop-zone${isDraggingOver ? " dragging" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setIsDraggingOver(true); }}
                onDragLeave={() => setIsDraggingOver(false)}
                onDrop={handleAttachmentDrop}>
                {attachmentsLoading ? (
                  <p style={{ color: "#6b7280", fontSize: "0.75rem", margin: "0.4rem 0" }}>Loading...</p>
                ) : attachments.length === 0 ? (
                  <p style={{ color: "#4b5563", fontSize: "0.75rem", margin: "0.4rem 0" }}>Drop files here or use Add</p>
                ) : (
                  <div className="attachment-list">
                    {attachments.map((att) => (
                      <div key={att.id} className="attachment-row">
                        <IcoFile />
                        <button type="button" className="attachment-name" onClick={() => void handleOpenFileViewer(att)}>{att.filename}</button>
                        {att.sizeBytes != null && (
                          <span className="attachment-size">
                            {att.sizeBytes < 1024 * 1024 ? `${Math.round(att.sizeBytes / 1024)} KB` : `${(att.sizeBytes / (1024 * 1024)).toFixed(1)} MB`}
                          </span>
                        )}
                        <button type="button" className="attachment-delete" onClick={() => void handleDeleteAttachment(att.id)}><IcoX /></button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Timestamps */}
            <div className="edit-timestamps">
              <small>Created: {formatDateTime(selectedTask.createdAt)}</small>
              <small>Updated: {formatDateTime(selectedTask.updatedAt)}</small>
            </div>

            {/* Execution History */}
            <div className="edit-section">
              <button type="button" className="history-toggle" onClick={handleHistoryToggle}>
                <IcoHistory /><span>Execution History</span>
                <span style={{ marginLeft: "auto" }}><IcoChevronDown /></span>
              </button>
              {historyOpen && (
                <div className="history-body">
                  {historyLoading ? (
                    <p style={{ color: "#6b7280", fontSize: "0.75rem", margin: "0.5rem 0" }}>Loading...</p>
                  ) : history.length === 0 ? (
                    <p style={{ color: "#4b5563", fontSize: "0.75rem", margin: "0.5rem 0" }}>No history found.</p>
                  ) : history.map((h, i) => (
                    <div key={i} className="history-entry">
                      <span className="history-date">{h.targetDate}</span>
                      <span className={`history-status ${h.status}`}>{h.status}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="edit-footer">
            <button type="button" className="edit-delete-btn" onClick={handleDeleteDetail} disabled={isSaving} title="Delete task"><IcoTrash /></button>
          </div>
        </aside>
      )}

      {/* File viewer modal */}
      {fileViewer && (
        <div className="file-viewer-overlay" onClick={closeFileViewer} role="dialog" aria-modal="true">
          <div className="file-viewer-modal" onClick={(e) => e.stopPropagation()}>
            <div className="file-viewer-header">
              <span className="file-viewer-name"><IcoFile /> {fileViewer.filename}</span>
              <div className="file-viewer-header-actions">
                <button type="button" className="file-viewer-action" title="Download"
                  onClick={() => { const a = document.createElement("a"); a.href = fileViewer.objectUrl; a.download = fileViewer.filename; a.click(); }}>
                  <IcoDownload />
                </button>
                <button type="button" className="file-viewer-close" onClick={closeFileViewer}><IcoX /></button>
              </div>
            </div>
            <div className="file-viewer-body">
              {fileViewer.mimeType.startsWith("image/") ? (
                <img src={fileViewer.objectUrl} alt={fileViewer.filename} className="file-viewer-img" />
              ) : fileViewer.mimeType === "application/pdf" || fileViewer.mimeType.startsWith("text/") ? (
                <iframe src={fileViewer.objectUrl} title={fileViewer.filename} className={`file-viewer-iframe${fileViewer.mimeType.startsWith("text/") ? " file-viewer-text" : ""}`} />
              ) : (
                <div className="file-viewer-unsupported">
                  <IcoFile />
                  <p>{fileViewer.filename}</p>
                  <p style={{ fontSize: "0.8rem", color: "#6b7280" }}>Preview not available for this file type.</p>
                  <button type="button" onClick={() => { const a = document.createElement("a"); a.href = fileViewer.objectUrl; a.download = fileViewer.filename; a.click(); }}>
                    <IcoDownload /> Download
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
