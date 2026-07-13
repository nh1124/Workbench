import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listDateKeys, taskOccursOnDateKey } from "../taskRecurrenceUtils.js";
import type { Task } from "../types.js";

const baseTask: Task = {
  id: "task-1",
  title: "Task",
  notes: "",
  context: "inbox",
  status: "todo",
  isLocked: false,
  baseLoadScore: 1,
  recurrence: "ONCE",
  active: true,
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z"
};

describe("taskRecurrenceUtils", () => {
  it("lists date keys inclusively", () => {
    assert.deepEqual(listDateKeys("2026-05-20", "2026-05-22"), [
      "2026-05-20",
      "2026-05-21",
      "2026-05-22"
    ]);
  });

  it("matches weekly selected weekdays", () => {
    const task: Task = {
      ...baseTask,
      recurrence: "WEEKLY",
      activeFrom: "2026-05-01",
      mon: true,
      wed: true
    };

    assert.equal(taskOccursOnDateKey(task, "2026-05-20"), true);
    assert.equal(taskOccursOnDateKey(task, "2026-05-21"), false);
  });

  it("uses anchorDate for every-n-days recurrence", () => {
    const task: Task = {
      ...baseTask,
      recurrence: "EVERY_N_DAYS",
      activeFrom: "2026-05-01",
      anchorDate: "2026-05-02",
      intervalDays: 3
    };

    assert.equal(taskOccursOnDateKey(task, "2026-05-05"), true);
    assert.equal(taskOccursOnDateKey(task, "2026-05-06"), false);
  });

  it("matches monthly nth weekday using UI weekday indexes", () => {
    const task: Task = {
      ...baseTask,
      recurrence: "MONTHLY_NTH_WEEKDAY",
      activeFrom: "2026-05-01",
      nthInMonth: 1,
      weekdayMon1: 0
    };

    assert.equal(taskOccursOnDateKey(task, "2026-05-03"), true);
    assert.equal(taskOccursOnDateKey(task, "2026-05-04"), false);
  });

  it("clamps monthly day 31 to the end of February", () => {
    const task: Task = {
      ...baseTask,
      recurrence: "MONTHLY_DAY",
      activeFrom: "2024-01-31",
      monthDay: 31
    };

    assert.equal(taskOccursOnDateKey(task, "2024-02-28"), false);
    assert.equal(taskOccursOnDateKey(task, "2024-02-29"), true);
    assert.equal(taskOccursOnDateKey(task, "2025-02-28"), true);
  });

  it("supports nth=-1 for the last weekday in a month", () => {
    const task: Task = {
      ...baseTask,
      recurrence: "MONTHLY_NTH_WEEKDAY",
      activeFrom: "2026-01-01",
      nthInMonth: -1,
      weekdayMon1: 1
    };

    assert.equal(taskOccursOnDateKey(task, "2026-05-25"), true);
    assert.equal(taskOccursOnDateKey(task, "2026-05-18"), false);
  });

  it("converts UI weekdayMon1=0 to engine Sunday=7", () => {
    const task: Task = {
      ...baseTask,
      recurrence: "MONTHLY_NTH_WEEKDAY",
      activeFrom: "2026-01-01",
      nthInMonth: 2,
      weekdayMon1: 0
    };

    assert.equal(taskOccursOnDateKey(task, "2026-05-10"), true);
    assert.equal(taskOccursOnDateKey(task, "2026-05-11"), false);
  });

  it("preserves WEEKLY activeFrom and dueDate weekday fallbacks", () => {
    const activeFromTask: Task = {
      ...baseTask,
      recurrence: "WEEKLY",
      activeFrom: "2026-05-05"
    };
    const dueDateTask: Task = {
      ...baseTask,
      recurrence: "WEEKLY",
      dueDate: "2026-05-06"
    };

    assert.equal(taskOccursOnDateKey(activeFromTask, "2026-05-12"), true);
    assert.equal(taskOccursOnDateKey(activeFromTask, "2026-05-13"), false);
    assert.equal(taskOccursOnDateKey(dueDateTask, "2026-05-13"), true);
  });

  it("preserves EVERY_N_DAYS anchor fallback order", () => {
    const task: Task = {
      ...baseTask,
      recurrence: "EVERY_N_DAYS",
      activeFrom: "2026-05-02",
      anchorDate: undefined,
      intervalDays: 3
    };
    const createdAtTask: Task = {
      ...task,
      activeFrom: undefined,
      createdAt: "2026-05-03T15:00:00.000Z"
    };

    assert.equal(taskOccursOnDateKey(task, "2026-05-05"), true);
    assert.equal(taskOccursOnDateKey(createdAtTask, "2026-05-06"), true);
  });

  it("keeps ONCE due-date-only and recurring active-period behavior", () => {
    assert.equal(taskOccursOnDateKey({ ...baseTask, active: false, dueDate: "2026-05-10" }, "2026-05-10"), true);

    const recurring: Task = {
      ...baseTask,
      recurrence: "WEEKLY",
      mon: true,
      activeFrom: "2026-05-04",
      activeUntil: "2026-05-11"
    };
    assert.equal(taskOccursOnDateKey({ ...recurring, active: false }, "2026-05-04"), false);
    assert.equal(taskOccursOnDateKey(recurring, "2026-05-04"), true);
    assert.equal(taskOccursOnDateKey(recurring, "2026-05-18"), false);
  });
});
