/**
 * Unit tests for src/tasks/lib/taskOccurrenceDisplayUtils.ts
 *
 * Guards:
 *   - sortOccurrenceRows: done-last + startTime order
 *   - groupOccurrencesByProject: correct grouping, contextName resolution
 *
 * Safety: pure functions → no mocks needed.
 */

import { describe, expect, it } from "vitest";
import {
  groupOccurrencesByProject,
  sortOccurrenceRows,
} from "../lib/taskOccurrenceDisplayUtils";
import type { Task } from "../../types/models";
import type { TaskOccurrenceRow } from "../types";

// ─── helpers ──────────────────────────────────────────────────────────────────

const NOW = "2026-03-30T00:00:00.000Z";

function makeRow(overrides: Partial<TaskOccurrenceRow> & { key: string; taskId: string }): TaskOccurrenceRow {
  return {
    date: "2026-03-30",
    title: "Row",
    context: "inbox",
    status: "todo",
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: "Task",
    notes: "",
    context: "inbox",
    status: "todo",
    isLocked: false,
    baseLoadScore: 5,
    recurrence: "ONCE",
    active: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ─── sortOccurrenceRows ───────────────────────────────────────────────────────

describe("sortOccurrenceRows", () => {
  it("puts done rows after todo rows", () => {
    const rows = [
      makeRow({ key: "d::t1", taskId: "t1", status: "done" }),
      makeRow({ key: "d::t2", taskId: "t2", status: "todo" }),
    ];
    const sorted = sortOccurrenceRows(rows);
    expect(sorted[0].status).toBe("todo");
    expect(sorted[1].status).toBe("done");
  });

  it("within same done-group, sorts by startTime ascending (no-startTime treated as empty string → sorts first)", () => {
    const rows = [
      makeRow({ key: "d::late", taskId: "late", startTime: "14:00" }),
      makeRow({ key: "d::early", taskId: "early", startTime: "08:00" }),
      makeRow({ key: "d::none", taskId: "none" }), // no startTime → "" → sorts before any time string
    ];
    const sorted = sortOccurrenceRows(rows);
    const ids = sorted.map((r) => r.taskId);
    // "" < "08:00" < "14:00", so no-startTime row comes first
    expect(ids).toEqual(["none", "early", "late"]);
  });

  it("done + startTime never jumps before todo + no startTime", () => {
    const rows = [
      makeRow({ key: "d::done-early", taskId: "done-early", status: "done", startTime: "06:00" }),
      makeRow({ key: "d::todo-late", taskId: "todo-late", startTime: "23:00" }),
    ];
    const sorted = sortOccurrenceRows(rows);
    expect(sorted[0].taskId).toBe("todo-late");
    expect(sorted[1].taskId).toBe("done-early");
  });

  it("does not mutate the input array", () => {
    const rows = [
      makeRow({ key: "d::b", taskId: "b", startTime: "12:00" }),
      makeRow({ key: "d::a", taskId: "a", startTime: "08:00" }),
    ];
    const originalOrder = rows.map((r) => r.taskId);
    sortOccurrenceRows(rows);
    expect(rows.map((r) => r.taskId)).toEqual(originalOrder);
  });
});

// ─── groupOccurrencesByProject ────────────────────────────────────────────────

describe("groupOccurrencesByProject", () => {
  it("groups rows by context preserving insertion order", () => {
    const rows = [
      makeRow({ key: "d::t1", taskId: "t1", context: "alpha" }),
      makeRow({ key: "d::t2", taskId: "t2", context: "beta" }),
      makeRow({ key: "d::t3", taskId: "t3", context: "alpha" }),
    ];
    const groups = groupOccurrencesByProject(rows, [], new Map());
    expect(groups.map((g) => g.context)).toEqual(["alpha", "beta"]);
    expect(groups[0].rows).toHaveLength(2);
    expect(groups[1].rows).toHaveLength(1);
  });

  it("resolves contextName from projectNameMap first", () => {
    const rows = [makeRow({ key: "d::t1", taskId: "t1", context: "proj-123" })];
    const map = new Map([["proj-123", "My Project"]]);
    const groups = groupOccurrencesByProject(rows, [], map);
    expect(groups[0].contextName).toBe("My Project");
  });

  it("falls back to task contextName when not in projectNameMap", () => {
    const rows = [makeRow({ key: "d::t1", taskId: "t1", context: "proj-abc" })];
    const tasks = [makeTask({ id: "t1", context: "proj-abc", contextName: "Fallback Name" })];
    const groups = groupOccurrencesByProject(rows, tasks, new Map());
    expect(groups[0].contextName).toBe("Fallback Name");
  });

  it("falls back to context string when nothing else available", () => {
    const rows = [makeRow({ key: "d::t1", taskId: "t1", context: "raw-id" })];
    const groups = groupOccurrencesByProject(rows, [], new Map());
    expect(groups[0].contextName).toBe("raw-id");
  });

  it("returns empty array for empty input", () => {
    const groups = groupOccurrencesByProject([], [], new Map());
    expect(groups).toHaveLength(0);
  });
});
