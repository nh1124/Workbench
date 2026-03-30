/**
 * Unit tests for src/tasks/lib/taskCalendarUtils.ts
 *
 * Guards:
 *   - buildTasksByDate: map key format, recurrence filtering, status override
 *   - filterScheduleItems: status filter and context filter correctness
 *
 * Safety: pure functions → no mocks needed.
 */

import { describe, expect, it } from "vitest";
import { buildTasksByDate, filterScheduleItems } from "../lib/taskCalendarUtils";
import type { ScheduleCalendarItem, Task, TaskStatus } from "../../types/models";

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
    dueDate: "2026-03-30",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeScheduleItem(
  overrides: Partial<ScheduleCalendarItem> & { taskId: string }
): ScheduleCalendarItem {
  return {
    scheduleId: 1,
    title: "Item",
    context: "inbox",
    status: "todo",
    occurrenceDate: "2026-03-30",
    scheduledDate: "2026-03-30",
    ...overrides,
  };
}

// ─── buildTasksByDate ─────────────────────────────────────────────────────────

describe("buildTasksByDate", () => {
  it("produces map key in year-month-day format (0-indexed month)", () => {
    const date = new Date("2026-03-30"); // March → getMonth() === 2
    const task = makeTask({ id: "t1" });
    const result = buildTasksByDate([task], [date], new Map());
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    expect(result.has(key)).toBe(true);
  });

  it("includes task on its due date (ONCE recurrence)", () => {
    const date = new Date("2026-03-30");
    const task = makeTask({ id: "t1", dueDate: "2026-03-30" });
    const result = buildTasksByDate([task], [date], new Map());
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    expect(result.get(key)).toHaveLength(1);
    expect(result.get(key)![0].id).toBe("t1");
  });

  it("excludes task on a different date", () => {
    const date = new Date("2026-03-31");
    const task = makeTask({ id: "t1", dueDate: "2026-03-30" });
    const result = buildTasksByDate([task], [date], new Map());
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    expect(result.get(key)).toHaveLength(0);
  });

  it("applies calendarStatusMap override when present", () => {
    const date = new Date("2026-03-30");
    const dateKey = "2026-03-30";
    const task = makeTask({ id: "t1", status: "todo" });
    const calendarStatusMap = new Map<string, Map<string, TaskStatus>>([
      [dateKey, new Map([["t1", "done"]])],
    ]);
    const result = buildTasksByDate([task], [date], calendarStatusMap);
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    expect(result.get(key)![0].status).toBe("done");
  });

  it("leaves task status unchanged when no override for that task", () => {
    const date = new Date("2026-03-30");
    const dateKey = "2026-03-30";
    const task = makeTask({ id: "t1", status: "todo" });
    const calendarStatusMap = new Map<string, Map<string, TaskStatus>>([
      [dateKey, new Map([["other-task", "done"]])],
    ]);
    const result = buildTasksByDate([task], [date], calendarStatusMap);
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    expect(result.get(key)![0].status).toBe("todo");
  });
});

// ─── filterScheduleItems ──────────────────────────────────────────────────────

describe("filterScheduleItems", () => {
  const items = new Map<string, ScheduleCalendarItem[]>([
    ["2026-03-30", [
      makeScheduleItem({ taskId: "t1", status: "todo", context: "proj-a" }),
      makeScheduleItem({ taskId: "t2", status: "done", context: "proj-a" }),
      makeScheduleItem({ taskId: "t3", status: "skipped", context: "proj-b" }),
    ]],
    ["2026-03-31", [
      makeScheduleItem({ taskId: "t4", status: "todo", context: "proj-b" }),
    ]],
  ]);

  it("returns same reference when no filters active", () => {
    const result = filterScheduleItems(items, { calendarStatusFilter: "", contextFilter: "" });
    expect(result).toBe(items);
  });

  it("'open' filter excludes done and skipped items", () => {
    const result = filterScheduleItems(items, { calendarStatusFilter: "open", contextFilter: "" });
    const day30 = result.get("2026-03-30")!;
    expect(day30.map((i) => i.taskId)).toEqual(["t1"]);
  });

  it("'done' filter keeps only done items", () => {
    const result = filterScheduleItems(items, { calendarStatusFilter: "done", contextFilter: "" });
    const day30 = result.get("2026-03-30")!;
    expect(day30.map((i) => i.taskId)).toEqual(["t2"]);
  });

  it("contextFilter keeps only matching context", () => {
    const result = filterScheduleItems(items, { calendarStatusFilter: "", contextFilter: "proj-b" });
    const day30 = result.get("2026-03-30")!;
    expect(day30.map((i) => i.taskId)).toEqual(["t3"]);
    const day31 = result.get("2026-03-31")!;
    expect(day31.map((i) => i.taskId)).toEqual(["t4"]);
  });

  it("combined: open + context", () => {
    const result = filterScheduleItems(items, { calendarStatusFilter: "open", contextFilter: "proj-b" });
    // proj-b tasks: t3 (skipped) and t4 (todo); open excludes skipped
    expect(result.get("2026-03-30")).toHaveLength(0);
    expect(result.get("2026-03-31")!.map((i) => i.taskId)).toEqual(["t4"]);
  });
});
