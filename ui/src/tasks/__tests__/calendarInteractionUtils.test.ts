import { describe, expect, it } from "vitest";
import {
  buildMonthCellContextPayload,
  buildStandaloneCalendarUrl,
  resolveStandaloneCalendarOptions,
  timelineDragToSnappedRange,
} from "../lib/calendarInteractionUtils";

describe("standalone calendar URL", () => {
  it("builds the bare default route for Today", () => {
    expect(buildStandaloneCalendarUrl()).toBe("/tasks/calendar");
  });

  it("builds an explicit Today route without a view parameter", () => {
    expect(buildStandaloneCalendarUrl("today", "week"))
      .toBe("/tasks/calendar?calendar=today");
  });

  it("preserves the requested calendar and view", () => {
    expect(buildStandaloneCalendarUrl("schedule", "week"))
      .toBe("/tasks/calendar?calendar=schedule&view=week");
  });

  it("preserves an explicit Due calendar", () => {
    expect(buildStandaloneCalendarUrl("due", "month"))
      .toBe("/tasks/calendar?calendar=due&view=month");
  });
});

describe("standalone calendar mode", () => {
  it("resolves missing parameters to Today", () => {
    expect(resolveStandaloneCalendarOptions(new URLSearchParams())).toEqual({
      calendar: "today",
      view: "month",
    });
  });

  it("ignores the view parameter for Today", () => {
    expect(resolveStandaloneCalendarOptions(new URLSearchParams("calendar=today&view=week"))).toEqual({
      calendar: "today",
      view: "month",
    });
  });

  it("resolves explicit Due and Schedule modes", () => {
    expect(resolveStandaloneCalendarOptions(new URLSearchParams("calendar=due&view=week"))).toEqual({
      calendar: "due",
      view: "week",
    });
    expect(resolveStandaloneCalendarOptions(new URLSearchParams("calendar=schedule&view=month"))).toEqual({
      calendar: "schedule",
      view: "month",
    });
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
