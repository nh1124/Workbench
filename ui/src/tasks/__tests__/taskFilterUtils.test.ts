/**
 * Unit tests for src/tasks/lib/taskFilterUtils.ts
 *
 * Guards:
 *   - filterTasksByMode: calendar/list mode filter rules
 *   - sortTasks: load | due | project sort correctness
 *   - filterAndSortTasks: combined pipeline (smoke test)
 *   - computeTaskCounters: badge counter values
 *
 * Safety: pure functions → zero side effects → no mocks needed.
 */

import { describe, expect, it } from "vitest";
import {
  computeTaskCounters,
  filterAndSortTasks,
  filterTasksByMode,
  sortTasks,
} from "../lib/taskFilterUtils";
import type { Task } from "../../types/models";

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
      myDayFlaggedIds: new Set(),
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
      myDayFlaggedIds: new Set(),
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
      myDayFlaggedIds: new Set(),
      todayTaskIds: new Set(),
      today: TODAY,
    });
    expect(result).toHaveLength(3);
  });

  it("list/today uses myDayFlaggedIds when non-empty", () => {
    const result = filterTasksByMode(tasks, {
      sidebarMode: "list",
      calendarStatusFilter: "all",
      quickFilter: "today",
      myDayFlaggedIds: new Set(["a"]),
      todayTaskIds: new Set(["b"]),
      today: TODAY,
    });
    expect(result.map((t) => t.id)).toEqual(["a"]);
  });

  it("list/today falls back to todayTaskIds when myDay empty", () => {
    const result = filterTasksByMode(tasks, {
      sidebarMode: "list",
      calendarStatusFilter: "all",
      quickFilter: "today",
      myDayFlaggedIds: new Set(),
      todayTaskIds: new Set(["b", "c"]),
      today: TODAY,
    });
    expect(result.map((t) => t.id)).toEqual(["b", "c"]);
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
      myDayFlaggedIds: new Set(),
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
      myDayFlaggedIds: new Set(),
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
      myDayFlaggedIds: new Set(),
      todayTaskIds: new Set(),
      today: TODAY,
      sortMode: "load",
    });
    expect(result.map((t) => t.id)).toEqual(["pinned-lo", "pinned-hi"]);
  });
});

// ─── computeTaskCounters ──────────────────────────────────────────────────────

describe("computeTaskCounters", () => {
  it("returns myDayFlaggedIds.size when non-empty as today count", () => {
    const counters = computeTaskCounters([], {
      myDayFlaggedIds: new Set(["a", "b", "c"]),
      todayTaskIds: new Set(["x"]),
      today: TODAY,
      plannedCount: 4,
      overdueCount: 2,
      inboxUpcomingCount: 7,
    });
    expect(counters.today).toBe(3);
  });

  it("returns todayTaskIds.size when myDay is empty", () => {
    const counters = computeTaskCounters([], {
      myDayFlaggedIds: new Set(),
      todayTaskIds: new Set(["x", "y"]),
      today: TODAY,
      plannedCount: 0,
      overdueCount: 0,
      inboxUpcomingCount: 0,
    });
    expect(counters.today).toBe(2);
  });

  it("counts pinned tasks as myday", () => {
    const tasks = [
      makeTask({ id: "a", isPinned: true }),
      makeTask({ id: "b", isPinned: false }),
      makeTask({ id: "c", isPinned: true }),
    ];
    const counters = computeTaskCounters(tasks, {
      myDayFlaggedIds: new Set(),
      todayTaskIds: new Set(),
      today: TODAY,
      plannedCount: 1,
      overdueCount: 5,
      inboxUpcomingCount: 3,
    });
    expect(counters.myday).toBe(2);
    expect(counters.planned).toBe(1);
    expect(counters.overdue).toBe(5);
    expect(counters.inbox).toBe(3);
  });
});
