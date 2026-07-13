import { describe, expect, it } from "vitest";
import { buildInboxRows } from "../inboxBuilder";
import type { ScheduleCalendarDay, Task, TaskScheduleDay } from "../../types/models";
import { taskDefinitionRowKey, taskOccurrenceRowKey } from "../../tasks/lib/taskOccurrenceIdentity";

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: "Test task",
    notes: "",
    context: "default",
    status: "todo",
    isLocked: false,
    baseLoadScore: 5,
    recurrence: "ONCE",
    active: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

const todayKey = "2026-07-13";

describe("buildInboxRows", () => {
  it("keeps a dueDate-less ONCE task as a task-identity row", () => {
    const task = makeTask({ id: "no-date" });
    const { upcomingRows, doneRows } = buildInboxRows([task], { todayKey });

    expect(upcomingRows).toEqual([expect.objectContaining({
      key: taskDefinitionRowKey("no-date"),
      taskId: "no-date",
      date: ""
    })]);
    expect(upcomingRows[0]).not.toHaveProperty("occurrenceDate");
    expect(doneRows).toHaveLength(0);
  });

  it("builds a dueDate ONCE task as an occurrence row", () => {
    const task = makeTask({ id: "once", dueDate: "2026-07-18" });
    const { upcomingRows } = buildInboxRows([task], { todayKey });

    expect(upcomingRows[0]).toEqual(expect.objectContaining({
      key: taskOccurrenceRowKey({ taskId: "once", occurrenceDate: "2026-07-18" }),
      date: "2026-07-18",
      occurrenceDate: "2026-07-18"
    }));
  });

  it("selects the earliest pending recurring occurrence on or after today", () => {
    const task = makeTask({ id: "weekly", recurrence: "WEEKLY", mon: true });
    const countSchedule: TaskScheduleDay[] = [
      { date: "2026-07-12", tasks: [{ taskId: "weekly", title: task.title, context: task.context, status: "todo" }] },
      { date: "2026-07-13", tasks: [{ taskId: "weekly", title: task.title, context: task.context, status: "done" }] },
      { date: "2026-07-20", tasks: [{ taskId: "weekly", title: task.title, context: task.context, status: "todo" }] },
      { date: "2026-07-27", tasks: [{ taskId: "weekly", title: task.title, context: task.context, status: "todo" }] }
    ];
    const scheduleCalendar: ScheduleCalendarDay[] = [{
      date: "2026-07-20",
      items: [{
        scheduleId: 42,
        taskId: "weekly",
        title: task.title,
        context: task.context,
        status: "todo",
        occurrenceDate: "2026-07-20",
        scheduledDate: "2026-07-20",
        startTime: "09:00"
      }]
    }];

    const { upcomingRows } = buildInboxRows([task], { countSchedule, scheduleCalendar, todayKey });
    expect(upcomingRows).toHaveLength(1);
    expect(upcomingRows[0]).toEqual(expect.objectContaining({
      key: taskOccurrenceRowKey({ taskId: "weekly", occurrenceDate: "2026-07-20" }),
      occurrenceDate: "2026-07-20",
      scheduleId: 42,
      startTime: "09:00"
    }));
  });

  it("shows completed occurrence history newest first", () => {
    const task = makeTask({ id: "daily", recurrence: "DAILY", intervalDays: 1 });
    const countSchedule: TaskScheduleDay[] = [
      { date: "2026-07-10", tasks: [{ taskId: "daily", title: task.title, context: task.context, status: "done" }] },
      { date: "2026-07-12", tasks: [{ taskId: "daily", title: task.title, context: task.context, status: "done" }] },
      { date: "2026-07-13", tasks: [{ taskId: "daily", title: task.title, context: task.context, status: "todo" }] }
    ];

    const { doneRows } = buildInboxRows([task], { countSchedule, todayKey });
    expect(doneRows.map((row) => row.occurrenceDate)).toEqual(["2026-07-12", "2026-07-10"]);
    expect(doneRows[0].key).toBe(taskOccurrenceRowKey({ taskId: "daily", occurrenceDate: "2026-07-12" }));
  });

  it("falls back to a date-less recurring row when no pending occurrence exists in the window", () => {
    const task = makeTask({ id: "monthly", recurrence: "MONTHLY_DAY", monthDay: 1 });
    const countSchedule: TaskScheduleDay[] = [{
      date: "2026-07-13",
      tasks: [{ taskId: "monthly", title: task.title, context: task.context, status: "skipped" }]
    }];

    const { upcomingRows } = buildInboxRows([task], { countSchedule, todayKey });
    expect(upcomingRows).toEqual([expect.objectContaining({
      key: taskDefinitionRowKey("monthly"),
      date: ""
    })]);
    expect(upcomingRows[0]).not.toHaveProperty("occurrenceDate");
  });

  it("keeps a legacy done ONCE task only when it has no occurrence entry", () => {
    const task = makeTask({ id: "legacy", status: "done" });
    const { doneRows } = buildInboxRows([task], { todayKey });
    expect(doneRows).toEqual([expect.objectContaining({ key: taskDefinitionRowKey("legacy"), status: "done" })]);
  });
});
