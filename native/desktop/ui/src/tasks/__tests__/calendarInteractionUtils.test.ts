import { describe, expect, it } from "vitest";
import {
  buildMonthCellContextPayload,
  buildStandaloneCalendarUrl,
  moveStandaloneDayDate,
  resolveStandaloneCalendarOptions,
  timelineDragToSnappedRange,
} from "../lib/calendarInteractionUtils";

describe("standalone calendar URL", () => {
  it("builds the bare default route for Day", () => {
    expect(buildStandaloneCalendarUrl()).toBe("/tasks/calendar");
  });

  it("builds an explicit Day route with a date and without a view parameter", () => {
    expect(buildStandaloneCalendarUrl("day", "week", "2026-07-15"))
      .toBe("/tasks/calendar?calendar=day&date=2026-07-15");
  });

  it("canonicalizes the Today alias to Day", () => {
    expect(buildStandaloneCalendarUrl("today", "week", "2026-07-15"))
      .toBe("/tasks/calendar?calendar=day&date=2026-07-15");
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
  const now = new Date(2026, 6, 15, 14, 30);

  it("resolves missing parameters to Day on the current date", () => {
    expect(resolveStandaloneCalendarOptions(new URLSearchParams(), now)).toEqual({
      calendar: "day",
      view: "month",
      date: "2026-07-15",
    });
  });

  it("accepts Today as a Day alias and preserves a valid date", () => {
    expect(resolveStandaloneCalendarOptions(new URLSearchParams("calendar=today&view=week&date=2026-07-16"), now)).toEqual({
      calendar: "day",
      view: "month",
      date: "2026-07-16",
    });
  });

  it("falls back to the current date for an invalid Day date", () => {
    expect(resolveStandaloneCalendarOptions(new URLSearchParams("calendar=day&date=2026-02-30"), now))
      .toEqual({ calendar: "day", view: "month", date: "2026-07-15" });
  });

  it("resolves explicit Due and Schedule modes", () => {
    expect(resolveStandaloneCalendarOptions(new URLSearchParams("calendar=due&view=week"), now)).toEqual({
      calendar: "due",
      view: "week",
      date: "2026-07-15",
    });
    expect(resolveStandaloneCalendarOptions(new URLSearchParams("calendar=schedule&view=month"), now)).toEqual({
      calendar: "schedule",
      view: "month",
      date: "2026-07-15",
    });
  });
});

describe("standalone Day navigation", () => {
  it("moves across month and year boundaries using local calendar math", () => {
    expect(moveStandaloneDayDate("2026-07-01", -1)).toBe("2026-06-30");
    expect(moveStandaloneDayDate("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("handles leap days", () => {
    expect(moveStandaloneDayDate("2028-02-28", 1)).toBe("2028-02-29");
    expect(moveStandaloneDayDate("2028-02-29", 1)).toBe("2028-03-01");
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
