import { describe, expect, it } from "vitest";
import {
  occurrenceMembershipKey,
  rowOccurrenceDate,
  rowScheduledDate,
  rowTodayMembershipKey,
  scheduleItemKey,
  taskOccurrenceRowKey
} from "../lib/taskOccurrenceIdentity";
import type { TaskOccurrenceRow } from "../types";

function makeRow(overrides: Partial<TaskOccurrenceRow> = {}): TaskOccurrenceRow {
  return {
    key: "row",
    taskId: "task-1",
    date: "2026-03-30",
    occurrenceDate: "2026-03-29",
    scheduledDate: "2026-03-30",
    title: "Row",
    context: "inbox",
    status: "todo",
    ...overrides
  };
}

describe("taskOccurrenceIdentity", () => {
  it("builds schedule item keys from scheduleId", () => {
    expect(scheduleItemKey(42)).toBe("schedule:42");
  });

  it("builds occurrence membership keys from task, occurrence, and scheduled date", () => {
    expect(occurrenceMembershipKey("task-1", "2026-03-29", "2026-03-30"))
      .toBe("occurrence:task-1:2026-03-29:2026-03-30");
  });

  it("does not collapse two occurrences of the same task on the same planned date", () => {
    const first = occurrenceMembershipKey("task-1", "2026-03-29", "2026-03-30");
    const second = occurrenceMembershipKey("task-1", "2026-03-30", "2026-03-30");
    expect(first).not.toBe(second);
  });

  it("derives occurrence and scheduled dates with display-date fallbacks", () => {
    expect(rowOccurrenceDate(makeRow({ occurrenceDate: undefined }))).toBe("2026-03-30");
    expect(rowScheduledDate(makeRow({ scheduledDate: undefined }))).toBe("2026-03-30");
  });

  it("uses todayKey for Today membership even when the source row is planned elsewhere", () => {
    const plannedRow = makeRow({
      date: "2026-04-01",
      occurrenceDate: "2026-03-29",
      scheduledDate: "2026-04-01",
      scheduleId: 99
    });
    expect(rowTodayMembershipKey(plannedRow, "2026-03-30"))
      .toBe(occurrenceMembershipKey("task-1", "2026-03-29", "2026-03-30"));
  });

  it("resolves blank source occurrence dates to today for Today membership", () => {
    const unscheduledRow = makeRow({
      date: "",
      occurrenceDate: undefined,
      scheduledDate: undefined
    });
    expect(rowTodayMembershipKey(unscheduledRow, "2026-03-30"))
      .toBe(occurrenceMembershipKey("task-1", "2026-03-30", "2026-03-30"));
  });

  it("prefers scheduleId for row identity and natural key otherwise", () => {
    expect(taskOccurrenceRowKey({
      taskId: "task-1",
      occurrenceDate: "2026-03-29",
      scheduledDate: "2026-03-30",
      scheduleId: 123
    })).toBe("schedule:123");
    expect(taskOccurrenceRowKey({
      taskId: "task-1",
      occurrenceDate: "2026-03-29",
      scheduledDate: "2026-03-30"
    })).toBe("occurrence:task-1:2026-03-29:2026-03-30");
  });
});
