import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import type { LbsClient, LbsScheduleDay } from "../lbsClient.js";
import type { LbsTask } from "../lbsTaskService.js";
import { moveTaskOccurrence } from "../taskExceptionStore.js";
import {
  listTaskScheduleCalendar,
  listTaskToday,
  type ScheduleItemRow
} from "../taskScheduleStore.js";

const originalFetch = globalThis.fetch;
const originalLbsBaseUrl = process.env.TASKS_LBS_BASE_URL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalLbsBaseUrl === undefined) delete process.env.TASKS_LBS_BASE_URL;
  else process.env.TASKS_LBS_BASE_URL = originalLbsBaseUrl;
});

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
    process.env.TASKS_LBS_BASE_URL = "https://lbs.example.test";
    const calls: Array<{ method: string; url: string }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url });

      if (method === "GET" && url.includes("/exceptions?")) {
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (method === "POST" && url.includes("/exceptions")) {
        const body = JSON.parse(String(init?.body)) as { target_date: string };
        if (body.target_date === "2026-07-14") {
          return new Response('{"message":"target failed"}', {
            status: 500,
            headers: { "Content-Type": "application/json" }
          });
        }
        return new Response('{"id":101}', {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (method === "DELETE" && url.includes("/exceptions/101")) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }) as typeof fetch;

    await assert.rejects(
      () => moveTaskOccurrence("task-1", "2026-07-13", "2026-07-14", {
        ownerCoreUserId: "owner",
        lbsAccessToken: "token"
      }),
      /Failed to upsert exception/
    );

    assert.equal(calls.filter((call) => call.method === "GET").length, 3);
    assert.ok(calls.some((call) => call.method === "DELETE" && call.url.endsWith("/exceptions/101?force_override=true")));
  });

  it("includes an untimed recurring task in generated calendar items", async () => {
    const task = lbsTask("weekly-1", { rule_type: "WEEKLY", mon: true });
    const fakeClient = {
      listTasks: async () => [task],
      getSchedule: async (): Promise<LbsScheduleDay[]> => [{
        date: "2026-07-13",
        tasks: [{ task_id: task.task_id, task_name: task.task_name, context: task.context, status: "todo" }]
      }]
    } as unknown as LbsClient;

    const days = await listTaskScheduleCalendar("owner", "2026-07-13", "2026-07-13", {
      ownerCoreUserId: "owner",
      lbsAccessToken: "token"
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
    } as unknown as LbsClient;

    const result = await listTaskToday("owner", "2026-07-13", {
      ownerCoreUserId: "owner",
      lbsAccessToken: "token"
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
