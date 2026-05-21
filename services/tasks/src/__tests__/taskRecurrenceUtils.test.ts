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
});
