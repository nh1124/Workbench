import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_AUTOMATION_POLICY, DEFAULT_COLLECTION_SETTINGS } from "../types.js";

process.env.ANALYSER_DB_HOST ??= "127.0.0.1";
process.env.ANALYSER_DB_PORT ??= "5551";
process.env.ANALYSER_DB_NAME ??= "test";
process.env.ANALYSER_DB_USER ??= "test";
process.env.ANALYSER_DB_PASSWORD ??= "test";

const {
  claimDueRoutineWithPool,
  completeRunWithPool,
  createRoutineWithPool,
  deleteRoutineWithPool,
  failRunWithPool,
  heartbeatRunWithPool,
  pullForRunWithPool,
  updateRoutineWithPool
} = await import("../stores/routines.js");

type Result = { rows: unknown[]; rowCount?: number };
type Call = { text: string; values?: unknown[] };

function fakePool(responses: Result[]) {
  const calls: Call[] = [];
  const pool = {
    calls,
    async query<Row = never>(text: string, values?: unknown[]) {
      calls.push({ text, values });
      return (responses.shift() ?? { rows: [] }) as { rows: Row[]; rowCount?: number };
    },
    async connect() {
      return { query: pool.query, release() { /* fake client */ } };
    }
  };
  return pool;
}

const timestamp = "2026-07-20T00:00:00.000Z";

function routineRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "routine-1",
    key: "daily-work-summary",
    name: "Daily work summary",
    skill_key: "workbench-analyser-cycle",
    skill_version: null,
    schedule_kind: "cron",
    schedule_expr: "0 9 * * *",
    timezone: "Asia/Tokyo",
    enabled: true,
    next_run_at: timestamp,
    committed_cursor: "7",
    max_retries: 3,
    backoff_minutes: 15,
    version: 2,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides
  };
}

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    routine_id: "routine-1",
    status: "claimed",
    holder: "holder-1",
    lease_expires_at: "2026-07-20T01:00:00.000Z",
    policy_snapshot: { collectionSettings: DEFAULT_COLLECTION_SETTINGS, automationPolicy: DEFAULT_AUTOMATION_POLICY },
    pending_read_cursor: "7",
    attempt: 1,
    error_summary: null,
    started_at: timestamp,
    finished_at: null,
    ...overrides
  };
}

function lockedRow(overrides: Record<string, unknown> = {}) {
  const routine = routineRow();
  const run = runRow();
  return {
    current_time: timestamp,
    run_id: run.id,
    run_routine_id: run.routine_id,
    run_status: run.status,
    run_holder: run.holder,
    run_lease_expires_at: run.lease_expires_at,
    run_policy_snapshot: run.policy_snapshot,
    run_pending_read_cursor: run.pending_read_cursor,
    run_attempt: run.attempt,
    run_error_summary: run.error_summary,
    run_started_at: run.started_at,
    run_finished_at: run.finished_at,
    routine_id: routine.id,
    routine_key: routine.key,
    routine_name: routine.name,
    routine_skill_key: routine.skill_key,
    routine_skill_version: routine.skill_version,
    routine_schedule_kind: routine.schedule_kind,
    routine_schedule_expr: routine.schedule_expr,
    routine_timezone: routine.timezone,
    routine_enabled: routine.enabled,
    routine_next_run_at: routine.next_run_at,
    routine_committed_cursor: routine.committed_cursor,
    routine_max_retries: routine.max_retries,
    routine_backoff_minutes: routine.backoff_minutes,
    routine_version: routine.version,
    routine_created_at: routine.created_at,
    routine_updated_at: routine.updated_at,
    ...overrides
  };
}

describe("analyser routine claiming", () => {
  it("expires stale leases before locking due routines and commits a null claim", async () => {
    const pool = fakePool([{ rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }]);
    assert.equal(await claimDueRoutineWithPool(pool, "owner-1", { holder: "holder-1" }), null);
    assert.equal(pool.calls[0].text, "BEGIN");
    assert.match(pool.calls[1].text, /UPDATE analyser_runs/);
    assert.match(pool.calls[1].text, /lease_expires_at <= NOW\(\)/);
    assert.match(pool.calls[2].text, /FOR UPDATE SKIP LOCKED/);
    assert.match(pool.calls[2].text, /NOT EXISTS/);
    assert.equal(pool.calls.at(-1)?.text, "COMMIT");
  });

  it("initializes the run pending cursor from the committed cursor", async () => {
    const claimed = runRow();
    const pool = fakePool([
      { rows: [] },
      { rows: [] },
      { rows: [routineRow()] },
      { rows: [] },
      { rows: [] },
      { rows: [{ attempt: 1 }] },
      { rows: [claimed] },
      { rows: [] }
    ]);
    const result = await claimDueRoutineWithPool(pool, "owner-1", { holder: "holder-1" });
    assert.equal(result?.run.pendingReadCursor, "7");
    const insert = pool.calls.find((call) => /INSERT INTO analyser_runs/.test(call.text));
    assert.equal(insert?.values?.[5], "7");
    assert.deepEqual(result?.collectionSettings, DEFAULT_COLLECTION_SETTINGS);
    assert.deepEqual(result?.automationPolicy, DEFAULT_AUTOMATION_POLICY);
  });
});

describe("analyser active runs", () => {
  it("returns RUN_NOT_ACTIVE when heartbeat updates no row", async () => {
    await assert.rejects(
      heartbeatRunWithPool(fakePool([{ rows: [] }]), "owner-1", "run-1", "holder-1"),
      (error: unknown) => (error as { status?: number }).status === 409
        && (error as { code?: string }).code === "RUN_NOT_ACTIVE"
    );
  });

  it("pulls after pending and advances only pending_read_cursor", async () => {
    const observation = {
      seq: "9", id: "observation-1", source: "workbench_change", action: "updated", actor_kind: "user",
      machine_id: null, project_id: null, occurred_at: timestamp, received_at: timestamp,
      resource_refs: [], metadata: {}, source_event_id: null, dedupe_key: "event-1",
      expires_at: "2026-08-20T00:00:00.000Z"
    };
    const pool = fakePool([
      { rows: [] }, { rows: [runRow()] }, { rows: [observation] }, { rows: [] }, { rows: [] }
    ]);
    const result = await pullForRunWithPool(pool, "owner-1", "run-1", "holder-1", 25);
    assert.equal(result.pendingReadCursor, "9");
    const pull = pool.calls.find((call) => /FROM analyser_observations/.test(call.text));
    assert.deepEqual(pull?.values, ["owner-1", "7", 25]);
    const update = pool.calls.find((call) => /UPDATE analyser_runs SET pending_read_cursor/.test(call.text));
    assert.equal(update?.values?.[2], "9");
    assert.doesNotMatch(update?.text ?? "", /committed_cursor/);
  });

  it("completes by committing pending and passing the recomputed next run", async () => {
    const next = new Date("2026-07-21T00:00:00.000Z");
    let schedulerFrom: Date | undefined;
    const computeNext = (_kind: "interval" | "cron", _expr: string, _timezone: string, from: Date) => {
      schedulerFrom = from;
      return next;
    };
    const finished = runRow({ status: "completed", finished_at: timestamp });
    const updatedRoutine = routineRow({ committed_cursor: "9", next_run_at: next.toISOString() });
    const pool = fakePool([
      { rows: [] }, { rows: [lockedRow({ run_pending_read_cursor: "9" })] },
      { rows: [finished] }, { rows: [updatedRoutine] }, { rows: [] }
    ]);
    const result = await completeRunWithPool(pool, "owner-1", "run-1", "holder-1", { now: new Date(timestamp) }, { computeNext });
    assert.equal(schedulerFrom?.toISOString(), timestamp);
    assert.equal(result.routine.nextRunAt, next.toISOString());
    const update = pool.calls.find((call) => /UPDATE analyser_routines SET/.test(call.text));
    assert.match(update?.text ?? "", /GREATEST\(committed_cursor, \$2::bigint\)/);
    assert.equal((update?.values?.[2] as Date).toISOString(), next.toISOString());
  });

  it("fails without updating committed_cursor and uses linear retry backoff", async () => {
    const now = new Date(timestamp);
    const failed = runRow({ status: "failed", finished_at: timestamp, error_summary: "boom" });
    const pool = fakePool([
      { rows: [] }, { rows: [lockedRow({ run_attempt: 2, routine_backoff_minutes: 15, routine_max_retries: 3 })] },
      { rows: [failed] }, { rows: [{ next_run_at: "2026-07-20T00:30:00.000Z", updated_at: timestamp }] }, { rows: [] }
    ]);
    const result = await failRunWithPool(pool, "owner-1", "run-1", "holder-1", { errorSummary: "boom", now });
    assert.equal(result.routine.committedCursor, "7");
    assert.equal(result.routine.nextRunAt, "2026-07-20T00:30:00.000Z");
    const routineUpdate = pool.calls.find((call) => /UPDATE analyser_routines SET/.test(call.text));
    assert.doesNotMatch(routineUpdate?.text ?? "", /committed_cursor/);
    assert.equal((routineUpdate?.values?.[1] as Date).toISOString(), "2026-07-20T00:30:00.000Z");
  });

  it("falls back to the injected scheduler after retries are exhausted", async () => {
    const scheduled = new Date("2026-07-22T00:00:00.000Z");
    let called = false;
    const computeNext = () => { called = true; return scheduled; };
    const pool = fakePool([
      { rows: [] }, { rows: [lockedRow({ run_attempt: 3, routine_max_retries: 3 })] },
      { rows: [runRow({ status: "failed", finished_at: timestamp, error_summary: "boom" })] },
      { rows: [{ next_run_at: scheduled.toISOString(), updated_at: timestamp }] }, { rows: [] }
    ]);
    await failRunWithPool(pool, "owner-1", "run-1", "holder-1", { errorSummary: "boom", now: new Date(timestamp) }, { computeNext });
    assert.equal(called, true);
    const routineUpdate = pool.calls.find((call) => /UPDATE analyser_routines SET/.test(call.text));
    assert.equal((routineUpdate?.values?.[1] as Date).toISOString(), scheduled.toISOString());
  });
});

describe("analyser routine updates", () => {
  it("returns VERSION_CONFLICT before attempting an update", async () => {
    const pool = fakePool([{ rows: [routineRow({ version: 3 })] }]);
    await assert.rejects(
      updateRoutineWithPool(pool, "owner-1", "daily-work-summary", { expectedVersion: 2 }),
      (error: unknown) => (error as { status?: number }).status === 409
        && (error as { code?: string }).code === "VERSION_CONFLICT"
    );
    assert.equal(pool.calls.length, 1);
  });

  it("recomputes next_run_at when the schedule changes", async () => {
    const next = new Date("2026-07-23T00:00:00.000Z");
    let called = false;
    const computeNext = () => { called = true; return next; };
    const changed = routineRow({ schedule_expr: "0 10 * * *", next_run_at: next.toISOString(), version: 3 });
    const pool = fakePool([{ rows: [routineRow()] }, { rows: [changed] }]);
    const result = await updateRoutineWithPool(
      pool,
      "owner-1",
      "daily-work-summary",
      { scheduleExpr: "0 10 * * *", expectedVersion: 2 },
      { computeNext, now: new Date(timestamp) }
    );
    assert.equal(called, true);
    assert.equal(result.nextRunAt, next.toISOString());
    assert.equal((pool.calls[1].values?.[8] as Date).toISOString(), next.toISOString());
  });
});

describe("createRoutineWithPool", () => {
  const input = {
    key: "custom-weekly",
    name: "Custom weekly",
    skillKey: "workbench-analyser-cycle",
    scheduleKind: "cron" as const,
    scheduleExpr: "0 9 * * 1",
    timezone: "Asia/Tokyo"
  };

  it("inserts a new routine and computes next_run_at from the schedule", async () => {
    const next = new Date("2026-07-27T00:00:00.000Z");
    let called = false;
    const computeNext = () => { called = true; return next; };
    const created = routineRow({ key: "custom-weekly", name: "Custom weekly", schedule_expr: "0 9 * * 1", version: 1 });
    const pool = fakePool([{ rows: [created] }]);
    const result = await createRoutineWithPool(pool, "owner-1", input, { computeNext, now: new Date(timestamp) });
    assert.equal(called, true);
    assert.equal(result.key, "custom-weekly");
    assert.match(pool.calls[0].text, /INSERT INTO analyser_routines/);
    assert.match(pool.calls[0].text, /ON CONFLICT \(service_account_id, key\) DO NOTHING/);
    assert.equal((pool.calls[0].values?.[9] as Date).toISOString(), next.toISOString());
  });

  it("rejects a duplicate key with 409", async () => {
    const pool = fakePool([{ rows: [] }]);
    await assert.rejects(
      () => createRoutineWithPool(pool, "owner-1", input, { computeNext: () => new Date(timestamp) }),
      (error: unknown) => (error as { status?: number; code?: string }).status === 409
        && (error as { code?: string }).code === "ROUTINE_KEY_EXISTS"
    );
  });

  it("rejects an invalid schedule before touching the database", async () => {
    const pool = fakePool([]);
    await assert.rejects(
      () => createRoutineWithPool(pool, "owner-1", { ...input, scheduleExpr: "not a cron" }),
      (error: unknown) => (error as { status?: number }).status === 400
    );
    assert.equal(pool.calls.length, 0);
  });

  it("leaves next_run_at null when created disabled", async () => {
    const created = routineRow({ key: "custom-weekly", enabled: false, next_run_at: null });
    const pool = fakePool([{ rows: [created] }]);
    let called = false;
    await createRoutineWithPool(pool, "owner-1", { ...input, enabled: false }, { computeNext: () => { called = true; return new Date(timestamp); } });
    assert.equal(called, false);
    assert.equal(pool.calls[0].values?.[9], null);
  });
});

describe("deleteRoutineWithPool", () => {
  it("deletes a routine with no active run", async () => {
    const pool = fakePool([{ rows: [] }, { rows: [{ id: "routine-1" }] }]);
    await deleteRoutineWithPool(pool, "owner-1", "custom-weekly");
    assert.match(pool.calls[0].text, /status IN \('claimed','processing'\)/);
    assert.match(pool.calls[1].text, /DELETE FROM analyser_routines/);
  });

  it("refuses to delete while an active run holds a live lease (409)", async () => {
    const pool = fakePool([{ rows: [{ id: "run-1" }] }]);
    await assert.rejects(
      () => deleteRoutineWithPool(pool, "owner-1", "daily-work-summary"),
      (error: unknown) => (error as { status?: number; code?: string }).status === 409
        && (error as { code?: string }).code === "ROUTINE_HAS_ACTIVE_RUN"
    );
    assert.equal(pool.calls.length, 1);
  });

  it("returns 404 when the routine does not exist", async () => {
    const pool = fakePool([{ rows: [] }, { rows: [] }]);
    await assert.rejects(
      () => deleteRoutineWithPool(pool, "owner-1", "missing"),
      (error: unknown) => (error as { status?: number; code?: string }).status === 404
        && (error as { code?: string }).code === "ROUTINE_NOT_FOUND"
    );
  });
});
