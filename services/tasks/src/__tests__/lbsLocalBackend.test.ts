import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { LocalLbsBackend, LbsNotFoundError } from "../lbs/localBackend.js";
import type { LbsStoreDatabase } from "../lbs/storeUtils.js";
import type { DailyCondition, LBSFixtureInput, LBSTask, TaskException, TaskExecution, TaskStatus } from "../lbs/types.js";

interface ManifestQuery { name: string; value: string }
interface ManifestCall { file: string; method: string; path: string; query: ManifestQuery[] }
interface GoldenManifest { calls: ManifestCall[]; golden_count: number }

const here = dirname(fileURLToPath(import.meta.url));
const goldensDir = join(here, "../lbs/__goldens__");
const readJson = <T>(file: string): T => JSON.parse(readFileSync(join(goldensDir, file), "utf8")) as T;
const fixture = readJson<LBSFixtureInput>("fixture_input.json");
const manifest = readJson<GoldenManifest>("manifest.json");

function definitionRow(task: LBSTask): Record<string, unknown> {
  const { user_id, ...row } = task;
  return { ...row, owner_username: user_id };
}

function exceptionRow(exception: TaskException): Record<string, unknown> {
  const { user_id, ...row } = exception;
  return {
    ...row,
    created_at: /(?:Z|[+-]\d{2}:\d{2})$/.test(row.created_at) ? row.created_at : `${row.created_at}Z`,
    owner_username: user_id
  };
}

function executionRow(execution: TaskExecution): Record<string, unknown> {
  const { user_id, ...row } = execution;
  return { ...row, owner_username: user_id };
}

function conditionRow(condition: DailyCondition): Record<string, unknown> {
  const { user_id, ...row } = condition;
  return { ...row, owner_username: user_id };
}

class FakeLbsDatabase {
  tasks: Array<Record<string, unknown>>;
  exceptions: Array<Record<string, unknown>>;
  executions: Array<Record<string, unknown>>;
  conditions: Array<Record<string, unknown>>;
  config: Array<{ owner_username: string; key: string; value: string }>;
  nextExceptionId: number;
  nextExecutionId: number;
  conditionPointReads = 0;
  conditionRangeReads = 0;
  nowCounter = 0;

  constructor(seed?: LBSFixtureInput) {
    this.tasks = seed?.tasks.map(definitionRow) ?? [];
    this.exceptions = seed?.task_exceptions.map(exceptionRow) ?? [];
    this.executions = seed?.task_executions.map(executionRow) ?? [];
    this.conditions = seed?.daily_conditions.map(conditionRow) ?? [];
    this.config = seed?.system_config.map((row) => ({
      owner_username: row.user_id, key: row.key, value: row.value
    })) ?? [];
    this.nextExceptionId = Math.max(0, ...this.exceptions.map((row) => Number(row.id))) + 1;
    this.nextExecutionId = Math.max(0, ...this.executions.map((row) => Number(row.id))) + 1;
  }

  private now(): string {
    this.nowCounter += 1;
    return new Date(Date.UTC(2026, 6, 13, 0, 0, this.nowCounter)).toISOString();
  }

  private result(rows: Array<Record<string, unknown>>, rowCount = rows.length) {
    return Promise.resolve({ rows, rowCount });
  }

  query = async (rawSql: string, values: unknown[] = []) => {
    const sql = rawSql.replace(/\s+/g, " ").trim();

    if (sql.startsWith("SELECT key, value FROM lbs_user_config")) {
      return this.result(this.config.filter((row) => row.owner_username === values[0]));
    }

    if (sql.startsWith("SELECT owner_username, task_id") && sql.includes("FROM task_definitions")) {
      let rows = this.tasks.filter((row) => row.owner_username === values[0]);
      if (sql.includes("task_id = $2")) rows = rows.filter((row) => row.task_id === values[1]);
      if (sql.includes("context = $2")) rows = rows.filter((row) => row.context === values[1]);
      const activeMatch = /active = \$(\d+)/.exec(sql);
      if (activeMatch) rows = rows.filter((row) => row.active === values[Number(activeMatch[1]) - 1]);
      rows = [...rows].sort((left, right) =>
        String(left.created_at).localeCompare(String(right.created_at)) || String(left.task_id).localeCompare(String(right.task_id))
      );
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
        notes: values[24], external_sync_id: values[25], timezone: values[26], is_locked: values[27]
      };
      row.created_at = this.now();
      row.updated_at = row.created_at;
      this.tasks.push(row);
      return this.result([row], 1);
    }

    if (sql.startsWith("UPDATE task_definitions SET active = $3")) {
      const rows = this.tasks.filter((row) => row.owner_username === values[0] && (values[1] as string[]).includes(String(row.task_id)));
      for (const row of rows) { row.active = values[2]; row.updated_at = this.now(); }
      return this.result(rows, rows.length);
    }

    if (sql.startsWith("UPDATE task_definitions SET")) {
      const row = this.tasks.find((candidate) => candidate.owner_username === values[0] && candidate.task_id === values[1]);
      if (!row) return this.result([], 0);
      for (const match of sql.matchAll(/([a-z_]+) = \$(\d+)/g)) {
        if (match[1] !== "owner_username" && match[1] !== "task_id") row[match[1]] = values[Number(match[2]) - 1];
      }
      row.updated_at = this.now();
      return this.result([row], 1);
    }

    if (sql.startsWith("DELETE FROM task_definitions")) {
      const ids = sql.includes("ANY") ? values[1] as string[] : [values[1] as string];
      const before = this.tasks.length;
      this.tasks = this.tasks.filter((row) => row.owner_username !== values[0] || !ids.includes(String(row.task_id)));
      const removed = before - this.tasks.length;
      this.exceptions = this.exceptions.filter((row) => row.owner_username !== values[0] || !ids.includes(String(row.task_id)));
      this.executions = this.executions.filter((row) => row.owner_username !== values[0] || !ids.includes(String(row.task_id)));
      return this.result([], removed);
    }

    if (sql.startsWith("SELECT id, owner_username, task_id") && sql.includes("FROM task_rule_exceptions")) {
      let rows = this.exceptions.filter((row) => row.owner_username === values[0]);
      const predicates: Array<[RegExp, string]> = [
        [/task_id = \$(\d+)/, "task_id"], [/target_date >= \$(\d+)/, "start"], [/target_date <= \$(\d+)/, "end"]
      ];
      for (const [pattern, kind] of predicates) {
        const match = pattern.exec(sql);
        if (!match) continue;
        const value = values[Number(match[1]) - 1];
        rows = rows.filter((row) => kind === "task_id" ? row.task_id === value : kind === "start"
          ? String(row.target_date) >= String(value) : String(row.target_date) <= String(value));
      }
      rows = [...rows].sort((left, right) => String(left.target_date).localeCompare(String(right.target_date)) || Number(left.id) - Number(right.id));
      return this.result(rows);
    }

    if (sql.startsWith("INSERT INTO task_rule_exceptions")) {
      const row: Record<string, unknown> = {
        id: this.nextExceptionId++, owner_username: values[0], task_id: values[1], target_date: values[2],
        exception_type: values[3], override_load_value: values[4], start_time: values[5], end_time: values[6],
        notes: values[7], is_locked: values[8], created_at: this.now()
      };
      this.exceptions.push(row);
      return this.result([row], 1);
    }

    if (sql.startsWith("UPDATE task_rule_exceptions SET")) {
      const row = this.exceptions.find((candidate) => candidate.owner_username === values[0] && candidate.id === values[1]);
      if (!row) return this.result([], 0);
      for (const match of sql.matchAll(/([a-z_]+) = \$(\d+)/g)) row[match[1]] = values[Number(match[2]) - 1];
      return this.result([row], 1);
    }

    if (sql.startsWith("DELETE FROM task_rule_exceptions")) {
      const before = this.exceptions.length;
      this.exceptions = this.exceptions.filter((row) => row.owner_username !== values[0] || row.id !== values[1]);
      return this.result([], before - this.exceptions.length);
    }

    if (sql.startsWith("SELECT id, owner_username, task_id") && sql.includes("FROM task_executions")) {
      let rows = this.executions.filter((row) => row.owner_username === values[0]
        && String(row.target_date) >= String(values[1]) && String(row.target_date) <= String(values[2]));
      if (sql.includes("task_id = $4")) rows = rows.filter((row) => row.task_id === values[3]);
      rows = [...rows].sort((left, right) => String(left.target_date).localeCompare(String(right.target_date)) || String(left.task_id).localeCompare(String(right.task_id)));
      return this.result(rows);
    }

    if (sql.startsWith("INSERT INTO task_executions")) {
      let row = this.executions.find((candidate) => candidate.owner_username === values[0]
        && candidate.task_id === values[1] && candidate.target_date === values[2]);
      if (!row) {
        row = { id: this.nextExecutionId++, owner_username: values[0], task_id: values[1], target_date: values[2], created_at: this.now() };
        this.executions.push(row);
      }
      row.status = values[3]; row.progress = values[4]; row.actual_time = values[5];
      return this.result([row], 1);
    }

    if (sql.startsWith("DELETE FROM task_executions")) {
      const before = this.executions.length;
      this.executions = this.executions.filter((row) => row.owner_username !== values[0]
        || row.task_id !== values[1] || row.target_date !== values[2]);
      return this.result([], before - this.executions.length);
    }

    if (sql.startsWith("SELECT owner_username, target_date") && sql.includes("FROM daily_conditions")) {
      if (sql.includes("target_date >= $2")) {
        this.conditionRangeReads += 1;
        const rows = this.conditions
          .filter((candidate) => candidate.owner_username === values[0]
            && String(candidate.target_date) >= String(values[1])
            && String(candidate.target_date) <= String(values[2]))
          .sort((left, right) => String(left.target_date).localeCompare(String(right.target_date)));
        return this.result(rows);
      }
      this.conditionPointReads += 1;
      const row = this.conditions.find((candidate) => candidate.owner_username === values[0] && candidate.target_date === values[1]);
      return this.result(row ? [row] : []);
    }

    if (sql.startsWith("INSERT INTO daily_conditions")) {
      let row = this.conditions.find((candidate) => candidate.owner_username === values[0] && candidate.target_date === values[1]);
      if (!row) { row = { owner_username: values[0], target_date: values[1] }; this.conditions.push(row); }
      row.cognitive_fatigue = values[2]; row.physical_fatigue = values[3]; row.note = values[4]; row.updated_at = this.now();
      return this.result([row], 1);
    }

    if (sql.startsWith("DELETE FROM daily_conditions")) {
      const before = this.conditions.length;
      this.conditions = this.conditions.filter((row) => row.owner_username !== values[0] || row.target_date !== values[1]);
      return this.result([], before - this.conditions.length);
    }

    throw new Error(`Unhandled fake SQL: ${sql}`);
  };

  asDatabase(): LbsStoreDatabase {
    return { query: this.query } as LbsStoreDatabase;
  }
}

function queryOne(call: ManifestCall, name: string): string | undefined {
  return call.query.find((entry) => entry.name === name)?.value;
}

function queryStatuses(call: ManifestCall): TaskStatus[] {
  return call.query.filter((entry) => entry.name === "status").map((entry) => entry.value as TaskStatus);
}

function requiredQuery(call: ManifestCall, name: string): string {
  const value = queryOne(call, name);
  if (!value) throw new Error(`${call.file} lacks ${name}`);
  return value;
}

async function invokeGolden(backend: LocalLbsBackend, call: ManifestCall): Promise<unknown> {
  if (call.path === "/api/lbs/tasks") {
    const active = queryOne(call, "active");
    return backend.listTasks(undefined, active === undefined ? undefined : active === "true");
  }
  if (call.path === "/api/lbs/schedule") return backend.getSchedule(requiredQuery(call, "start_date"), requiredQuery(call, "end_date"));
  if (call.path === "/api/lbs/dashboard") return backend.getDashboard(requiredQuery(call, "start_date"));
  if (call.path === "/api/lbs/heatmap") return backend.getHeatmap(requiredQuery(call, "start"), requiredQuery(call, "end"), queryStatuses(call));
  if (call.path === "/api/lbs/trends") return backend.getTrends(Number(requiredQuery(call, "weeks")), requiredQuery(call, "start_date"), queryStatuses(call));
  if (call.path === "/api/lbs/context-distribution") return backend.getContextDistribution(requiredQuery(call, "start"), requiredQuery(call, "end"), queryStatuses(call));
  if (call.path === "/api/lbs/exceptions") return backend.listExceptions(undefined, queryOne(call, "start_date"), queryOne(call, "end_date"));
  const calculate = /^\/api\/lbs\/calculate\/(.+)$/.exec(call.path);
  if (calculate) return backend.calculateLoad(calculate[1], queryStatuses(call).length ? queryStatuses(call) : undefined);
  const resolved = /^\/api\/lbs\/tasks\/([^/]+)\/resolved$/.exec(call.path);
  if (resolved) return backend.resolveTask(resolved[1], requiredQuery(call, "target_date"));
  const history = /^\/api\/lbs\/tasks\/([^/]+)\/history$/.exec(call.path);
  if (history) return backend.getTaskHistory(history[1], requiredQuery(call, "start_date"), requiredQuery(call, "end_date"));
  const task = /^\/api\/lbs\/tasks\/([^/]+)$/.exec(call.path);
  if (task) return backend.getTask(task[1]);
  throw new Error(`Unhandled golden call: ${call.path}`);
}

function excludeDashboardToday(file: string, value: unknown): unknown {
  if (file !== "dashboard_reference_week.json" || !value || typeof value !== "object" || Array.isArray(value)) return value;
  const { today: _today, ...stable } = value as Record<string, unknown>;
  return stable;
}

describe("LocalLbsBackend Python golden parity", () => {
  assert.equal(manifest.calls.length, manifest.golden_count);
  for (const call of manifest.calls) {
    it(`matches ${call.file}`, async () => {
      const database = new FakeLbsDatabase(fixture);
      const backend = new LocalLbsBackend(fixture.reference_user_id, database.asDatabase());
      const actual = excludeDashboardToday(call.file, await invokeGolden(backend, call));
      const expected = excludeDashboardToday(call.file, readJson<unknown>(call.file));
      assert.deepEqual(actual, expected);
    });
  }
});

describe("LocalLbsBackend mutations", () => {
  it("supports create, get, update, complete, history, and delete", async () => {
    const database = new FakeLbsDatabase();
    const backend = new LocalLbsBackend(" Owner-A ", database.asDatabase());
    const created = await backend.createTask({
      task_id: "CLIENT-ID-IGNORED", task_name: "Lifecycle", context: "work", base_load_score: 2.5,
      active: false, rule_type: "ONCE", due_date: "2026-07-13", timezone: "UTC"
    });
    assert.match(String(created.task_id), /^T-[0-9A-F]{8}$/);
    assert.notEqual(created.task_id, "CLIENT-ID-IGNORED");
    assert.equal(created.active, true);
    assert.equal((await backend.getTask(String(created.task_id))).task_name, "Lifecycle");
    const updated = await backend.updateTask(String(created.task_id), { task_name: "Updated", active: false });
    assert.equal(updated.task_name, "Updated");
    assert.equal(updated.active, false);
    assert.deepEqual(await backend.completeTask(String(created.task_id), "2026-07-13", "done", 75, 42), {
      message: "Task execution updated: TaskStatus.DONE", status: "done"
    });
    assert.deepEqual(await backend.getTaskHistory(String(created.task_id), "2026-07-01", "2026-07-31"), [
      { target_date: "2026-07-13", status: "done" }
    ]);
    assert.equal(database.executions[0].progress, 75);
    assert.equal(database.executions[0].actual_time, 42);
    assert.deepEqual(await backend.completeTask(String(created.task_id), "2026-07-13", "todo"), {
      message: "Task execution updated: TaskStatus.TODO", status: "todo"
    });
    assert.equal(database.executions.length, 0);
    assert.deepEqual(await backend.getTaskHistory(String(created.task_id), "2026-07-01", "2026-07-31"), []);
    await backend.deleteTask(String(created.task_id));
    await assert.rejects(() => backend.getTask(String(created.task_id)), LbsNotFoundError);
  });

  it("supports exception CRUD with exception-priority locking", async () => {
    const database = new FakeLbsDatabase();
    const backend = new LocalLbsBackend("owner", database.asDatabase());
    const task = await backend.createTask({ task_name: "Exceptions", context: "work", base_load_score: 1, rule_type: "WEEKLY" });
    const created = await backend.createException({
      task_id: task.task_id, target_date: "2026-07-19", exception_type: "FORCE_DO", notes: "created"
    });
    const id = Number(created.id);
    const updated = await backend.updateException(id, { exception_type: "RESCHEDULE", start_time: "10:00:00", is_locked: true });
    assert.equal(updated.exception_type, "RESCHEDULE");
    await assert.rejects(() => backend.deleteException(id), /is locked/);
    await backend.deleteException(id, true);
    await assert.rejects(() => backend.updateException(id, {}), LbsNotFoundError);
  });

  it("supports condition CRUD and clamps fatigue values", async () => {
    const backend = new LocalLbsBackend("owner", new FakeLbsDatabase().asDatabase());
    const condition = await backend.createCondition({ date: "2026-07-13", cognitive_fatigue: 12, physical_fatigue: -4, note: "clamp" });
    assert.equal(condition.cognitive_fatigue, 5);
    assert.equal(condition.physical_fatigue, 0);
    assert.equal((await backend.getCondition("2026-07-13")).note, "clamp");
    await backend.deleteCondition("2026-07-13");
    assert.equal((await backend.getCondition("2026-07-13")).cognitive_fatigue, 0);
  });

  it("loads conditions for engine ranges with one inclusive range query", async () => {
    const database = new FakeLbsDatabase(fixture);
    const backend = new LocalLbsBackend(fixture.reference_user_id, database.asDatabase());
    await backend.getSchedule("2026-06-29", "2026-07-05");
    assert.equal(database.conditionRangeReads, 1);
    assert.equal(database.conditionPointReads, 0);
  });

  it("round-trips every recurrence rule field through CSV, including Sunday=7", async () => {
    const sourceDb = new FakeLbsDatabase();
    const source = new LocalLbsBackend("owner", sourceDb.asDatabase());
    await source.createTask({
      task_name: "Sunday, quoted", context: "review", base_load_score: 3.25, rule_type: "MONTHLY_NTH_WEEKDAY",
      due_date: null, mon: false, tue: false, wed: false, thu: false, fri: false, sat: false, sun: true,
      interval_days: 9, anchor_date: "2026-07-01", month_day: 31, nth_in_month: -1, weekday_mon1: 7,
      start_date: "2026-01-01", end_date: "2027-12-31", start_time: "09:30:00", end_time: "11:00:00",
      notes: "comma, quote \" and\nnewline", external_sync_id: "external-1", is_locked: true, timezone: "Asia/Tokyo"
    });
    const csv = await source.exportTasksCsv();
    const targetDb = new FakeLbsDatabase();
    const target = new LocalLbsBackend("owner", targetDb.asDatabase());
    assert.deepEqual(await target.uploadTasksCsv(csv), { message: "Successfully imported 1 tasks", imported: 1 });
    const [roundTripped] = await target.listTasks();
    for (const field of [
      "task_name", "context", "base_load_score", "active", "rule_type", "due_date", "mon", "tue", "wed", "thu",
      "fri", "sat", "sun", "interval_days", "anchor_date", "month_day", "nth_in_month", "weekday_mon1",
      "start_date", "end_date", "start_time", "end_time", "notes", "external_sync_id", "is_locked", "timezone"
    ]) assert.deepEqual(roundTripped[field], (await source.listTasks())[0][field], field);
    assert.equal(roundTripped.weekday_mon1, 7);
  });
});
