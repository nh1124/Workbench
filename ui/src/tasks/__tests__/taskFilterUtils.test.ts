/**
 * Unit tests for src/tasks/lib/taskFilterUtils.ts
 *
 * Guards:
 *   - filterTasksByMode: calendar/list mode filter rules
 *   - sortTasks: load | due | project sort correctness
 *   - filterAndSortTasks: combined pipeline (smoke test)
 *   - searchTasks: global text/project/status search
 *   - computeTaskCounters: badge counter values
 *
 * Safety: pure functions → zero side effects → no mocks needed.
 */

import { describe, expect, it } from "vitest";
import {
  computeTaskCounters,
  filterAndSortTasks,
  filterTasksByMode,
  searchTasks,
  sortTasks,
} from "../lib/taskFilterUtils";
import { occurrenceMembershipKey } from "../lib/taskOccurrenceIdentity";
import type { Task } from "../../types/models";
import type { TaskOccurrenceRow } from "../types";

// ─── helpers ──────────────────────────────────────────────────────────────────

const NOW = "2026-03-30T00:00:00.000Z";

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

function makeOccurrenceRow(
  overrides: Partial<TaskOccurrenceRow> & { taskId: string }
): TaskOccurrenceRow {
  return {
    key: `occurrence:${overrides.taskId}`,
    date: "2026-03-30",
    title: "Task occurrence",
    context: "inbox",
    status: "todo",
    ...overrides,
  };
}

const TODAY = new Date("2026-03-30");

// ─── filterTasksByMode ────────────────────────────────────────────────────────

describe("filterTasksByMode", () => {
  const tasks = [
    makeTask({ id: "a", status: "todo" }),
    makeTask({ id: "b", status: "done" }),
    makeTask({ id: "c", status: "skipped" }),
  ];

  it("calendar/open keeps only todo tasks", () => {
    const result = filterTasksByMode(tasks, {
      sidebarMode: "calendar",
      calendarStatusFilter: "open",
      quickFilter: "today",
      todayMembershipKeys: new Set(),
      todayTaskIds: new Set(),
      today: TODAY,
    });
    expect(result.map((t) => t.id)).toEqual(["a"]);
  });

  it("calendar/done keeps only done tasks", () => {
    const result = filterTasksByMode(tasks, {
      sidebarMode: "calendar",
      calendarStatusFilter: "done",
      quickFilter: "today",
      todayMembershipKeys: new Set(),
      todayTaskIds: new Set(),
      today: TODAY,
    });
    expect(result.map((t) => t.id)).toEqual(["b"]);
  });

  it("calendar/all returns all tasks", () => {
    const result = filterTasksByMode(tasks, {
      sidebarMode: "calendar",
      calendarStatusFilter: "all",
      quickFilter: "today",
      todayMembershipKeys: new Set(),
      todayTaskIds: new Set(),
      today: TODAY,
    });
    expect(result).toHaveLength(3);
  });

  it("list/today uses occurrence-level Today membership keys when non-empty", () => {
    const result = filterTasksByMode(tasks, {
      sidebarMode: "list",
      calendarStatusFilter: "all",
      quickFilter: "today",
      todayMembershipKeys: new Set([occurrenceMembershipKey("a", "2026-03-30", "2026-03-30")]),
      todayTaskIds: new Set(["b"]),
      today: TODAY,
    });
    expect(result.map((t) => t.id)).toEqual(["a"]);
  });

  it("list/today is empty when Today membership is empty", () => {
    const result = filterTasksByMode(tasks, {
      sidebarMode: "list",
      calendarStatusFilter: "all",
      quickFilter: "today",
      todayMembershipKeys: new Set(),
      todayTaskIds: new Set(["b", "c"]),
      today: TODAY,
    });
    expect(result).toEqual([]);
  });

  it("list/myday keeps only pinned tasks", () => {
    const ts = [
      makeTask({ id: "pinned", isPinned: true }),
      makeTask({ id: "unpinned", isPinned: false }),
    ];
    const result = filterTasksByMode(ts, {
      sidebarMode: "list",
      calendarStatusFilter: "all",
      quickFilter: "myday",
      todayMembershipKeys: new Set(),
      todayTaskIds: new Set(),
      today: TODAY,
    });
    expect(result.map((t) => t.id)).toEqual(["pinned"]);
  });

  it("list/planned returns all tasks unfiltered", () => {
    const result = filterTasksByMode(tasks, {
      sidebarMode: "list",
      calendarStatusFilter: "all",
      quickFilter: "planned",
      todayMembershipKeys: new Set(),
      todayTaskIds: new Set(),
      today: TODAY,
    });
    expect(result).toHaveLength(3);
  });
});

// ─── sortTasks ────────────────────────────────────────────────────────────────

describe("sortTasks", () => {
  it("load: done tasks go last, then sort by baseLoadScore desc", () => {
    const tasks = [
      makeTask({ id: "low", baseLoadScore: 2 }),
      makeTask({ id: "high", baseLoadScore: 8 }),
      makeTask({ id: "done", baseLoadScore: 10, status: "done" }),
    ];
    const sorted = sortTasks(tasks, "load");
    expect(sorted.map((t) => t.id)).toEqual(["high", "low", "done"]);
  });

  it("due: done tasks go last, then sort by dueDate asc, then startTime", () => {
    const tasks = [
      makeTask({ id: "later", dueDate: "2026-04-01" }),
      makeTask({ id: "earlier", dueDate: "2026-03-28" }),
      makeTask({ id: "done", dueDate: "2026-01-01", status: "done" }),
      makeTask({ id: "nodueA", startTime: "10:00" }),
      makeTask({ id: "nodueB", startTime: "08:00" }),
    ];
    const sorted = sortTasks(tasks, "due");
    const ids = sorted.map((t) => t.id);
    expect(ids.indexOf("earlier")).toBeLessThan(ids.indexOf("later"));
    expect(ids[ids.length - 1]).toBe("done");
  });

  it("project: done tasks go last, then sort by context asc, then dueDate", () => {
    const tasks = [
      makeTask({ id: "b-later", context: "alpha", dueDate: "2026-04-10" }),
      makeTask({ id: "b-earlier", context: "alpha", dueDate: "2026-04-01" }),
      makeTask({ id: "z", context: "zeta" }),
      makeTask({ id: "done", context: "aaa", status: "done" }),
    ];
    const sorted = sortTasks(tasks, "project");
    const ids = sorted.map((t) => t.id);
    expect(ids.indexOf("b-earlier")).toBeLessThan(ids.indexOf("b-later"));
    expect(ids.indexOf("b-earlier")).toBeLessThan(ids.indexOf("z"));
    expect(ids[ids.length - 1]).toBe("done");
  });

  it("does not mutate input array", () => {
    const tasks = [makeTask({ id: "a", baseLoadScore: 1 }), makeTask({ id: "b", baseLoadScore: 9 })];
    const original = tasks.map((t) => t.id);
    sortTasks(tasks, "load");
    expect(tasks.map((t) => t.id)).toEqual(original);
  });
});

// ─── filterAndSortTasks ───────────────────────────────────────────────────────

describe("filterAndSortTasks", () => {
  it("applies filter then sort in one call", () => {
    const tasks = [
      makeTask({ id: "pinned-hi", isPinned: true, baseLoadScore: 3 }),
      makeTask({ id: "pinned-lo", isPinned: true, baseLoadScore: 9 }),
      makeTask({ id: "unpinned", isPinned: false, baseLoadScore: 10 }),
    ];
    const result = filterAndSortTasks(tasks, {
      sidebarMode: "list",
      calendarStatusFilter: "all",
      quickFilter: "myday",
      todayMembershipKeys: new Set(),
      todayTaskIds: new Set(),
      today: TODAY,
      sortMode: "load",
    });
    expect(result.map((t) => t.id)).toEqual(["pinned-lo", "pinned-hi"]);
  });
});

// ─── searchTasks ──────────────────────────────────────────────────────────────

describe("searchTasks", () => {
  const tasks = [
    makeTask({
      id: "title",
      title: "Prepare Launch Brief",
      context: "marketing",
      contextName: "Marketing",
    }),
    makeTask({
      id: "notes",
      title: "Follow up",
      notes: "Confirm the Zebra contract",
      context: "sales",
      contextName: "Sales",
      status: "done",
    }),
    makeTask({
      id: "context",
      title: "Review queue",
      context: "customer-success",
      contextName: "Client Care",
      status: "skipped",
    }),
    makeTask({
      id: "other",
      title: "Archive receipts",
      context: "finance",
      contextName: "Finance",
    }),
  ];

  it("matches text across title, notes, context, and contextName", () => {
    expect(searchTasks(tasks, { query: "launch" }).map((task) => task.id)).toEqual(["title"]);
    expect(searchTasks(tasks, { query: "zebra" }).map((task) => task.id)).toEqual(["notes"]);
    expect(searchTasks(tasks, { query: "customer-success" }).map((task) => task.id)).toEqual(["context"]);
    expect(searchTasks(tasks, { query: "client care" }).map((task) => task.id)).toEqual(["context"]);
  });

  it("filters by project", () => {
    expect(searchTasks(tasks, { query: "", projectId: "sales" }).map((task) => task.id))
      .toEqual(["notes"]);
  });

  it("filters by status", () => {
    expect(searchTasks(tasks, { query: "", status: "skipped" }).map((task) => task.id))
      .toEqual(["context"]);
  });

  it("combines text, project, and status filters", () => {
    expect(searchTasks(tasks, {
      query: "contract",
      projectId: "sales",
      status: "done",
    }).map((task) => task.id)).toEqual(["notes"]);
    expect(searchTasks(tasks, {
      query: "contract",
      projectId: "marketing",
      status: "done",
    })).toEqual([]);
  });

  it("treats an empty query as no text filter while respecting other filters", () => {
    expect(searchTasks(tasks, {
      query: "   ",
      projectId: "marketing",
      status: "todo",
    }).map((task) => task.id)).toEqual(["title"]);
  });

  it("normalizes query case and surrounding whitespace", () => {
    expect(searchTasks(tasks, { query: "  PREPARE launch  " }).map((task) => task.id))
      .toEqual(["title"]);
  });
});

// ─── computeTaskCounters ──────────────────────────────────────────────────────

describe("computeTaskCounters", () => {
  it("counts non-done Today rows and pinned non-done My Day rows", () => {
    const tasks = [
      makeTask({ id: "generated-pinned", isPinned: true }),
      makeTask({ id: "explicit-done", isPinned: true, status: "done" }),
      makeTask({ id: "outside-today", isPinned: true }),
    ];
    const todayRows = [
      makeOccurrenceRow({
        key: "schedule:1",
        scheduleId: 1,
        taskId: "explicit-open",
      }),
      makeOccurrenceRow({
        key: "occurrence:generated-open",
        taskId: "generated-open",
      }),
      makeOccurrenceRow({
        key: "occurrence:generated-pinned",
        taskId: "generated-pinned",
      }),
      makeOccurrenceRow({
        key: "schedule:2",
        scheduleId: 2,
        taskId: "explicit-done",
        status: "done",
      }),
    ];

    const counters = computeTaskCounters(tasks, {
      todayMembershipKeys: new Set([
        occurrenceMembershipKey("explicit-open", "2026-03-30", "2026-03-30"),
        occurrenceMembershipKey("explicit-done", "2026-03-30", "2026-03-30"),
      ]),
      todayTaskIds: new Set(["explicit-open", "explicit-done"]),
      today: TODAY,
      todayRows,
      pinnedTaskIds: new Set(["generated-pinned", "explicit-done", "outside-today"]),
      plannedCount: 4,
      overdueCount: 2,
      inboxUpcomingCount: 7,
    });

    expect(counters).toEqual({
      today: 3,
      myday: 1,
      planned: 4,
      overdue: 2,
      inbox: 7,
    });
  });

  it("returns zero Today and My Day counts when Today rows are empty", () => {
    const counters = computeTaskCounters([], {
      todayMembershipKeys: new Set(),
      todayTaskIds: new Set(["x", "y"]),
      today: TODAY,
      todayRows: [],
      pinnedTaskIds: new Set(["x", "y"]),
      plannedCount: 0,
      overdueCount: 0,
      inboxUpcomingCount: 0,
    });
    expect(counters.today).toBe(0);
    expect(counters.myday).toBe(0);
  });
});
