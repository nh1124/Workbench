import { describe, expect, it } from "vitest";
import { taskOccursOnDate, taskWithinActivePeriod } from "../taskRecurrenceUtils";
import type { Task } from "../../types/models";

function makeTask(overrides: Partial<Task>): Task {
  const now = "2026-03-30T00:00:00.000Z";
  return {
    id: "task-1",
    title: "Sample",
    notes: "",
    context: "inbox",
    status: "todo",
    isLocked: false,
    baseLoadScore: 5,
    recurrence: "ONCE",
    dueDate: "2026-03-30",
    startTime: undefined,
    endTime: undefined,
    timezone: "Asia/Tokyo",
    active: true,
    activeFrom: undefined,
    activeUntil: undefined,
    mon: false,
    tue: false,
    wed: false,
    thu: false,
    fri: false,
    sat: false,
    sun: false,
    intervalDays: 1,
    anchorDate: undefined,
    monthDay: 1,
    nthInMonth: 1,
    weekdayMon1: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe("taskRecurrenceUtils", () => {
  it("matches ONCE only on due date", () => {
    const task = makeTask({ recurrence: "ONCE", dueDate: "2026-03-30" });
    expect(taskOccursOnDate(task, new Date("2026-03-30T12:00:00+09:00"))).toBe(true);
    expect(taskOccursOnDate(task, new Date("2026-03-31T12:00:00+09:00"))).toBe(false);
  });

  it("uses explicit weekday toggles for WEEKLY", () => {
    const task = makeTask({
      recurrence: "WEEKLY",
      mon: true,
      tue: false,
      wed: false,
      thu: false,
      fri: false,
      sat: false,
      sun: false
    });
    expect(taskOccursOnDate(task, new Date("2026-03-30T12:00:00+09:00"))).toBe(true); // Monday
    expect(taskOccursOnDate(task, new Date("2026-03-31T12:00:00+09:00"))).toBe(false); // Tuesday
  });

  it("falls back to activeFrom weekday when WEEKLY has no day toggles", () => {
    const task = makeTask({
      recurrence: "WEEKLY",
      activeFrom: "2026-03-31" // Tuesday
    });
    expect(taskOccursOnDate(task, new Date("2026-04-07T12:00:00+09:00"))).toBe(true); // Tuesday
    expect(taskOccursOnDate(task, new Date("2026-04-08T12:00:00+09:00"))).toBe(false); // Wednesday
  });

  it("matches EVERY_N_DAYS from activeFrom", () => {
    const task = makeTask({
      recurrence: "EVERY_N_DAYS",
      intervalDays: 2,
      activeFrom: "2026-03-30"
    });
    expect(taskOccursOnDate(task, new Date("2026-03-30T00:00:00+09:00"))).toBe(true);
    expect(taskOccursOnDate(task, new Date("2026-03-31T00:00:00+09:00"))).toBe(false);
    expect(taskOccursOnDate(task, new Date("2026-04-01T00:00:00+09:00"))).toBe(true);
  });

  it("respects active period boundaries for recurring tasks", () => {
    const task = makeTask({
      recurrence: "WEEKLY",
      mon: true,
      activeFrom: "2026-03-01",
      activeUntil: "2026-03-31"
    });
    expect(taskWithinActivePeriod(task, new Date("2026-03-15T00:00:00+09:00"))).toBe(true);
    expect(taskWithinActivePeriod(task, new Date("2026-04-01T00:00:00+09:00"))).toBe(false);
  });
});
