/**
 * useTaskMutations.ts
 * All write operations on tasks: toggle done, toggle pin, occurrence
 * status/move/delete, add/save/delete task, subtask CRUD, attachment CRUD,
 * schedule-item CRUD, export/import, history.
 *
 * Behavior is identical to the handlers that lived in TasksPage.tsx.
 */

import { useCallback, useRef, useState } from "react";
import { formatApiErrorMessage, projectsApi, taskAttachmentsApi, taskSubtasksApi, tasksApi } from "../../lib/api";
import { pushErrorNotification } from "../../lib/notificationService";
import { startOfDay, toDateKey } from "../../lib/taskDateUtils";
import { mergeProjectOptions, normalizeText, type ProjectOption } from "../../lib/taskDisplayUtils";
import type { Task, TaskAttachment, TaskHistoryEntry, TaskSubtask } from "../../types/models";
import {
  occurrenceMembershipKey,
  rowOccurrenceDate,
  rowScheduledDate,
  rowTodayMembershipKey,
  taskOccurrenceRowKey
} from "../lib/taskOccurrenceIdentity";
import {
  runOptimisticOccurrenceMutation,
  type TaskOccurrenceCollections,
  type TaskOccurrenceCollectionSetters
} from "../lib/taskOccurrenceStatusMutation";
import {
  emptyDraft,
  taskToDraft,
  type QuickFilter,
  type TaskDraft,
  type TaskOccurrenceRow
} from "../types";

// ── ScheduleDraft (for the Scheduled Date card) ──────────────────────────────

export interface ScheduleDraft {
  scheduledDate: string;
  startTime: string;
  endTime: string;
  timezone: string;
}

export interface FileViewerState {
  objectUrl: string;
  filename: string;
  mimeType: string;
}

// ── Props required by the hook ───────────────────────────────────────────────

export interface TaskMutationsProps {
  /** The currently selected task ID (or null if none). */
  selectedTaskId: string | null;
  /** The currently selected occurrence date (or null if none). */
  selectedOccurrenceDate: string | null;
  /** Called to open the task in the detail panel. */
  onSelectTask: (task: Task, occurrenceStatus?: import("../../types/models").TaskStatus, occurrenceDate?: string) => void;
  /** Called after any mutation that needs a full data reload. */
  onReload: () => Promise<void>;
  /** Called when planned/overdue paging should be reset after a mutation. */
  onReloadOccurrences: (filter: QuickFilter) => Promise<void>;
  /** Currently active quick filter (used to decide if occurrence paging refresh needed). */
  quickFilter: QuickFilter;
  /** Current list of project options (used in add-task context resolution). */
  projectOptions: ProjectOption[];
  /** Current context filter (used to pre-populate Add Panel context). */
  contextFilter: string;
  /** Today's date key (for add-to-today). */
  today: Date;
}

// ── Returned state + actions ─────────────────────────────────────────────────

export interface TaskMutationsState {
  draft: TaskDraft;
  isSaving: boolean;
  selectedTask: Task | null;
  attachments: TaskAttachment[];
  attachmentsLoading: boolean;
  isDraggingOver: boolean;
  subtasks: TaskSubtask[];
  subtasksLoading: boolean;
  newSubtaskTitle: string;
  fileViewer: FileViewerState | null;
  showAddPanel: boolean;
  addAdvancedOpen: boolean;
  addDraft: TaskDraft;
  addContextInput: string;
  scheduleDraft: ScheduleDraft | null;
  scheduleItemId: number | null;
  scheduleItemLoading: boolean;
  history: TaskHistoryEntry[];
  historyOpen: boolean;
  historyLoading: boolean;
  advancedOpen: boolean;
}

export interface TaskMutationsActions {
  setDraft: React.Dispatch<React.SetStateAction<TaskDraft>>;
  setIsDraggingOver: React.Dispatch<React.SetStateAction<boolean>>;
  setNewSubtaskTitle: React.Dispatch<React.SetStateAction<string>>;
  setShowAddPanel: React.Dispatch<React.SetStateAction<boolean>>;
  setAddAdvancedOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setAddDraft: React.Dispatch<React.SetStateAction<TaskDraft>>;
  setAddContextInput: React.Dispatch<React.SetStateAction<string>>;
  setScheduleDraft: React.Dispatch<React.SetStateAction<ScheduleDraft | null>>;
  setAdvancedOpen: React.Dispatch<React.SetStateAction<boolean>>;
  applyAndSave: (update: Partial<TaskDraft>) => void;
  saveDetail: (d: TaskDraft) => Promise<void>;
  clearDetail: () => void;
  openAddPanel: () => void;
  handleAddTask: () => Promise<void>;
  handleDeleteDetail: () => Promise<void>;
  handleToggleDone: (
    task: Task,
    occurrenceContext?: {
      row: TaskOccurrenceRow;
      current: TaskOccurrenceCollections;
      setters: TaskOccurrenceCollectionSetters;
    }
  ) => Promise<void>;
  handleTogglePin: (task: Task) => Promise<void>;
  handleToggleOccurrenceDone: (
    row: TaskOccurrenceRow,
    current: TaskOccurrenceCollections,
    setters: TaskOccurrenceCollectionSetters
  ) => Promise<void>;
  handleMarkSelectedOccurrences: (
    status: import("../../types/models").TaskStatus,
    selectedRows: TaskOccurrenceRow[],
    current: TaskOccurrenceCollections,
    setters: TaskOccurrenceCollectionSetters,
    closeMenu: () => void
  ) => Promise<void>;
  handleSkipSelectedTasks: (
    selectedRows: TaskOccurrenceRow[],
    closeMenu: () => void
  ) => Promise<void>;
  handleConfirmMoveDate: (
    selectedRows: TaskOccurrenceRow[],
    moveDateInput: string,
    setOccurrenceRows: React.Dispatch<React.SetStateAction<TaskOccurrenceRow[]>>,
    setTodayRows: React.Dispatch<React.SetStateAction<TaskOccurrenceRow[]>>,
    setInboxUpcomingRows: React.Dispatch<React.SetStateAction<TaskOccurrenceRow[]>>,
    setInboxDoneRows: React.Dispatch<React.SetStateAction<TaskOccurrenceRow[]>>,
    clearSelection: () => void,
    closeMenu: () => void,
    setShowMoveDateInput: React.Dispatch<React.SetStateAction<boolean>>,
    setMoveDateInput: React.Dispatch<React.SetStateAction<string>>
  ) => Promise<void>;
  handleMoveSelectedToProject: (
    selectedRows: TaskOccurrenceRow[],
    projectId: string,
    closeMenu: () => void,
    resetProjectInput: () => void
  ) => Promise<void>;
  handleDeleteSelectedFromMenu: (
    selectedRows: TaskOccurrenceRow[],
    setOccurrenceRows: React.Dispatch<React.SetStateAction<TaskOccurrenceRow[]>>,
    setTodayRows: React.Dispatch<React.SetStateAction<TaskOccurrenceRow[]>>,
    setInboxUpcomingRows: React.Dispatch<React.SetStateAction<TaskOccurrenceRow[]>>,
    setInboxDoneRows: React.Dispatch<React.SetStateAction<TaskOccurrenceRow[]>>,
    clearSelection: () => void,
    closeMenu: () => void
  ) => Promise<void>;
  handleToggleTodayForSelected: (
    isToday: boolean,
    selectedRows: TaskOccurrenceRow[],
    setTodayRows: React.Dispatch<React.SetStateAction<TaskOccurrenceRow[]>>,
    setTodayMembershipKeys: React.Dispatch<React.SetStateAction<Set<string>>>,
    closeMenu: () => void
  ) => Promise<void>;
  handleAttachFiles: (files: FileList | File[]) => Promise<void>;
  handleAttachmentDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  handleDeleteAttachment: (attachmentId: string) => Promise<void>;
  handleOpenFileViewer: (att: TaskAttachment) => Promise<void>;
  closeFileViewer: () => void;
  handleAddSubtask: () => Promise<void>;
  handleToggleSubtask: (subtask: TaskSubtask) => Promise<void>;
  handleDeleteSubtask: (subtaskId: string) => Promise<void>;
  handleSaveScheduleItem: () => Promise<void>;
  handleRemoveScheduleItem: () => Promise<void>;
  handleHistoryToggle: () => void;
  handleExport: () => Promise<void>;
  handleImport: (e: React.ChangeEvent<HTMLInputElement>) => void;
  loadAttachments: (taskId: string) => Promise<void>;
  loadSubtasks: (taskId: string, occDate: string) => Promise<void>;
  loadScheduleItem: (
    taskId: string,
    occurrenceDate: string,
    identity?: { scheduleId?: number; scheduledDate?: string }
  ) => Promise<void>;
  /** Ref to keep draft fresh for applyAndSave. Must be set each render. */
  draftRef: React.MutableRefObject<TaskDraft>;
  /** Ref for attachment file input. */
  attachmentInputRef: React.RefObject<HTMLInputElement | null>;
  updateProjectOptions: (newOption: ProjectOption) => void;
}

export function useTaskMutations(
  props: TaskMutationsProps,
  tasks: Task[],
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>,
  setProjectOptions: React.Dispatch<React.SetStateAction<ProjectOption[]>>
): TaskMutationsState & TaskMutationsActions {
  const {
    selectedTaskId,
    selectedOccurrenceDate,
    onSelectTask,
    onReload,
    onReloadOccurrences,
    quickFilter,
    projectOptions,
    contextFilter,
    today
  } = props;

  // ── Draft / editing state ──────────────────────────────────────────────────
  const [draft, setDraft] = useState<TaskDraft>(emptyDraft);
  const [isSaving, setIsSaving] = useState(false);
  const [attachments, setAttachments] = useState<TaskAttachment[]>([]);
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [subtasks, setSubtasks] = useState<TaskSubtask[]>([]);
  const [subtasksLoading, setSubtasksLoading] = useState(false);
  const [newSubtaskTitle, setNewSubtaskTitle] = useState("");
  const [fileViewer, setFileViewer] = useState<FileViewerState | null>(null);
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [addAdvancedOpen, setAddAdvancedOpen] = useState(false);
  const [addDraft, setAddDraft] = useState<TaskDraft>({ ...emptyDraft });
  const [addContextInput, setAddContextInput] = useState("");
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft | null>(null);
  const [scheduleItemId, setScheduleItemId] = useState<number | null>(null);
  const [scheduleItemLoading, setScheduleItemLoading] = useState(false);
  const [history, setHistory] = useState<TaskHistoryEntry[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // draftRef — kept in sync by the consumer each render so applyAndSave
  // always reads the freshest draft without stale closure issues.
  const draftRef = useRef<TaskDraft>(emptyDraft);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const occurrenceMutationSequenceRef = useRef(0);
  const occurrenceMutationVersionsRef = useRef(new Map<string, number>());

  // ── Derived ────────────────────────────────────────────────────────────────

  const selectedTask = tasks.find((t) => t.id === selectedTaskId) || null;

  const reportMutationError = (action: string, error: unknown) => {
    const message = formatApiErrorMessage(action, error);
    console.error(message, error);
    pushErrorNotification(message);
  };

  // ── Detail / selection helpers ─────────────────────────────────────────────

  const loadAttachments = useCallback(async (taskId: string) => {
    setAttachmentsLoading(true);
    try {
      const data = await taskAttachmentsApi.list(taskId);
      setAttachments(data);
    } catch {
      /* non-critical */
    } finally {
      setAttachmentsLoading(false);
    }
  }, []);

  const loadSubtasks = useCallback(async (taskId: string, occDate: string) => {
    setSubtasksLoading(true);
    try {
      const data = await taskSubtasksApi.list(taskId, occDate);
      setSubtasks(data);
    } catch {
      /* non-critical */
    } finally {
      setSubtasksLoading(false);
    }
  }, []);

  const loadScheduleItem = useCallback(
    async (
      taskId: string,
      occurrenceDate: string,
      identity?: { scheduleId?: number; scheduledDate?: string }
    ) => {
      setScheduleItemLoading(true);
      setScheduleDraft(null);
      setScheduleItemId(null);
      const fallbackScheduledDate = identity?.scheduledDate ?? occurrenceDate;
      try {
        const items = await tasksApi.scheduleItemsForTask(taskId);
        const matchingItem =
          (identity?.scheduleId != null
            ? items.find((item) => item.id === identity.scheduleId)
            : undefined)
          ?? (identity?.scheduledDate
            ? items.find((item) => item.occurrenceDate === occurrenceDate && item.scheduledDate === identity.scheduledDate)
            : undefined)
          ?? items.find((item) => item.occurrenceDate === occurrenceDate);
        if (matchingItem) {
          setScheduleItemId(matchingItem.id);
          setScheduleDraft({
            scheduledDate: matchingItem.scheduledDate,
            startTime: matchingItem.startTime ?? "",
            endTime: matchingItem.endTime ?? "",
            timezone: matchingItem.timezone ?? "Asia/Tokyo"
          });
        } else {
          setScheduleDraft({
            scheduledDate: fallbackScheduledDate,
            startTime: "",
            endTime: "",
            timezone: "Asia/Tokyo"
          });
        }
      } catch {
        setScheduleDraft({
          scheduledDate: fallbackScheduledDate,
          startTime: "",
          endTime: "",
          timezone: "Asia/Tokyo"
        });
      } finally {
        setScheduleItemLoading(false);
      }
    },
    []
  );

  const clearDetail = () => {
    // Note: selectedTaskId is managed by the parent (TasksPage).
    // Callers also call setSelectedTaskId(null) when invoking clearDetail.
    setDraft(emptyDraft);
    setHistory([]);
    setAdvancedOpen(false);
    setScheduleDraft(null);
    setScheduleItemId(null);
    setAttachments([]);
    setSubtasks([]);
    setNewSubtaskTitle("");
    setFileViewer((prev) => {
      if (prev) URL.revokeObjectURL(prev.objectUrl);
      return null;
    });
  };

  const closeFileViewer = () => {
    setFileViewer((prev) => {
      if (prev) URL.revokeObjectURL(prev.objectUrl);
      return null;
    });
  };

  const handleOpenFileViewer = async (att: TaskAttachment) => {
    if (!selectedTaskId) return;
    try {
      const { blob, filename, mimeType } = await taskAttachmentsApi.fetchBlob(selectedTaskId, att.id);
      const objectUrl = URL.createObjectURL(blob);
      setFileViewer({ objectUrl, filename, mimeType });
    } catch {
      pushErrorNotification("Failed to open file.");
    }
  };

  const openAddPanel = () => {
    setShowAddPanel(true);
    setAddAdvancedOpen(false);
    // selectedTaskId clearing is managed by the parent
    const initialContext = contextFilter || projectOptions[0]?.projectId || "";
    const initialName =
      projectOptions.find((p) => p.projectId === initialContext)?.projectName ||
      initialContext;
    setAddDraft({ ...emptyDraft, context: initialContext });
    setAddContextInput(initialName);
  };

  const resolveExistingContextOption = (rawValue: string): ProjectOption | undefined => {
    const value = rawValue.trim();
    if (!value) return undefined;
    const lower = normalizeText(value);
    return projectOptions.find(
      (option) =>
        option.projectId === value ||
        normalizeText(option.projectId) === lower ||
        (option.projectName && normalizeText(option.projectName) === lower)
    );
  };

  const ensureAddContextProject = async (): Promise<ProjectOption | undefined> => {
    const typed = addContextInput.trim();
    if (!typed) return undefined;
    const existing = resolveExistingContextOption(typed);
    if (existing) return existing;
    const created = await projectsApi.create({ name: typed, status: "active" });
    const createdOption: ProjectOption = { projectId: created.id, projectName: created.name };
    setProjectOptions((prev) => mergeProjectOptions(prev, [createdOption]));
    return createdOption;
  };

  const updateProjectOptions = (newOption: ProjectOption) => {
    setProjectOptions((prev) => mergeProjectOptions(prev, [newOption]));
  };

  // ── Save helpers ───────────────────────────────────────────────────────────

  const saveDetail = useCallback(
    async (d: TaskDraft) => {
      if (!selectedTaskId || !d.title.trim() || !d.context.trim()) return;
      setIsSaving(true);
      try {
        const updated = await tasksApi.update(selectedTaskId, {
          title: d.title.trim(),
          notes: d.notes,
          context: d.context,
          status: d.status,
          isLocked: d.isLocked,
          baseLoadScore: d.baseLoadScore,
          recurrence: d.recurrence,
          dueDate: d.dueDate || undefined,
          startTime: d.startTime || undefined,
          endTime: d.endTime || undefined,
          timezone: d.timezone,
          active: d.active,
          activeFrom: d.activeFrom || undefined,
          activeUntil: d.activeUntil || undefined,
          mon: d.mon, tue: d.tue, wed: d.wed, thu: d.thu,
          fri: d.fri, sat: d.sat, sun: d.sun,
          intervalDays: d.intervalDays,
          anchorDate: d.anchorDate || undefined,
          monthDay: d.monthDay,
          nthInMonth: d.nthInMonth,
          weekdayMon1: d.weekdayMon1
        });
        if (updated) setDraft(taskToDraft(updated));
        await onReload();
      } catch (error) {
        reportMutationError("Failed to save task", error);
      } finally {
        setIsSaving(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedTaskId]
  );

  const applyAndSave = useCallback(
    (update: Partial<TaskDraft>) => {
      const newD = { ...draftRef.current, ...update };
      setDraft(newD);
      void saveDetail(newD);
    },
    [saveDetail]
  );

  // ── CRUD handlers ──────────────────────────────────────────────────────────

  const handleAddTask = async () => {
    if (!addDraft.title.trim()) return;
    setIsSaving(true);
    try {
      const contextOption = await ensureAddContextProject();
      if (!contextOption) return;
      const isOnce = addDraft.recurrence === "ONCE";
      const newTask = await tasksApi.create({
        title: addDraft.title.trim(),
        notes: addDraft.notes,
        context: contextOption.projectId,
        contextName: contextOption.projectName || contextOption.projectId,
        status: addDraft.status,
        isLocked: addDraft.isLocked,
        baseLoadScore: addDraft.baseLoadScore,
        recurrence: addDraft.recurrence,
        dueDate: isOnce ? (addDraft.dueDate || undefined) : undefined,
        startTime: addDraft.startTime || undefined,
        endTime: addDraft.endTime || undefined,
        timezone: addDraft.timezone,
        active: true,
        activeFrom: isOnce ? undefined : (addDraft.activeFrom || undefined),
        activeUntil: isOnce ? undefined : (addDraft.activeUntil || undefined),
        mon: addDraft.mon, tue: addDraft.tue, wed: addDraft.wed, thu: addDraft.thu,
        fri: addDraft.fri, sat: addDraft.sat, sun: addDraft.sun,
        intervalDays: addDraft.intervalDays,
        anchorDate: isOnce ? undefined : (addDraft.anchorDate || undefined),
        monthDay: addDraft.monthDay,
        nthInMonth: addDraft.nthInMonth,
        weekdayMon1: addDraft.weekdayMon1
      } as Parameters<typeof tasksApi.create>[0]);
      // When creating from the Today view, immediately register in today's schedule
      if (quickFilter === "today") {
        const todayKey = toDateKey(today);
        await tasksApi.addToToday(newTask.id, todayKey, todayKey);
      }
      setShowAddPanel(false);
      setAddAdvancedOpen(false);
      setAddDraft({ ...emptyDraft });
      setAddContextInput("");
      await onReload();
    } catch (error) {
      reportMutationError("Failed to add task", error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteDetail = async () => {
    if (!selectedTaskId) return;
    setIsSaving(true);
    try {
      await tasksApi.remove(selectedTaskId);
      clearDetail();
      await onReload();
    } catch {
      /* API errors routed to notification center */
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleDone = async (
    task: Task,
    occurrenceContext?: {
      row: TaskOccurrenceRow;
      current: TaskOccurrenceCollections;
      setters: TaskOccurrenceCollectionSetters;
    }
  ) => {
    const newStatus = task.status === "done" ? "todo" : "done";
    const previousStatus = task.status;
    setTasks((prev) =>
      prev.map((item) => (item.id === task.id ? { ...item, status: newStatus } : item))
    );
    if (selectedTaskId === task.id) {
      setDraft((prev) => ({ ...prev, status: newStatus }));
    }
    try {
      if (occurrenceContext) {
        await runOptimisticOccurrenceMutation({
          current: occurrenceContext.current,
          selectedRows: [occurrenceContext.row],
          status: newStatus,
          setters: occurrenceContext.setters,
          mutate: () => tasksApi.update(task.id, { status: newStatus })
        });
      } else {
        await tasksApi.update(task.id, { status: newStatus });
      }
      await onReload();
    } catch (error) {
      setTasks((prev) =>
        prev.map((item) => (item.id === task.id ? { ...item, status: previousStatus } : item))
      );
      if (selectedTaskId === task.id) {
        setDraft((prev) => ({ ...prev, status: previousStatus }));
      }
      reportMutationError("Failed to update task status", error);
    }
  };

  const handleTogglePin = async (task: Task) => {
    const nextPinned = !(task.isPinned === true);
    setTasks((prev) =>
      prev.map((item) => (item.id === task.id ? { ...item, isPinned: nextPinned } : item))
    );
    try {
      await tasksApi.setPin(task.id, nextPinned);
      await onReload();
    } catch {
      setTasks((prev) =>
        prev.map((item) => (item.id === task.id ? { ...item, isPinned: task.isPinned === true } : item))
      );
      pushErrorNotification("Failed to update pin status.");
    }
  };

  const refreshAfterOccurrenceMutation = async () => {
    await onReload();
    if (quickFilter === "planned" || quickFilter === "overdue") {
      await onReloadOccurrences(quickFilter);
    }
  };

  const handleToggleOccurrenceDone = async (
    row: TaskOccurrenceRow,
    current: TaskOccurrenceCollections,
    setters: TaskOccurrenceCollectionSetters
  ) => {
    if (!row.occurrenceDate && !row.date) {
      const task = tasks.find((item) => item.id === row.taskId);
      if (!task) return;
      await handleToggleDone(task, { row, current, setters });
      return;
    }
    const nextStatus = (row.status === "done" ? "todo" : "done") as import("../../types/models").TaskStatus;
    const occurrenceDate = row.occurrenceDate ?? row.date;
    const mutationVersion = ++occurrenceMutationSequenceRef.current;
    occurrenceMutationVersionsRef.current.set(row.key, mutationVersion);
    try {
      await runOptimisticOccurrenceMutation({
        current,
        selectedRows: [row],
        status: nextStatus,
        setters,
        mutate: () => tasksApi.completeOccurrence(row.taskId, occurrenceDate, nextStatus),
        shouldRollback: (key) => occurrenceMutationVersionsRef.current.get(key) === mutationVersion
      });
      const shouldReconcile = occurrenceMutationVersionsRef.current.get(row.key) === mutationVersion;
      if (shouldReconcile) {
        occurrenceMutationVersionsRef.current.delete(row.key);
        setTimeout(() => { void refreshAfterOccurrenceMutation(); }, 800);
      }
    } catch (error) {
      const shouldReconcile = occurrenceMutationVersionsRef.current.get(row.key) === mutationVersion;
      if (shouldReconcile) {
        occurrenceMutationVersionsRef.current.delete(row.key);
        setTimeout(() => { void refreshAfterOccurrenceMutation(); }, 800);
      }
      reportMutationError("Failed to update occurrence", error);
    }
  };

  const handleMarkSelectedOccurrences = async (
    status: import("../../types/models").TaskStatus,
    selectedRows: TaskOccurrenceRow[],
    current: TaskOccurrenceCollections,
    setters: TaskOccurrenceCollectionSetters,
    closeMenu: () => void
  ) => {
    if (selectedRows.length === 0) return;
    const mutationVersion = ++occurrenceMutationSequenceRef.current;
    selectedRows.forEach((row) => occurrenceMutationVersionsRef.current.set(row.key, mutationVersion));
    try {
      await runOptimisticOccurrenceMutation({
        current,
        selectedRows,
        status,
        setters,
        mutate: () => Promise.all(
          selectedRows.map((row) => tasksApi.completeOccurrence(
            row.taskId,
            row.occurrenceDate ?? row.date,
            status
          ))
        ),
        shouldRollback: (key) => occurrenceMutationVersionsRef.current.get(key) === mutationVersion
      });
      const shouldReconcile = selectedRows.every(
        (row) => occurrenceMutationVersionsRef.current.get(row.key) === mutationVersion
      );
      selectedRows.forEach((row) => {
        if (occurrenceMutationVersionsRef.current.get(row.key) === mutationVersion) {
          occurrenceMutationVersionsRef.current.delete(row.key);
        }
      });
      closeMenu();
      if (shouldReconcile) {
        setTimeout(() => { void refreshAfterOccurrenceMutation(); }, 800);
      }
    } catch (error) {
      const shouldReconcile = selectedRows.every(
        (row) => occurrenceMutationVersionsRef.current.get(row.key) === mutationVersion
      );
      selectedRows.forEach((row) => {
        if (occurrenceMutationVersionsRef.current.get(row.key) === mutationVersion) {
          occurrenceMutationVersionsRef.current.delete(row.key);
        }
      });
      if (shouldReconcile) {
        setTimeout(() => { void refreshAfterOccurrenceMutation(); }, 800);
      }
      reportMutationError("Failed to update selected occurrences", error);
    }
  };

  const handleSkipSelectedTasks = async (
    selectedRows: TaskOccurrenceRow[],
    closeMenu: () => void
  ) => {
    if (selectedRows.length === 0) return;
    try {
      await Promise.all(
        selectedRows.map((row) => tasksApi.completeOccurrence(row.taskId, row.occurrenceDate ?? row.date, "skipped"))
      );
      closeMenu();
      await refreshAfterOccurrenceMutation();
    } catch (error) {
      reportMutationError("Failed to skip selected occurrences", error);
    }
  };

  const handleConfirmMoveDate = async (
    selectedRows: TaskOccurrenceRow[],
    moveDateInput: string,
    setOccurrenceRows: React.Dispatch<React.SetStateAction<TaskOccurrenceRow[]>>,
    setTodayRows: React.Dispatch<React.SetStateAction<TaskOccurrenceRow[]>>,
    setInboxUpcomingRows: React.Dispatch<React.SetStateAction<TaskOccurrenceRow[]>>,
    setInboxDoneRows: React.Dispatch<React.SetStateAction<TaskOccurrenceRow[]>>,
    clearSelection: () => void,
    closeMenu: () => void,
    setShowMoveDateInput: React.Dispatch<React.SetStateAction<boolean>>,
    setMoveDateInput: React.Dispatch<React.SetStateAction<string>>
  ) => {
    if (selectedRows.length === 0 || !moveDateInput) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(moveDateInput)) {
      pushErrorNotification("Invalid date format.");
      return;
    }
    try {
      await Promise.all(
        selectedRows.map((row) => tasksApi.moveOccurrence(row.taskId, row.occurrenceDate ?? row.date, moveDateInput))
      );
      const movedKeys = new Set(selectedRows.map((r) => r.key));
      setOccurrenceRows((prev) => prev.filter((r) => !movedKeys.has(r.key)));
      setTodayRows((prev) => prev.filter((r) => !movedKeys.has(r.key)));
      setInboxUpcomingRows((prev) => prev.filter((r) => !movedKeys.has(r.key)));
      setInboxDoneRows((prev) => prev.filter((r) => !movedKeys.has(r.key)));
      clearSelection();
      setShowMoveDateInput(false);
      setMoveDateInput("");
      closeMenu();
      setTimeout(() => { void refreshAfterOccurrenceMutation(); }, 800);
    } catch (error) {
      reportMutationError("Failed to move selected occurrences", error);
    }
  };

  const handleMoveSelectedToProject = async (
    selectedRows: TaskOccurrenceRow[],
    projectId: string,
    closeMenu: () => void,
    resetProjectInput: () => void
  ) => {
    if (selectedRows.length === 0 || !projectId.trim()) return;
    const uniqueTaskIds = Array.from(new Set(selectedRows.map((row) => row.taskId)));
    const project = projectOptions.find((option) => option.projectId === projectId);
    try {
      await Promise.all(
        uniqueTaskIds.map((taskId) =>
          tasksApi.update(taskId, {
            context: projectId,
            contextName: project?.projectName || projectId
          })
        )
      );
      closeMenu();
      resetProjectInput();
      await refreshAfterOccurrenceMutation();
    } catch {
      pushErrorNotification("Failed to move selected tasks to project.");
    }
  };

  const handleDeleteSelectedFromMenu = async (
    selectedRows: TaskOccurrenceRow[],
    setOccurrenceRows: React.Dispatch<React.SetStateAction<TaskOccurrenceRow[]>>,
    setTodayRows: React.Dispatch<React.SetStateAction<TaskOccurrenceRow[]>>,
    setInboxUpcomingRows: React.Dispatch<React.SetStateAction<TaskOccurrenceRow[]>>,
    setInboxDoneRows: React.Dispatch<React.SetStateAction<TaskOccurrenceRow[]>>,
    clearSelection: () => void,
    closeMenu: () => void
  ) => {
    if (selectedRows.length === 0) return;
    const confirmed = window.confirm(
      `Remove ${selectedRows.length} occurrence(s) from schedule?`
    );
    if (!confirmed) return;
    try {
      await Promise.all(
        selectedRows.map((row) => tasksApi.skipOccurrenceException(row.taskId, row.occurrenceDate ?? row.date))
      );
      const removedKeys = new Set(selectedRows.map((r) => r.key));
      setOccurrenceRows((prev) => prev.filter((r) => !removedKeys.has(r.key)));
      setTodayRows((prev) => prev.filter((r) => !removedKeys.has(r.key)));
      setInboxUpcomingRows((prev) => prev.filter((r) => !removedKeys.has(r.key)));
      setInboxDoneRows((prev) => prev.filter((r) => !removedKeys.has(r.key)));
      clearSelection();
      closeMenu();
      setTimeout(() => { void refreshAfterOccurrenceMutation(); }, 800);
    } catch (error) {
      reportMutationError("Failed to remove selected occurrences", error);
    }
  };

  const handleToggleTodayForSelected = async (
    isToday: boolean,
    selectedRows: TaskOccurrenceRow[],
    setTodayRows: React.Dispatch<React.SetStateAction<TaskOccurrenceRow[]>>,
    setTodayMembershipKeys: React.Dispatch<React.SetStateAction<Set<string>>>,
    closeMenu: () => void
  ) => {
    if (selectedRows.length === 0) return;
    const todayKey = toDateKey(startOfDay(today));
    const uniqueRows = Array.from(
      new Map(
        selectedRows.map((r) => [
          rowTodayMembershipKey(r, todayKey),
          {
            taskId: r.taskId,
            occurrenceDate: rowOccurrenceDate(r) || todayKey,
            membershipKey: rowTodayMembershipKey(r, todayKey),
            row: r
          }
        ])
      ).values()
    );
    try {
      if (isToday) {
        const createdItems = await Promise.all(
          uniqueRows.map(({ taskId, occurrenceDate, membershipKey, row }) =>
            tasksApi.addToToday(taskId, todayKey, occurrenceDate)
              .then((scheduleItem) => ({ membershipKey, occurrenceDate, row, scheduleItem }))
          )
        );
        setTodayRows((prev) => {
          const existingKeys = new Set(prev.map((r) => rowTodayMembershipKey(r, todayKey)));
          const toAdd = createdItems
            .filter(({ membershipKey }) => !existingKeys.has(membershipKey))
            .map(({ occurrenceDate: fallbackOccurrenceDate, row, scheduleItem }) => {
              const occurrenceDate = scheduleItem.occurrenceDate || fallbackOccurrenceDate;
              const scheduledDate = scheduleItem.scheduledDate || todayKey;
              return {
                ...row,
                key: taskOccurrenceRowKey({
                  taskId: row.taskId,
                  occurrenceDate,
                  scheduledDate,
                  scheduleId: scheduleItem.id
                }),
                date: scheduledDate,
                occurrenceDate,
                scheduledDate,
                scheduleId: scheduleItem.id,
                startTime: scheduleItem.startTime ?? row.startTime,
                endTime: scheduleItem.endTime ?? row.endTime
              };
            });
          return [...prev, ...toAdd];
        });
        setTodayMembershipKeys((prev) => {
          const next = new Set(prev);
          createdItems.forEach(({ occurrenceDate: fallbackOccurrenceDate, row, scheduleItem }) => {
            const occurrenceDate = scheduleItem.occurrenceDate || fallbackOccurrenceDate;
            const scheduledDate = scheduleItem.scheduledDate || todayKey;
            next.add(occurrenceMembershipKey(row.taskId, occurrenceDate, scheduledDate));
          });
          return next;
        });
      } else {
        await Promise.all(
          uniqueRows.map(({ row, taskId, occurrenceDate }) => {
            const scheduledDate = rowScheduledDate(row);
            if (row.scheduleId != null && scheduledDate === todayKey) {
              return tasksApi.removeScheduleItem(row.scheduleId);
            }
            return tasksApi.removeFromToday(taskId, todayKey, occurrenceDate);
          })
        );
        const removedKeys = new Set(
          uniqueRows.map(({ membershipKey }) => membershipKey)
        );
        setTodayRows((prev) => prev.filter((r) => !removedKeys.has(rowTodayMembershipKey(r, todayKey))));
        setTodayMembershipKeys((prev) => {
          const next = new Set(prev);
          uniqueRows.forEach(({ membershipKey }) => next.delete(membershipKey));
          return next;
        });
      }
      closeMenu();
    } catch (error) {
      reportMutationError("Failed to update Today", error);
    }
  };

  // ── Attachment handlers ────────────────────────────────────────────────────

  const handleAttachFiles = async (files: FileList | File[]) => {
    if (!selectedTaskId) return;
    for (const file of Array.from(files)) {
      try {
        const created = await taskAttachmentsApi.upload(selectedTaskId, file);
        setAttachments((prev) => [...prev, created]);
      } catch {
        /* error notification handled in api layer */
      }
    }
  };

  const handleAttachmentDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingOver(false);
    if (e.dataTransfer.files.length > 0) {
      void handleAttachFiles(e.dataTransfer.files);
    }
  };

  const handleDeleteAttachment = async (attachmentId: string) => {
    if (!selectedTaskId) return;
    try {
      await taskAttachmentsApi.remove(selectedTaskId, attachmentId);
      setAttachments((prev) => prev.filter((a) => a.id !== attachmentId));
    } catch {
      pushErrorNotification("Failed to delete attachment.");
    }
  };

  // ── Subtask handlers ────────────────────────────────────────────────────────

  const handleAddSubtask = async () => {
    if (!selectedTaskId || !selectedOccurrenceDate || !newSubtaskTitle.trim()) return;
    try {
      const created = await taskSubtasksApi.create(
        selectedTaskId,
        selectedOccurrenceDate,
        newSubtaskTitle.trim()
      );
      setSubtasks((prev) => [...prev, created]);
      setNewSubtaskTitle("");
    } catch {
      pushErrorNotification("Failed to add subtask.");
    }
  };

  const handleToggleSubtask = async (subtask: TaskSubtask) => {
    if (!selectedTaskId || !selectedOccurrenceDate) return;
    const next = !subtask.isDone;
    setSubtasks((prev) =>
      prev.map((s) => (s.id === subtask.id ? { ...s, isDone: next } : s))
    );
    try {
      await taskSubtasksApi.update(selectedTaskId, selectedOccurrenceDate, subtask.id, {
        isDone: next
      });
    } catch {
      setSubtasks((prev) =>
        prev.map((s) => (s.id === subtask.id ? { ...s, isDone: subtask.isDone } : s))
      );
      pushErrorNotification("Failed to update subtask.");
    }
  };

  const handleDeleteSubtask = async (subtaskId: string) => {
    if (!selectedTaskId || !selectedOccurrenceDate) return;
    try {
      await taskSubtasksApi.remove(selectedTaskId, selectedOccurrenceDate, subtaskId);
      setSubtasks((prev) => prev.filter((s) => s.id !== subtaskId));
    } catch {
      pushErrorNotification("Failed to delete subtask.");
    }
  };

  // ── Schedule item handlers ─────────────────────────────────────────────────

  const handleSaveScheduleItem = async () => {
    if (!selectedTaskId || !scheduleDraft || !selectedOccurrenceDate) return;
    const { scheduledDate, startTime, endTime, timezone } = scheduleDraft;
    if (!scheduledDate) return;
    try {
      if (scheduleItemId != null) {
        await tasksApi.updateScheduleItem(scheduleItemId, {
          scheduledDate,
          startTime: startTime || null,
          endTime: endTime || null,
          timezone: timezone || null
        });
      } else {
        const result = await tasksApi.addToToday(
          selectedTaskId,
          scheduledDate,
          selectedOccurrenceDate,
          {
            startTime: startTime || undefined,
            endTime: endTime || undefined,
            timezone: timezone || undefined
          }
        );
        setScheduleItemId(result.id);
      }
    } catch {
      pushErrorNotification("Failed to save schedule entry.");
    }
  };

  const handleRemoveScheduleItem = async () => {
    if (!selectedTaskId || !selectedOccurrenceDate || !scheduleDraft) return;
    try {
      if (scheduleItemId != null) {
        await tasksApi.removeScheduleItem(scheduleItemId);
      }
      setScheduleItemId(null);
      setScheduleDraft((prev) =>
        prev ? { ...prev, scheduledDate: selectedOccurrenceDate, startTime: "", endTime: "" } : null
      );
    } catch {
      pushErrorNotification("Failed to remove schedule entry.");
    }
  };

  // ── History ────────────────────────────────────────────────────────────────

  const loadHistory = async () => {
    if (!selectedTaskId || historyLoading) return;
    setHistoryLoading(true);
    try {
      const h = await tasksApi.history(selectedTaskId);
      setHistory(h);
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleHistoryToggle = () => {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (next && history.length === 0) void loadHistory();
  };

  // ── Export / Import ────────────────────────────────────────────────────────

  const handleExport = async () => {
    try {
      const blob = await tasksApi.exportCsv();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "tasks.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      /* API errors routed to notification center */
    }
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    tasksApi
      .importCsv(file)
      .then(() => void onReload())
      .catch(() => {
        /* API errors routed to notification center */
      });
    e.target.value = "";
  };

  return {
    draft, setDraft, isSaving, selectedTask,
    attachments, attachmentsLoading, isDraggingOver, setIsDraggingOver,
    subtasks, subtasksLoading, newSubtaskTitle, setNewSubtaskTitle,
    fileViewer, showAddPanel, setShowAddPanel,
    addAdvancedOpen, setAddAdvancedOpen, addDraft, setAddDraft,
    addContextInput, setAddContextInput,
    scheduleDraft, setScheduleDraft, scheduleItemId, scheduleItemLoading,
    history, historyOpen, historyLoading, advancedOpen, setAdvancedOpen,
    draftRef, attachmentInputRef,
    applyAndSave, saveDetail, clearDetail, openAddPanel,
    handleAddTask, handleDeleteDetail,
    handleToggleDone, handleTogglePin,
    handleToggleOccurrenceDone, handleMarkSelectedOccurrences,
    handleSkipSelectedTasks, handleConfirmMoveDate, handleMoveSelectedToProject,
    handleDeleteSelectedFromMenu, handleToggleTodayForSelected,
    handleAttachFiles, handleAttachmentDrop, handleDeleteAttachment,
    handleOpenFileViewer, closeFileViewer,
    handleAddSubtask, handleToggleSubtask, handleDeleteSubtask,
    handleSaveScheduleItem, handleRemoveScheduleItem,
    handleHistoryToggle, handleExport, handleImport,
    loadAttachments, loadSubtasks, loadScheduleItem,
    updateProjectOptions
  };
}
