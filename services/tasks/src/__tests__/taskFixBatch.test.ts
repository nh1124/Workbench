import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { LbsDataPlane, LbsScheduleDay } from "../lbs/dataPlane.js";
import type { LbsTask } from "../lbsTaskService.js";
import { moveTaskOccurrence } from "../taskExceptionStore.js";
import {
  listTaskScheduleCalendar,
  listTaskToday,
  type ScheduleItemRow
} from "../taskScheduleStore.js";

function lbsTask(id: string, overrides: Partial<LbsTask> = {}): LbsTask {
  return {
    task_id: id,
    task_name: `Task ${id}`,
    context: "inbox",
    base_load_score: 1,
    active: true,
    rule_type: "ONCE",
    ...overrides
  };
}

function scheduleItem(id: number, taskId: string, occurrenceDate: string): ScheduleItemRow {
  return {
    id,
    taskId,
    occurrenceDate,
    scheduledDate: "2026-07-13",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z"
  };
}

describe("task fix batch", () => {
  it("compensates the source SKIP when the move target write fails", async () => {
    const calls: Array<{ method: string; target?: string | number }> = [];
    const fakeBackend = {
      listExceptions: async (_taskId: string, startDate?: string) => {
        calls.push({ method: "list", target: startDate });
        return [];
      },
      createException: async (payload: Record<string, unknown>) => {
        const targetDate = String(payload.target_date);
        calls.push({ method: "create", target: targetDate });
        if (targetDate === "2026-07-14") throw new Error("target failed");
        return { id: 101 };
      },
      deleteException: async (id: number) => {
        calls.push({ method: "delete", target: id });
      }
    } as unknown as LbsDataPlane;

    await assert.rejects(
      () => moveTaskOccurrence("task-1", "2026-07-13", "2026-07-14", {
        ownerCoreUserId: "owner"
      }, { getLbsBackend: () => fakeBackend }),
      /Failed to upsert exception/
    );

    assert.equal(calls.filter((call) => call.method === "list").length, 3);
    assert.ok(calls.some((call) => call.method === "delete" && call.target === 101));
  });

  it("includes an untimed recurring task in generated calendar items", async () => {
    const task = lbsTask("weekly-1", { rule_type: "WEEKLY", mon: true });
    const fakeClient = {
      listTasks: async () => [task],
      getSchedule: async (): Promise<LbsScheduleDay[]> => [{
        date: "2026-07-13",
        tasks: [{ task_id: task.task_id, task_name: task.task_name, context: task.context, status: "todo" }]
      }]
    } as unknown as LbsDataPlane;

    const days = await listTaskScheduleCalendar("owner", "2026-07-13", "2026-07-13", {
      ownerCoreUserId: "owner"
    }, {
      listItemsForCalendarWindow: async () => [],
      getLbsBackend: () => fakeClient
    });

    assert.equal(days.length, 1);
    assert.equal(days[0].items[0].taskId, "weekly-1");
    assert.equal(days[0].items[0].startTime, undefined);
    assert.equal(days[0].items[0].endTime, undefined);
  });

  it("batches Today definition and schedule reads when both maps cover all items", async () => {
    const counters = { listTasks: 0, getSchedule: 0, getTask: 0, resolveTask: 0, getTaskHistory: 0 };
    const tasks = [lbsTask("a"), lbsTask("b"), lbsTask("c")];
    const schedule: LbsScheduleDay[] = ["2026-07-10", "2026-07-11", "2026-07-12"].map((date, index) => ({
      date,
      tasks: [{
        task_id: tasks[index].task_id,
        task_name: tasks[index].task_name,
        context: tasks[index].context,
        status: index === 1 ? "done" : "todo",
        load: index + 2,
        is_locked: index === 2
      }]
    }));
    const fakeClient = {
      listTasks: async () => { counters.listTasks += 1; return tasks; },
      getSchedule: async () => { counters.getSchedule += 1; return schedule; },
      getTask: async () => { counters.getTask += 1; throw new Error("unexpected getTask"); },
      resolveTask: async () => { counters.resolveTask += 1; throw new Error("unexpected resolveTask"); },
      getTaskHistory: async () => { counters.getTaskHistory += 1; throw new Error("unexpected history"); }
    } as unknown as LbsDataPlane;

    const result = await listTaskToday("owner", "2026-07-13", {
      ownerCoreUserId: "owner"
    }, {
      listPinnedTaskIds: async () => ["b"],
      listItemsByScheduledDate: async () => [
        scheduleItem(1, "a", "2026-07-10"),
        scheduleItem(2, "b", "2026-07-11"),
        scheduleItem(3, "c", "2026-07-12")
      ],
      getLbsBackend: () => fakeClient
    });

    assert.deepEqual(counters, {
      listTasks: 1,
      getSchedule: 1,
      getTask: 0,
      resolveTask: 0,
      getTaskHistory: 0
    });
    assert.equal(result.length, 3);
    assert.equal(result[1].status, "done");
    assert.equal(result[1].isPinned, true);
    assert.equal(result[2].baseLoadScore, 4);
    assert.equal(result[2].isLocked, true);
  });

  it("scopes subtask mutations by occurrence and strips schedule-item occurrenceDate updates", () => {
    const __filename = fileURLToPath(import.meta.url);
    const srcDir = path.resolve(path.dirname(__filename), "..");
    const subtasksSource = readFileSync(path.join(srcDir, "subtasksStore.ts"), "utf8");
    const httpSource = readFileSync(path.join(srcDir, "httpServer.ts"), "utf8");
    const scheduleStoreSource = readFileSync(path.join(srcDir, "scheduleItemsStore.ts"), "utf8");

    assert.equal((subtasksSource.match(/AND occurrence_date = \$4/g) ?? []).length, 2);
    assert.match(httpSource, /updateSubtask\([\s\S]*?String\(req\.params\.date\),[\s\S]*?owner,[\s\S]*?parsed\.data/);
    assert.match(httpSource, /deleteSubtask\([\s\S]*?String\(req\.params\.date\),[\s\S]*?owner/);

    const updateSchema = httpSource.slice(
      httpSource.indexOf("const scheduleItemUpdateSchema"),
      httpSource.indexOf("// GET /tasks/today")
    );
    assert.doesNotMatch(updateSchema, /occurrenceDate/);
    assert.match(httpSource, /ignored immutable occurrenceDate/);
    const updateItem = scheduleStoreSource.slice(
      scheduleStoreSource.indexOf("export async function updateItem"),
      scheduleStoreSource.indexOf("export async function removeScheduleItem")
    );
    assert.doesNotMatch(updateItem, /occurrenceDate/);
  });
});
