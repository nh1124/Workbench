import { describe, expect, it } from "vitest";
import {
  runOptimisticOccurrenceMutation,
  type TaskOccurrenceCollections,
  type TaskOccurrenceCollectionSetters
} from "../lib/taskOccurrenceStatusMutation";
import type { TaskOccurrenceRow } from "../types";

function row(status: TaskOccurrenceRow["status"], taskId = "task-1"): TaskOccurrenceRow {
  return {
    key: `inbox::${taskId}`,
    taskId,
    date: "2026-07-13",
    occurrenceDate: "2026-07-13",
    title: "Inbox task",
    context: "default",
    status
  };
}

function stateHarness(initial: TaskOccurrenceCollections) {
  let state = initial;
  const setter = (key: keyof TaskOccurrenceCollections) => (
    update: React.SetStateAction<TaskOccurrenceRow[]>
  ) => {
    const previous = state[key];
    state = {
      ...state,
      [key]: typeof update === "function" ? update(previous) : update
    };
  };
  const setters: TaskOccurrenceCollectionSetters = {
    setTodayRows: setter("todayRows"),
    setOccurrenceRows: setter("occurrenceRows"),
    setInboxUpcomingRows: setter("inboxUpcomingRows"),
    setInboxDoneRows: setter("inboxDoneRows")
  };
  return { getState: () => state, setters };
}

describe("runOptimisticOccurrenceMutation", () => {
  it("moves an Inbox row to Completed before the API resolves", async () => {
    const inboxRow = row("todo");
    const initial: TaskOccurrenceCollections = {
      todayRows: [],
      occurrenceRows: [],
      inboxUpcomingRows: [inboxRow],
      inboxDoneRows: []
    };
    const harness = stateHarness(initial);
    let resolveRequest!: () => void;
    const request = new Promise<void>((resolve) => { resolveRequest = resolve; });

    const pending = runOptimisticOccurrenceMutation({
      current: initial,
      selectedRows: [inboxRow],
      status: "done",
      setters: harness.setters,
      mutate: () => request
    });

    expect(harness.getState().inboxUpcomingRows).toEqual([]);
    expect(harness.getState().inboxDoneRows).toEqual([{ ...inboxRow, status: "done" }]);

    resolveRequest();
    await pending;
  });

  it("restores the Inbox arrays when the API fails", async () => {
    const inboxRow = row("todo");
    const initial: TaskOccurrenceCollections = {
      todayRows: [],
      occurrenceRows: [],
      inboxUpcomingRows: [inboxRow],
      inboxDoneRows: []
    };
    const harness = stateHarness(initial);
    let rejectRequest!: (error: Error) => void;
    const request = new Promise<void>((_resolve, reject) => { rejectRequest = reject; });

    const pending = runOptimisticOccurrenceMutation({
      current: initial,
      selectedRows: [inboxRow],
      status: "done",
      setters: harness.setters,
      mutate: () => request
    });
    expect(harness.getState().inboxDoneRows[0]?.status).toBe("done");

    rejectRequest(new Error("offline"));
    await expect(pending).rejects.toThrow("offline");
    expect(harness.getState()).toEqual(initial);
  });

  it("preserves overlapping optimistic updates when the second snapshot is stale", async () => {
    const firstRow = row("todo", "task-1");
    const secondRow = row("todo", "task-2");
    const initial: TaskOccurrenceCollections = {
      todayRows: [firstRow, secondRow],
      occurrenceRows: [firstRow, secondRow],
      inboxUpcomingRows: [firstRow, secondRow],
      inboxDoneRows: []
    };
    const harness = stateHarness(initial);
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    const firstRequest = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const secondRequest = new Promise<void>((resolve) => { resolveSecond = resolve; });

    const firstPending = runOptimisticOccurrenceMutation({
      current: initial,
      selectedRows: [firstRow],
      status: "done",
      setters: harness.setters,
      mutate: () => firstRequest
    });
    const secondPending = runOptimisticOccurrenceMutation({
      current: initial,
      selectedRows: [secondRow],
      status: "done",
      setters: harness.setters,
      mutate: () => secondRequest
    });

    expect(harness.getState().todayRows.map((item) => item.status)).toEqual(["done", "done"]);
    expect(harness.getState().occurrenceRows.map((item) => item.status)).toEqual(["done", "done"]);
    expect(harness.getState().inboxUpcomingRows).toEqual([]);
    expect(harness.getState().inboxDoneRows.map((item) => item.taskId)).toEqual(["task-1", "task-2"]);

    resolveFirst();
    resolveSecond();
    await Promise.all([firstPending, secondPending]);
  });
});
