import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { getLbsBackend, getLbsConfig } from "../lbs/backendFactory.js";
import { LocalLbsBackend } from "../lbs/localBackend.js";
import type { LbsBackendContext } from "../lbs/dataPlane.js";
import type { LbsStoreDatabase } from "../lbs/storeUtils.js";
import {
  completeTaskOccurrence,
  createTask,
  listTasks,
  type TaskStoreDependencies
} from "../store.js";
import { listTaskToday, type ScheduleItemRow } from "../taskScheduleStore.js";

const ENV_KEYS = [
  "TASKS_LBS_MODE",
  "TASKS_TIMEZONE"
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function clearLbsEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

class SmokeLbsDatabase {
  tasks: Array<Record<string, unknown>> = [];
  executions: Array<Record<string, unknown>> = [];
  private nextExecutionId = 1;

  private result(rows: Array<Record<string, unknown>>, rowCount = rows.length) {
    return Promise.resolve({ rows, rowCount });
  }

  query = async (rawSql: string, values: unknown[] = []) => {
    const sql = rawSql.replace(/\s+/g, " ").trim();

    if (sql.startsWith("SELECT key, value FROM lbs_user_config")) return this.result([]);

    if (sql.startsWith("SELECT owner_username, task_id") && sql.includes("FROM task_definitions")) {
      let rows = this.tasks.filter((row) => row.owner_username === values[0]);
      if (sql.includes("task_id = $2")) rows = rows.filter((row) => row.task_id === values[1]);
      if (sql.includes("context = $2")) rows = rows.filter((row) => row.context === values[1]);
      const activeMatch = /active = \$(\d+)/.exec(sql);
      if (activeMatch) rows = rows.filter((row) => row.active === values[Number(activeMatch[1]) - 1]);
      return this.result(rows);
    }

    if (sql.startsWith("INSERT INTO task_definitions")) {
      const row: Record<string, unknown> = {
        owner_username: values[0], task_id: values[1], task_name: values[2], context: values[3],
        base_load_score: values[4], active: values[5], rule_type: values[6], due_date: values[7],
        mon: values[8], tue: values[9], wed: values[10], thu: values[11], fri: values[12],
        sat: values[13], sun: values[14], interval_days: values[15], anchor_date: values[16],
        month_day: values[17], nth_in_month: values[18], weekday_mon1: values[19],
        start_date: values[20], end_date: values[21], start_time: values[22], end_time: values[23],
        notes: values[24], external_sync_id: values[25], timezone: values[26], is_locked: values[27],
        created_at: "2026-07-13T00:00:00.000Z", updated_at: "2026-07-13T00:00:00.000Z"
      };
      this.tasks.push(row);
      return this.result([row], 1);
    }

    if (sql.startsWith("SELECT id, owner_username, task_id") && sql.includes("FROM task_rule_exceptions")) {
      return this.result([]);
    }

    if (sql.startsWith("SELECT id, owner_username, task_id") && sql.includes("FROM task_executions")) {
      let rows = this.executions.filter((row) => row.owner_username === values[0]
        && String(row.target_date) >= String(values[1]) && String(row.target_date) <= String(values[2]));
      if (sql.includes("task_id = $4")) rows = rows.filter((row) => row.task_id === values[3]);
      return this.result(rows);
    }

    if (sql.startsWith("INSERT INTO task_executions")) {
      let row = this.executions.find((candidate) => candidate.owner_username === values[0]
        && candidate.task_id === values[1] && candidate.target_date === values[2]);
      if (!row) {
        row = {
          id: this.nextExecutionId++, owner_username: values[0], task_id: values[1],
          target_date: values[2], created_at: "2026-07-13T00:00:00.000Z"
        };
        this.executions.push(row);
      }
      row.status = values[3];
      row.progress = values[4];
      row.actual_time = values[5];
      return this.result([row], 1);
    }

    if (sql.startsWith("DELETE FROM task_executions")) {
      const before = this.executions.length;
      this.executions = this.executions.filter((row) => row.owner_username !== values[0]
        || row.task_id !== values[1] || row.target_date !== values[2]);
      return this.result([], before - this.executions.length);
    }

    if (sql.startsWith("SELECT owner_username, target_date") && sql.includes("FROM daily_conditions")) {
      return this.result([]);
    }

    throw new Error(`Unhandled smoke SQL: ${sql}`);
  };

  asDatabase(): LbsStoreDatabase {
    return { query: this.query } as LbsStoreDatabase;
  }
}

describe("LBS backend factory", () => {
  it("defaults to local mode and uses TASKS_TIMEZONE", () => {
    clearLbsEnv();
    process.env.TASKS_TIMEZONE = "Pacific/Auckland";
    const database = new SmokeLbsDatabase().asDatabase();

    const backend = getLbsBackend({ ownerCoreUserId: " Owner-A " }, { database });

    assert.ok(backend instanceof LocalLbsBackend);
    assert.equal(backend.owner, "owner-a");
    assert.equal(getLbsConfig().timezone, "Pacific/Auckland");
  });

  it("rejects remote mode with the production migration runbook", () => {
    clearLbsEnv();
    process.env.TASKS_LBS_MODE = "remote";
    assert.throws(
      () => getLbsBackend({ ownerCoreUserId: "owner" }),
      /scripts\/lbs-migrate\/README\.md/
    );
  });
});

describe("local mode task data-plane smoke", () => {
  it("lists, creates, completes, and reads Today with owner scoping and no token", async () => {
    clearLbsEnv();
    process.env.TASKS_LBS_MODE = "local";
    const database = new SmokeLbsDatabase();
    const getBackend = (context: LbsBackendContext) => getLbsBackend(context, { database: database.asDatabase() });
    const dependencies: Partial<TaskStoreDependencies> = {
      getLbsBackend: getBackend,
      listPinnedTaskIds: async () => [],
      cacheTasks: async () => undefined
    };
    const ownerA = { ownerCoreUserId: "owner-a" };
    const ownerB = { ownerCoreUserId: "owner-b" };

    assert.deepEqual(await listTasks(undefined, "owner-a", ownerA, dependencies), []);
    const created = await createTask({
      title: "Local smoke",
      context: "inbox",
      recurrence: "ONCE",
      dueDate: "2026-07-13",
      status: "todo"
    }, "owner-a", ownerA, dependencies);

    assert.equal((await listTasks(undefined, "owner-a", ownerA, dependencies)).length, 1);
    assert.deepEqual(await listTasks(undefined, "owner-b", ownerB, dependencies), []);

    await completeTaskOccurrence(created.id, "2026-07-13", "done", ownerA, dependencies);
    const scheduleItem: ScheduleItemRow = {
      id: 1,
      taskId: created.id,
      occurrenceDate: "2026-07-13",
      scheduledDate: "2026-07-13",
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z"
    };
    const today = await listTaskToday("owner-a", "2026-07-13", ownerA, {
      getLbsBackend: getBackend,
      listPinnedTaskIds: async () => [],
      listItemsByScheduledDate: async () => [scheduleItem]
    });

    assert.equal(today.length, 1);
    assert.equal(today[0].id, created.id);
    assert.equal(today[0].status, "done");
  });
});
