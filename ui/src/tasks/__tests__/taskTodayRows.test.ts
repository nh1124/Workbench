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
  it("uses the requested Day key for generated rows instead of the current date", () => {
    const displayedDate = "2026-08-03";
    const recurring = makeTask({ id: "recurring", recurrence: "WEEKLY" });
    const schedule: TaskScheduleDay[] = [{
      date: displayedDate,
      tasks: [{ taskId: recurring.id, title: recurring.title, context: recurring.context, status: "todo" }]
    }];

    const result = buildTodayRows([recurring], [], schedule, displayedDate);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      date: displayedDate,
      occurrenceDate: displayedDate,
      scheduledDate: displayedDate,
    });
  });

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

  it("excludes both explicit and generated skipped occurrences", () => {
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

    expect(result.rows).toEqual([]);
    expect(result.membershipKeys).toEqual(new Set());
  });

  it("does not resurrect an explicit-skipped occurrence from its generated row", () => {
    const todayKey = "2026-07-13";
    const explicitSkipped = {
      ...makeTask({ id: "recurring", status: "skipped", recurrence: "WEEKLY" }),
      occurrenceDate: todayKey,
      scheduledDate: todayKey,
      scheduleId: 90
    } satisfies TodayTask;
    const schedule: TaskScheduleDay[] = [{
      date: todayKey,
      tasks: [{ taskId: "recurring", title: "This week", context: "default", status: "todo" }]
    }];

    const result = buildTodayRows([explicitSkipped], [explicitSkipped], schedule, todayKey);

    // The explicit skip covers the occurrence, so the generated todo row is suppressed.
    expect(result.rows).toEqual([]);
  });

  it("drops explicit Today entries from other projects under an active project filter", () => {
    const todayKey = "2026-07-13";
    const explicitA = {
      ...makeTask({ id: "a", context: "project-a" }),
      occurrenceDate: todayKey,
      scheduledDate: todayKey,
      scheduleId: 1
    } satisfies TodayTask;
    const explicitB = {
      ...makeTask({ id: "b", context: "project-b" }),
      occurrenceDate: todayKey,
      scheduledDate: todayKey,
      scheduleId: 2
    } satisfies TodayTask;

    const result = buildTodayRows(
      [explicitA, explicitB],
      [explicitA, explicitB],
      [],
      todayKey,
      "project-a"
    );

    expect(result.rows.map((row) => row.taskId)).toEqual(["a"]);
    expect(result.membershipKeys).toEqual(new Set([
      occurrenceMembershipKey("a", todayKey, todayKey)
    ]));
  });
});
