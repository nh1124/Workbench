// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../types/models";
import type {
  TaskOccurrenceCollections,
  TaskOccurrenceCollectionSetters
} from "../lib/taskOccurrenceStatusMutation";
import { taskToDraft, type TaskOccurrenceRow } from "../types";

const apiMocks = vi.hoisted(() => ({
  completeOccurrence: vi.fn(),
  update: vi.fn(),
  removeScheduleItem: vi.fn(),
  removeFromToday: vi.fn(),
  skipOccurrenceException: vi.fn()
}));

vi.mock("../../lib/api", () => ({
  formatApiErrorMessage: (action: string) => action,
  projectsApi: { create: vi.fn() },
  taskAttachmentsApi: {},
  taskSubtasksApi: {},
  tasksApi: apiMocks
}));

vi.mock("../../lib/notificationService", () => ({
  pushErrorNotification: vi.fn()
}));

import { useTaskMutations } from "../hooks/useTaskMutations";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Task",
    notes: "",
    context: "project-1",
    status: "todo",
    isLocked: false,
    baseLoadScore: 5,
    recurrence: "ONCE",
    active: true,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    ...overrides
  };
}

function makeDateLessRow(): TaskOccurrenceRow {
  return {
    key: "task:task-1",
    taskId: "task-1",
    date: "",
    occurrenceDate: "",
    title: "Task",
    context: "project-1",
    status: "todo"
  };
}

function occurrenceCollections(row: TaskOccurrenceRow): {
  current: TaskOccurrenceCollections;
  setters: TaskOccurrenceCollectionSetters;
} {
  return {
    current: {
      todayRows: [],
      occurrenceRows: [],
      inboxUpcomingRows: [row],
      inboxDoneRows: []
    },
    setters: {
      setTodayRows: vi.fn(),
      setOccurrenceRows: vi.fn(),
      setInboxUpcomingRows: vi.fn(),
      setInboxDoneRows: vi.fn()
    }
  };
}

function renderMutations(
  task: Task,
  todayScheduleOccurrenceStatuses: Map<string, Task["status"]> = new Map()
) {
  const onReload = vi.fn().mockResolvedValue(undefined);
  const result = renderHook(() => useTaskMutations(
    {
      selectedTaskId: task.id,
      selectedOccurrenceDate: null,
      onSelectTask: vi.fn(),
      onReload,
      onReloadOccurrences: vi.fn().mockResolvedValue(undefined),
      quickFilter: "inbox",
      projectOptions: [],
      contextFilter: "",
      today: new Date(2026, 6, 13),
      todayScheduleOccurrenceStatuses
    },
    [task],
    vi.fn(),
    vi.fn()
  ));
  return { ...result, onReload };
}

describe("useTaskMutations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates an empty-string occurrence date to the task-level toggle", async () => {
    const task = makeTask();
    apiMocks.update.mockResolvedValue({ ...task, status: "done" });
    const { result } = renderMutations(task);
    const row = makeDateLessRow();
    const { current, setters } = occurrenceCollections(row);

    await act(async () => {
      await result.current.handleToggleOccurrenceDone(row, current, setters);
    });

    expect(apiMocks.completeOccurrence).not.toHaveBeenCalled();
    expect(apiMocks.update).toHaveBeenCalledWith("task-1", { status: "done" });
  });

  it("excludes status from detail updates when task status is unchanged", async () => {
    const task = makeTask();
    apiMocks.update.mockResolvedValue({ ...task, baseLoadScore: 7 });
    const { result } = renderMutations(task);

    await act(async () => {
      result.current.loadTaskDetail(task);
      await result.current.saveDetail({ ...taskToDraft(task), baseLoadScore: 7 });
    });

    const payload = apiMocks.update.mock.calls[0]?.[1];
    expect(payload).toMatchObject({ baseLoadScore: 7 });
    expect(payload).not.toHaveProperty("status");
  });

  it("includes status in detail updates when the user changes task status", async () => {
    const task = makeTask();
    apiMocks.update.mockResolvedValue({ ...task, status: "done" });
    const { result } = renderMutations(task);

    await act(async () => {
      result.current.loadTaskDetail(task);
      await result.current.saveDetail({ ...taskToDraft(task), status: "done" });
    });

    expect(apiMocks.update.mock.calls[0]?.[1]).toMatchObject({ status: "done" });
  });

  it("removes explicit Today membership and skips a rule-due unfinished occurrence", async () => {
    const task = makeTask({ recurrence: "WEEKLY" });
    const occurrenceKey = "occurrence:task-1:2026-07-13:2026-07-13";
    const { result } = renderMutations(task, new Map([[occurrenceKey, "todo"]]));
    const row: TaskOccurrenceRow = {
      key: "schedule:42",
      scheduleId: 42,
      taskId: task.id,
      date: "2026-07-13",
      occurrenceDate: "2026-07-13",
      scheduledDate: "2026-07-13",
      title: task.title,
      context: task.context,
      status: "todo"
    };

    await act(async () => {
      await result.current.handleToggleTodayForSelected(false, [row], vi.fn(), vi.fn(), vi.fn());
    });

    expect(apiMocks.removeScheduleItem).toHaveBeenCalledWith(42);
    expect(apiMocks.skipOccurrenceException).toHaveBeenCalledWith("task-1", "2026-07-13");
    expect(apiMocks.removeScheduleItem.mock.invocationCallOrder[0])
      .toBeLessThan(apiMocks.skipOccurrenceException.mock.invocationCallOrder[0]);
  });

  it("removes explicit Today membership without skipping when the occurrence is not rule-due", async () => {
    const task = makeTask();
    const { result } = renderMutations(task);
    const row: TaskOccurrenceRow = {
      key: "schedule:43",
      scheduleId: 43,
      taskId: task.id,
      date: "2026-07-13",
      occurrenceDate: "2026-07-13",
      scheduledDate: "2026-07-13",
      title: task.title,
      context: task.context,
      status: "todo"
    };

    await act(async () => {
      await result.current.handleToggleTodayForSelected(false, [row], vi.fn(), vi.fn(), vi.fn());
    });

    expect(apiMocks.removeScheduleItem).toHaveBeenCalledWith(43);
    expect(apiMocks.skipOccurrenceException).not.toHaveBeenCalled();
  });

  it("does not skip a done explicit Today row even when its occurrence is rule-due", async () => {
    const task = makeTask({ status: "done", recurrence: "WEEKLY" });
    const occurrenceKey = "occurrence:task-1:2026-07-13:2026-07-13";
    const { result } = renderMutations(task, new Map([[occurrenceKey, "todo"]]));
    const row: TaskOccurrenceRow = {
      key: "schedule:44",
      scheduleId: 44,
      taskId: task.id,
      date: "2026-07-13",
      occurrenceDate: "2026-07-13",
      scheduledDate: "2026-07-13",
      title: task.title,
      context: task.context,
      status: "done"
    };

    await act(async () => {
      await result.current.handleToggleTodayForSelected(false, [row], vi.fn(), vi.fn(), vi.fn());
    });

    expect(apiMocks.removeScheduleItem).toHaveBeenCalledWith(44);
    expect(apiMocks.skipOccurrenceException).not.toHaveBeenCalled();
  });
});
