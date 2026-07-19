import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeNextRunAt, parseSchedule, wallClockInZone, zonedTimeToUtc } from "../schedule.js";

function isInvalidSchedule(error: unknown): boolean {
  return (error as { status?: number }).status === 400
    && (error as { code?: string }).code === "INVALID_SCHEDULE";
}

describe("analyser schedules", () => {
  it("validates interval bounds and adds minutes", () => {
    assert.throws(() => parseSchedule("interval", "4", "Asia/Tokyo"), isInvalidSchedule);
    assert.equal(parseSchedule("interval", "5", "Asia/Tokyo").kind, "interval");
    assert.throws(() => parseSchedule("interval", "10081", "Asia/Tokyo"), isInvalidSchedule);
    assert.equal(
      computeNextRunAt("interval", "15", "Asia/Tokyo", new Date("2026-07-20T00:00:30.000Z")).toISOString(),
      "2026-07-20T00:15:30.000Z"
    );
  });

  it("validates the supported cron subset", () => {
    assert.throws(() => parseSchedule("cron", "0 9 * *", "Asia/Tokyo"), isInvalidSchedule);
    assert.throws(() => parseSchedule("cron", "60 9 * * *", "Asia/Tokyo"), isInvalidSchedule);
    assert.throws(() => parseSchedule("cron", "*/5 9 * * *", "Asia/Tokyo"), isInvalidSchedule);
    assert.throws(() => parseSchedule("cron", "0 9 1-5 * *", "Asia/Tokyo"), isInvalidSchedule);
    assert.doesNotThrow(() => parseSchedule("cron", "0,30 8,9 1,15 1,12 0,6", "Asia/Tokyo"));
    assert.throws(() => parseSchedule("cron", "0 9 * * *", "not/a-zone"), isInvalidSchedule);
  });

  it("computes daily and weekly Asia/Tokyo wall-clock runs", () => {
    assert.equal(
      computeNextRunAt("cron", "0 9 * * *", "Asia/Tokyo", new Date("2026-07-20T23:00:00.000Z")).toISOString(),
      "2026-07-21T00:00:00.000Z"
    );
    assert.equal(
      computeNextRunAt("cron", "0 9 * * *", "Asia/Tokyo", new Date("2026-07-21T01:00:00.000Z")).toISOString(),
      "2026-07-22T00:00:00.000Z"
    );
    assert.equal(
      computeNextRunAt("cron", "0 8 * * 0", "Asia/Tokyo", new Date("2026-07-20T00:00:00.000Z")).toISOString(),
      "2026-07-25T23:00:00.000Z"
    );
  });

  it("resolves DST gaps to the first post-gap instant and ambiguities to the earlier instant", () => {
    assert.equal(
      computeNextRunAt("cron", "30 2 * * *", "America/New_York", new Date("2026-03-08T05:00:00.000Z")).toISOString(),
      "2026-03-08T07:00:00.000Z"
    );
    assert.equal(
      computeNextRunAt("cron", "30 1 * * *", "America/New_York", new Date("2026-11-01T04:00:00.000Z")).toISOString(),
      "2026-11-01T05:30:00.000Z"
    );
  });

  it("uses OR semantics when both day-of-month and day-of-week are restricted", () => {
    assert.equal(
      computeNextRunAt("cron", "0 9 15 * 1", "Asia/Tokyo", new Date("2026-07-14T01:00:00.000Z")).toISOString(),
      "2026-07-15T00:00:00.000Z"
    );
    assert.equal(
      computeNextRunAt("cron", "0 9 15 * 1", "Asia/Tokyo", new Date("2026-07-15T01:00:00.000Z")).toISOString(),
      "2026-07-20T00:00:00.000Z"
    );
  });

  it("exports wall-clock conversion helpers", () => {
    const instant = zonedTimeToUtc("Asia/Tokyo", { year: 2026, month: 7, day: 21, hour: 9, minute: 0 });
    assert.equal(instant.toISOString(), "2026-07-21T00:00:00.000Z");
    assert.deepEqual(wallClockInZone("Asia/Tokyo", instant), {
      year: 2026, month: 7, day: 21, hour: 9, minute: 0, weekday: 2
    });
  });
});
