/**
 * Unit tests for buildInboxRows (src/lib/inboxBuilder.ts)
 *
 * These tests guard the Inbox spec against regressions.
 * If any test fails after a code change, the Inbox spec has been broken.
 *
 * Inbox spec (DO NOT change without updating these tests):
 *   Source  : taskList from DB, keyed on dueDate  ← NOT the LBS schedule API
 *   Upcoming: all incomplete tasks, sorted by dueDate ASC; no-dueDate rows last
 *   Done    : all completed tasks, sorted by dueDate DESC; no-dueDate rows last
 */

import { describe, it, expect } from "vitest";
import { buildInboxRows } from "../inboxBuilder";
import type { Task } from "../../types/models";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: "Test task",
    notes: "",
    context: "default",
    status: "todo",
    isLocked: false,
    baseLoadScore: 5,
    recurrence: "ONCE",
    active: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

// ─── 1. Routing: done vs upcoming ─────────────────────────────────────────────

describe("buildInboxRows — routing", () => {
  it("routes done tasks to doneRows, not upcomingRows", () => {
    const tasks = [makeTask({ id: "a", status: "done", dueDate: "2026-03-01" })];
    const { upcomingRows, doneRows } = buildInboxRows(tasks);
    expect(doneRows).toHaveLength(1);
    expect(upcomingRows).toHaveLength(0);
    expect(doneRows[0].taskId).toBe("a");
  });

  it("routes todo tasks to upcomingRows, not doneRows", () => {
    const tasks = [makeTask({ id: "b", status: "todo", dueDate: "2026-12-31" })];
    const { upcomingRows, doneRows } = buildInboxRows(tasks);
    expect(upcomingRows).toHaveLength(1);
    expect(doneRows).toHaveLength(0);
    expect(upcomingRows[0].taskId).toBe("b");
  });

  it("routes skipped tasks to upcomingRows (not done)", () => {
    const tasks = [makeTask({ id: "c", status: "skipped", dueDate: "2026-03-01" })];
    const { upcomingRows, doneRows } = buildInboxRows(tasks);
    expect(upcomingRows).toHaveLength(1);
    expect(doneRows).toHaveLength(0);
  });
});

// ─── 2. DueDate is used as the display date ───────────────────────────────────

describe("buildInboxRows — dueDate as date field", () => {
  it("sets row.date to the task dueDate", () => {
    const tasks = [makeTask({ id: "d", dueDate: "2026-05-10" })];
    const { upcomingRows } = buildInboxRows(tasks);
    expect(upcomingRows[0].date).toBe("2026-05-10");
  });

  it("sets row.date to empty string when task has no dueDate", () => {
    const tasks = [makeTask({ id: "e" })];  // no dueDate
    const { upcomingRows } = buildInboxRows(tasks);
    expect(upcomingRows[0].date).toBe("");
  });
});

// ─── 3. NOT driven by LBS schedule ───────────────────────────────────────────

describe("buildInboxRows — LBS independence", () => {
  it("displays a task even when it has no LBS occurrence (ONCE, no dueDate)", () => {
    // This was the regression in commit 84d408e: tasks without an LBS occurrence
    // were invisible in the Inbox. buildInboxRows must not require LBS data.
    const tasks = [makeTask({ id: "f", recurrence: "ONCE" })];  // no dueDate → no LBS occurrence
    const { upcomingRows } = buildInboxRows(tasks);
    expect(upcomingRows).toHaveLength(1);
    expect(upcomingRows[0].taskId).toBe("f");
  });

  it("displays a recurring task regardless of whether LBS scheduled it today", () => {
    const tasks = [makeTask({ id: "g", recurrence: "WEEKLY", mon: true })];
    const { upcomingRows } = buildInboxRows(tasks);
    expect(upcomingRows).toHaveLength(1);
  });
});

// ─── 4. Upcoming sort order ───────────────────────────────────────────────────

describe("buildInboxRows — upcoming sort order", () => {
  it("sorts overdue tasks before future tasks (ASC by dueDate)", () => {
    const tasks = [
      makeTask({ id: "future", dueDate: "2099-12-31" }),
      makeTask({ id: "overdue", dueDate: "2020-01-01" })
    ];
    const { upcomingRows } = buildInboxRows(tasks);
    expect(upcomingRows[0].taskId).toBe("overdue");
    expect(upcomingRows[1].taskId).toBe("future");
  });

  it("places no-dueDate tasks after all dated tasks", () => {
    const tasks = [
      makeTask({ id: "no-date" }),  // no dueDate
      makeTask({ id: "dated", dueDate: "2026-03-29" })
    ];
    const { upcomingRows } = buildInboxRows(tasks);
    expect(upcomingRows[0].taskId).toBe("dated");
    expect(upcomingRows[1].taskId).toBe("no-date");
  });

  it("sorts multiple future tasks nearest-first", () => {
    const tasks = [
      makeTask({ id: "far", dueDate: "2026-12-01" }),
      makeTask({ id: "near", dueDate: "2026-04-01" })
    ];
    const { upcomingRows } = buildInboxRows(tasks);
    expect(upcomingRows[0].taskId).toBe("near");
    expect(upcomingRows[1].taskId).toBe("far");
  });
});

// ─── 5. Done sort order ───────────────────────────────────────────────────────

describe("buildInboxRows — done sort order", () => {
  it("sorts done tasks newest dueDate first (DESC)", () => {
    const tasks = [
      makeTask({ id: "older", status: "done", dueDate: "2026-01-01" }),
      makeTask({ id: "newer", status: "done", dueDate: "2026-03-01" })
    ];
    const { doneRows } = buildInboxRows(tasks);
    expect(doneRows[0].taskId).toBe("newer");
    expect(doneRows[1].taskId).toBe("older");
  });

  it("places done tasks with no dueDate at the end", () => {
    const tasks = [
      makeTask({ id: "no-date-done", status: "done" }),
      makeTask({ id: "dated-done", status: "done", dueDate: "2026-02-15" })
    ];
    const { doneRows } = buildInboxRows(tasks);
    expect(doneRows[0].taskId).toBe("dated-done");
    expect(doneRows[1].taskId).toBe("no-date-done");
  });
});

// ─── 6. Row fields ────────────────────────────────────────────────────────────

describe("buildInboxRows — row fields", () => {
  it("uses contextName over context when available", () => {
    const tasks = [makeTask({ id: "h", context: "ctx-id", contextName: "My Project" })];
    const { upcomingRows } = buildInboxRows(tasks);
    expect(upcomingRows[0].context).toBe("My Project");
  });

  it("falls back to context when contextName is absent", () => {
    const tasks = [makeTask({ id: "i", context: "ctx-id" })];
    const { upcomingRows } = buildInboxRows(tasks);
    expect(upcomingRows[0].context).toBe("ctx-id");
  });

  it("generates stable key as inbox::<taskId>", () => {
    const tasks = [makeTask({ id: "j" })];
    const { upcomingRows } = buildInboxRows(tasks);
    expect(upcomingRows[0].key).toBe("inbox::j");
  });

  it("handles empty task list", () => {
    const { upcomingRows, doneRows } = buildInboxRows([]);
    expect(upcomingRows).toHaveLength(0);
    expect(doneRows).toHaveLength(0);
  });
});
