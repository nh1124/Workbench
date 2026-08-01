import { describe, expect, it } from "vitest";
import { computeTimelineHourHeight, layoutTimedItems } from "../lib/timelineLayoutUtils";

describe("computeTimelineHourHeight", () => {
  it("fills the available height when it is above the minimum", () => {
    expect(computeTimelineHourHeight(960, 24, 32)).toBe(40);
  });

  it("keeps the minimum height so a short viewport remains scrollable", () => {
    expect(computeTimelineHourHeight(480, 24, 32)).toBe(32);
  });

  it("falls back to the minimum for an invalid hour count", () => {
    expect(computeTimelineHourHeight(960, 0, 32)).toBe(32);
  });
});

describe("layoutTimedItems with variable hour height", () => {
  it("uses the supplied hour height for event top and height", () => {
    const [event] = layoutTimedItems([{ startTime: "02:30", endTime: "04:00" }], 40);
    expect(event.top).toBe(100);
    expect(event.height).toBe(60);
  });

  it("preserves overlap lane calculation at a different scale", () => {
    const events = layoutTimedItems([
      { id: "a", startTime: "09:00", endTime: "10:30" },
      { id: "b", startTime: "09:30", endTime: "10:00" },
      { id: "c", startTime: "10:30", endTime: "11:00" },
    ], 36);
    expect(events.map((event) => [event.id, event.lane, event.laneCount])).toEqual([
      ["a", 0, 2],
      ["b", 1, 2],
      ["c", 0, 1],
    ]);
  });
});
