import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasExactScheduleOccurrenceDate,
  normalizeScheduleNaturalKey,
  resolveScheduleOccurrenceDate
} from "../scheduleContract.js";

describe("scheduleContract", () => {
  it("resolves empty occurrenceDate to scheduledDate for Today add compatibility", () => {
    assert.equal(resolveScheduleOccurrenceDate("2026-06-29", undefined), "2026-06-29");
    assert.equal(resolveScheduleOccurrenceDate("2026-06-29", ""), "2026-06-29");
    assert.equal(resolveScheduleOccurrenceDate("2026-06-29", "   "), "2026-06-29");
  });

  it("preserves explicit occurrenceDate when it differs from scheduledDate", () => {
    assert.equal(resolveScheduleOccurrenceDate("2026-06-29", "2026-06-20"), "2026-06-20");
    assert.equal(resolveScheduleOccurrenceDate("2026-06-29", " 2026-06-20 "), "2026-06-20");
  });

  it("detects whether Today delete can use exact occurrence identity", () => {
    assert.equal(hasExactScheduleOccurrenceDate("2026-06-20"), true);
    assert.equal(hasExactScheduleOccurrenceDate(""), false);
    assert.equal(hasExactScheduleOccurrenceDate("   "), false);
    assert.equal(hasExactScheduleOccurrenceDate(undefined), false);
  });

  it("normalizes the schedule natural key fields", () => {
    assert.deepEqual(
      normalizeScheduleNaturalKey({
        taskId: " task-1 ",
        occurrenceDate: " 2026-06-20 ",
        scheduledDate: " 2026-06-29 "
      }),
      {
        taskId: "task-1",
        occurrenceDate: "2026-06-20",
        scheduledDate: "2026-06-29"
      }
    );
  });
});
