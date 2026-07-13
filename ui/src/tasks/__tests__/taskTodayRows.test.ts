import { describe, expect, it } from "vitest";
import type { Task, TaskScheduleDay, TodayTask } from "../../types/models";
import { occurrenceMembershipKey, taskOccurrenceRowKey } from "../lib/taskOccurrenceIdentity";
import { buildTodayRows } from "../lib/taskTodayRows";

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: "Task",
    notes: "",
    context: "default",
    status: "todo",
    isLocked: false,
    baseLoadScore: 3,
    recurrence: "ONCE",
    active: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

describe("buildTodayRows", () => {
  it("merges explicit and generated occurrences, deduping by task and occurrence date", () => {
    const todayKey = "2026-07-13";
    const explicit = {
      ...makeTask({ id: "explicit", title: "Explicit", context: "project-a" }),
      occurrenceDate: todayKey,
      scheduledDate: todayKey,
      scheduleId: 42
    } satisfies TodayTask;
    const recurringFallback = makeTask({
      id: "recurring",
      title: "Fallback title",
      context: "project-b",
      contextName: "Project B",
      recurrence: "WEEKLY",
      baseLoadScore: 8,
      startTime: "09:00",
      isLocked: true
    });
    const schedule: TaskScheduleDay[] = [{
      date: todayKey,
      tasks: [
        { taskId: "explicit", title: "Duplicate", context: "project-a", status: "done" },
        { taskId: "recurring", title: "", context: "", status: "done", endTime: "10:30" }
      ]
    }];

    const result = buildTodayRows([explicit, recurringFallback], [explicit], schedule, todayKey);

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      key: "schedule:42",
      taskId: "explicit",
      occurrenceDate: todayKey,
      scheduledDate: todayKey,
      scheduleId: 42
    });
    expect(result.rows[1]).toEqual({
      key: taskOccurrenceRowKey({
        taskId: "recurring",
        occurrenceDate: todayKey,
        scheduledDate: todayKey
      }),
      taskId: "recurring",
      date: todayKey,
      occurrenceDate: todayKey,
      scheduledDate: todayKey,
      scheduleId: undefined,
      title: "Fallback title",
      context: "Project B",
      status: "done",
      load: 8,
      startTime: "09:00",
      endTime: "10:30",
      isLocked: true
    });
    expect(result.membershipKeys).toEqual(new Set([
      occurrenceMembershipKey("explicit", todayKey, todayKey)
    ]));
    expect(result.membershipKeys).not.toContain(
      occurrenceMembershipKey("recurring", todayKey, todayKey)
    );
  });

  it("keeps an explicit overdue occurrence separate from today's generated occurrence", () => {
    const todayKey = "2026-07-13";
    const explicit = {
      ...makeTask({ id: "recurring", recurrence: "WEEKLY" }),
      occurrenceDate: "2026-07-06",
      scheduledDate: todayKey,
      scheduleId: 77
    } satisfies TodayTask;
    const schedule: TaskScheduleDay[] = [{
      date: todayKey,
      tasks: [{ taskId: "recurring", title: "This week", context: "default", status: "todo" }]
    }];

    const result = buildTodayRows([explicit], [explicit], schedule, todayKey);

    expect(result.rows.map((row) => row.occurrenceDate)).toEqual(["2026-07-06", todayKey]);
    expect(result.membershipKeys).toEqual(new Set([
      occurrenceMembershipKey("recurring", "2026-07-06", todayKey)
    ]));
  });

  it("excludes skipped generated occurrences while retaining skipped explicit rows", () => {
    const todayKey = "2026-07-13";
    const explicitSkipped = {
      ...makeTask({ id: "explicit-skipped", status: "skipped" }),
      occurrenceDate: todayKey,
      scheduledDate: todayKey,
      scheduleId: 88
    } satisfies TodayTask;
    const generatedSkipped = makeTask({
      id: "generated-skipped",
      recurrence: "WEEKLY"
    });
    const schedule: TaskScheduleDay[] = [{
      date: todayKey,
      tasks: [
        {
          taskId: "generated-skipped",
          title: "Skipped recurrence",
          context: "default",
          status: "skipped"
        }
      ]
    }];

    const result = buildTodayRows(
      [explicitSkipped, generatedSkipped],
      [explicitSkipped],
      schedule,
      todayKey
    );

    expect(result.rows.map((row) => row.taskId)).toEqual(["explicit-skipped"]);
    expect(result.rows[0]?.status).toBe("skipped");
    expect(result.membershipKeys).toEqual(new Set([
      occurrenceMembershipKey("explicit-skipped", todayKey, todayKey)
    ]));
  });
});
