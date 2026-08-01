import { describe, expect, it } from "vitest";
import type { ScheduleCalendarDay, TaskScheduleDay } from "../../types/models";
import { countDistinctOverdueTasks, countDistinctPlannedTasks } from "../lib/taskOccurrenceCounts";

describe("task occurrence badge counts", () => {
  it("counts distinct planned task ids after today and respects context", () => {
    const days: ScheduleCalendarDay[] = [
      { date: "2026-07-13", items: [{ taskId: "today", title: "Today", context: "a", status: "todo", occurrenceDate: "2026-07-13", scheduledDate: "2026-07-13" }] },
      { date: "2026-07-14", items: [
        { taskId: "repeat", title: "Repeat", context: "a", status: "todo", occurrenceDate: "2026-07-14", scheduledDate: "2026-07-14" },
        { taskId: "other", title: "Other", context: "b", status: "todo", occurrenceDate: "2026-07-14", scheduledDate: "2026-07-14" }
      ] },
      { date: "2026-07-20", items: [{ taskId: "repeat", title: "Repeat", context: "a", status: "todo", occurrenceDate: "2026-07-20", scheduledDate: "2026-07-20" }] }
    ];

    expect(countDistinctPlannedTasks(days, "2026-07-13")).toBe(2);
    expect(countDistinctPlannedTasks(days, "2026-07-13", "a")).toBe(1);
  });

  it("counts distinct overdue task ids with at least one non-done occurrence", () => {
    const days: TaskScheduleDay[] = [
      { date: "2026-07-10", tasks: [
        { taskId: "repeat", title: "Repeat", context: "a", status: "todo" },
        { taskId: "done-only", title: "Done", context: "a", status: "done" }
      ] },
      { date: "2026-07-11", tasks: [
        { taskId: "repeat", title: "Repeat", context: "a", status: "skipped" },
        { taskId: "other", title: "Other", context: "b", status: "todo" }
      ] },
      { date: "2026-07-13", tasks: [{ taskId: "today", title: "Today", context: "a", status: "todo" }] }
    ];

    expect(countDistinctOverdueTasks(days, "2026-07-13")).toBe(2);
    expect(countDistinctOverdueTasks(days, "2026-07-13", "a")).toBe(1);
  });
});
