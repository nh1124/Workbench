import { describe, expect, it } from "vitest";
import {
  buildMonthCellContextPayload,
  buildStandaloneCalendarUrl,
  timelineDragToSnappedRange,
} from "../lib/calendarInteractionUtils";

describe("standalone calendar URL", () => {
  it("builds the default due-month route", () => {
    expect(buildStandaloneCalendarUrl()).toBe("/tasks/calendar?calendar=due&view=month");
  });

  it("preserves the requested calendar and view", () => {
    expect(buildStandaloneCalendarUrl("schedule", "week"))
      .toBe("/tasks/calendar?calendar=schedule&view=week");
  });
});

describe("month-cell context payload", () => {
  it("normalizes the selected local calendar date", () => {
    expect(buildMonthCellContextPayload(new Date(2026, 6, 14), 120, 240)).toEqual({
      date: "2026-07-14",
      x: 120,
      y: 240,
    });
  });
});

describe("timeline drag snapping", () => {
  it("maps a downward drag to a 15-minute range", () => {
    expect(timelineDragToSnappedRange(9.12 * 40, 10.63 * 40, 40)).toMatchObject({
      startTime: "09:00",
      endTime: "10:45",
      top: 360,
      height: 70,
    });
  });

  it("normalizes an upward drag", () => {
    expect(timelineDragToSnappedRange(12.9 * 32, 11.1 * 32, 32)).toMatchObject({
      startTime: "11:00",
      endTime: "13:00",
    });
  });

  it("gives a zero-distance drag one snapped slot", () => {
    expect(timelineDragToSnappedRange(8 * 32, 8 * 32, 32)).toMatchObject({
      startTime: "08:00",
      endTime: "08:15",
      height: 8,
    });
  });

  it("clamps selection to timeline bounds", () => {
    expect(timelineDragToSnappedRange(-100, 10000, 32)).toMatchObject({
      startTime: "00:00",
      endTime: "24:00",
    });
  });
});
