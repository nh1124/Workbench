import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeResponseTask,
  resolveStatusTargetDate,
  toDueDateOnly,
  toLbsStatus,
  toLbsWeekdayMon1,
  toUiStatus,
  toUiWeekdayIndex,
  toValidRecurrence,
  todayInTimezone
} from "../lbsTaskService.js";

describe("lbsTaskService", () => {
  it("normalizes recurrence safely", () => {
    assert.equal(toValidRecurrence("WEEKLY"), "WEEKLY");
    assert.equal(toValidRecurrence("INVALID"), "ONCE");
    assert.equal(toValidRecurrence(undefined), "ONCE");
  });

  it("converts status values between UI and LBS", () => {
    assert.equal(toLbsStatus("todo"), "todo");
    assert.equal(toLbsStatus("done"), "done");
    assert.equal(toLbsStatus("skipped"), "skipped");

    assert.equal(toUiStatus("todo"), "todo");
    assert.equal(toUiStatus("done"), "done");
    assert.equal(toUiStatus("skipped"), "skipped");
    assert.equal(toUiStatus("anything-else"), "todo");
  });

  it("converts weekday indexes across the LBS boundary", () => {
    assert.equal(toLbsWeekdayMon1(0), 7);
    assert.equal(toLbsWeekdayMon1(1), 1);
    assert.equal(toLbsWeekdayMon1(6), 6);
    assert.equal(toLbsWeekdayMon1(7), undefined);

    assert.equal(toUiWeekdayIndex(7), 0);
    assert.equal(toUiWeekdayIndex(1), 1);
    assert.equal(toUiWeekdayIndex(6), 6);
    assert.equal(toUiWeekdayIndex(0), undefined);
  });

  it("normalizes LBS Sunday weekday_mon1 to the UI weekday index", () => {
    const task = normalizeResponseTask({
      task_id: "task-1",
      task_name: "Monthly Sunday",
      context: "inbox",
      base_load_score: 1,
      active: true,
      rule_type: "MONTHLY_NTH_WEEKDAY",
      nth_in_month: 2,
      weekday_mon1: 7
    });

    assert.equal(task.weekdayMon1, 0);
  });

  it("extracts YYYY-MM-DD from date-like inputs", () => {
    assert.equal(toDueDateOnly("2026-03-24T15:20:00+09:00"), "2026-03-24");
    assert.equal(toDueDateOnly("2026-03-24"), "2026-03-24");
    assert.equal(toDueDateOnly(""), undefined);
    assert.equal(toDueDateOnly("not-a-date"), undefined);
  });

  it("resolves status target date with recurrence rules", () => {
    assert.equal(
      resolveStatusTargetDate("ONCE", "2026-03-30", "Asia/Tokyo", "UTC"),
      "2026-03-30"
    );

    const todayTokyo = todayInTimezone("Asia/Tokyo");
    assert.equal(
      resolveStatusTargetDate("ONCE", undefined, "Asia/Tokyo", "UTC"),
      todayTokyo
    );
    assert.equal(
      resolveStatusTargetDate("WEEKLY", "2026-01-01", "Asia/Tokyo", "UTC"),
      todayTokyo
    );
  });
});
