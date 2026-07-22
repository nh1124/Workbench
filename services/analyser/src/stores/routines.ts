import { getAnalyserPool } from "../db.js";
import { computeNextRunAt, parseSchedule, type ScheduleKind } from "../schedule.js";
import { AnalyserServiceError } from "../serviceError.js";
import type {
  AutomationPolicy,
  ClaimResult,
  CollectionSettings,
  ObservationRecord,
  RoutineRecord,
  RunRecord
} from "../types.js";
import type { AnalyserQueryPool } from "./machines.js";
import { pullObservationsAfterWithPool } from "./observations.js";
import {
  getEffectiveAutomationPolicyWithPool,
  getEffectiveCollectionSettingsWithPool,
  type AnalyserTransactionPool
} from "./policies.js";

type RoutineRow = {
  id: string;
  key: string;
  name: string;
  skill_key: string;
  skill_version: string | null;
  schedule_kind: ScheduleKind;
  schedule_expr: string;
  timezone: string;
  enabled: boolean;
  skill_missing: boolean;
  next_run_at: Date | string | null;
  committed_cursor: string | number | bigint;
  max_retries: number;
  backoff_minutes: number;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
};

type RunRow = {
  id: string;
  routine_id: string;
  routine_key?: string | null;
  status: RunRecord["status"];
  holder: string;
  lease_expires_at: Date | string;
  policy_snapshot: RunRecord["policySnapshot"];
  pending_read_cursor: string | number | bigint;
  attempt: number;
  error_summary: string | null;
  started_at: Date | string;
  finished_at: Date | string | null;
};

type LockedRunRoutineRow = {
  current_time: Date | string;
  run_id: string;
  run_routine_id: string;
  run_status: RunRecord["status"];
  run_holder: string;
  run_lease_expires_at: Date | string;
  run_policy_snapshot: RunRecord["policySnapshot"];
  run_pending_read_cursor: string | number | bigint;
  run_attempt: number;
  run_error_summary: string | null;
  run_started_at: Date | string;
  run_finished_at: Date | string | null;
  routine_id: string;
  routine_key: string;
  routine_name: string;
  routine_skill_key: string;
  routine_skill_version: string | null;
  routine_schedule_kind: ScheduleKind;
  routine_schedule_expr: string;
  routine_timezone: string;
  routine_enabled: boolean;
  routine_skill_missing: boolean;
  routine_next_run_at: Date | string | null;
  routine_committed_cursor: string | number | bigint;
  routine_max_retries: number;
  routine_backoff_minutes: number;
  routine_version: number;
  routine_created_at: Date | string;
  routine_updated_at: Date | string;
};

export interface UpdateRoutinePatch {
  name?: string;
  enabled?: boolean;
  scheduleKind?: ScheduleKind;
  scheduleExpr?: string;
  timezone?: string;
  maxRetries?: number;
  backoffMinutes?: number;
  skillVersion?: string;
  expectedVersion?: number;
}

export interface RoutineStatusSummary {
  key: string;
  enabled: boolean;
  skillMissing: boolean;
  nextRunAt?: string;
  lastCompletedAt?: string;
  lastFailedAt?: string;
  lastErrorSummary?: string;
  activeRun: { id: string; holder: string; leaseExpiresAt: string } | null;
}

type SchedulerOptions = {
  computeNext?: typeof computeNextRunAt;
  now?: Date;
};

const ROUTINE_COLUMNS = `id, key, name, skill_key, skill_version, schedule_kind, schedule_expr,
  timezone, enabled, skill_missing, next_run_at, committed_cursor, max_retries, backoff_minutes,
  version, created_at, updated_at`;
const RUN_COLUMNS = `id, routine_id, status, holder, lease_expires_at, policy_snapshot,
  pending_read_cursor, attempt, error_summary, started_at, finished_at`;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRoutine(row: RoutineRow): RoutineRecord {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    skillKey: row.skill_key,
    ...(row.skill_version === null ? {} : { skillVersion: row.skill_version }),
    scheduleKind: row.schedule_kind,
    scheduleExpr: row.schedule_expr,
    timezone: row.timezone,
    enabled: row.enabled,
    skillMissing: row.skill_missing,
    ...(row.next_run_at === null ? {} : { nextRunAt: iso(row.next_run_at) }),
    committedCursor: String(row.committed_cursor),
    maxRetries: row.max_retries,
    backoffMinutes: row.backoff_minutes,
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function mapRun(row: RunRow, routineKey?: string): RunRecord {
  const key = routineKey ?? row.routine_key ?? undefined;
  return {
    id: row.id,
    routineId: row.routine_id,
    ...(key ? { routineKey: key } : {}),
    status: row.status,
    holder: row.holder,
    leaseExpiresAt: iso(row.lease_expires_at),
    policySnapshot: row.policy_snapshot,
    pendingReadCursor: String(row.pending_read_cursor),
    attempt: row.attempt,
    ...(row.error_summary === null ? {} : { errorSummary: row.error_summary }),
    startedAt: iso(row.started_at),
    ...(row.finished_at === null ? {} : { finishedAt: iso(row.finished_at) })
  };
}

function routineFromLocked(row: LockedRunRoutineRow): RoutineRecord {
  return mapRoutine({
    id: row.routine_id,
    key: row.routine_key,
    name: row.routine_name,
    skill_key: row.routine_skill_key,
    skill_version: row.routine_skill_version,
    schedule_kind: row.routine_schedule_kind,
    schedule_expr: row.routine_schedule_expr,
    timezone: row.routine_timezone,
    enabled: row.routine_enabled,
    skill_missing: row.routine_skill_missing,
    next_run_at: row.routine_next_run_at,
    committed_cursor: row.routine_committed_cursor,
    max_retries: row.routine_max_retries,
    backoff_minutes: row.routine_backoff_minutes,
    version: row.routine_version,
    created_at: row.routine_created_at,
    updated_at: row.routine_updated_at
  });
}

function runFromLocked(row: LockedRunRoutineRow): RunRecord {
  return mapRun({
    id: row.run_id,
    routine_id: row.run_routine_id,
    routine_key: row.routine_key,
    status: row.run_status,
    holder: row.run_holder,
    lease_expires_at: row.run_lease_expires_at,
    policy_snapshot: row.run_policy_snapshot,
    pending_read_cursor: row.run_pending_read_cursor,
    attempt: row.run_attempt,
    error_summary: row.run_error_summary,
    started_at: row.run_started_at,
    finished_at: row.run_finished_at
  });
}

function validateInteger(value: number | undefined, minimum: number, maximum: number, label: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < minimum || value > maximum)) {
    throw new AnalyserServiceError(400, "INVALID_ROUTINE", `${label} must be between ${minimum} and ${maximum}`);
  }
}

function validateLeaseSeconds(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new AnalyserServiceError(400, "INVALID_LEASE", "leaseSeconds must be a positive integer");
  }
}

async function inTransaction<T>(pool: AnalyserTransactionPool, operation: (client: AnalyserQueryPool) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const SEEDED_ROUTINES = [
  ["daily-work-summary", "Daily work summary", "workbench-analyser-cycle", "30 23 * * *"],
  ["progress-record-maintenance", "Progress record maintenance", "workbench-analyser-cycle", "0 6 * * *"],
  ["artifact-classification", "Artifact classification", "workbench-analyser-cycle", "0 7 * * *"],
  ["workbench-knowledge-maintenance", "Workbench knowledge maintenance", "workbench-maintenance", "0 5 * * *"],
  ["weekly-workbench-digest", "Weekly Workbench digest", "workbench-maintenance", "0 8 * * 0"],
  ["agent-skills-materialization", "Agent skills materialization", "workbench-agent-skills-materialize", "15 6 * * *"]
] as const;

export async function seedRoutines(owner: string, options: SchedulerOptions = {}): Promise<void> {
  return seedRoutinesWithPool(getAnalyserPool(), owner, options);
}

export async function seedRoutinesWithPool(
  pool: AnalyserQueryPool,
  owner: string,
  options: SchedulerOptions = {}
): Promise<void> {
  const now = options.now ?? new Date();
  const computeNext = options.computeNext ?? computeNextRunAt;
  const values: unknown[] = [owner];
  const tuples = SEEDED_ROUTINES.map(([key, name, skillKey, expr]) => {
    const start = values.length + 1;
    values.push(key, name, skillKey, expr, computeNext("cron", expr, "Asia/Tokyo", now));
    return `($1, $${start}, $${start + 1}, $${start + 2}, 'cron', $${start + 3}, 'Asia/Tokyo', TRUE, $${start + 4})`;
  });
  await pool.query(`INSERT INTO analyser_routines
    (service_account_id, key, name, skill_key, schedule_kind, schedule_expr, timezone, enabled, next_run_at)
    VALUES ${tuples.join(",\n      ")}
    ON CONFLICT (service_account_id, key) DO NOTHING`, values);
}

export interface CreateRoutineInput {
  key: string;
  name: string;
  skillKey: string;
  skillVersion?: string;
  scheduleKind: ScheduleKind;
  scheduleExpr: string;
  timezone: string;
  enabled?: boolean;
  maxRetries?: number;
  backoffMinutes?: number;
}

export async function createRoutine(
  owner: string,
  input: CreateRoutineInput,
  options: SchedulerOptions = {}
): Promise<RoutineRecord> {
  return createRoutineWithPool(getAnalyserPool(), owner, input, options);
}

export async function createRoutineWithPool(
  pool: AnalyserQueryPool,
  owner: string,
  input: CreateRoutineInput,
  options: SchedulerOptions = {}
): Promise<RoutineRecord> {
  validateInteger(input.maxRetries, 0, 10, "maxRetries");
  validateInteger(input.backoffMinutes, 1, 1_440, "backoffMinutes");
  parseSchedule(input.scheduleKind, input.scheduleExpr, input.timezone);
  const enabled = input.enabled ?? true;
  const nextRunAt = enabled
    ? (options.computeNext ?? computeNextRunAt)(input.scheduleKind, input.scheduleExpr, input.timezone, options.now ?? new Date())
    : null;
  const result = await pool.query<RoutineRow>(`INSERT INTO analyser_routines
      (service_account_id, key, name, skill_key, skill_version, schedule_kind, schedule_expr,
        timezone, enabled, next_run_at, max_retries, backoff_minutes)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT (service_account_id, key) DO NOTHING
    RETURNING ${ROUTINE_COLUMNS}`, [
    owner,
    input.key,
    input.name,
    input.skillKey,
    input.skillVersion ?? null,
    input.scheduleKind,
    input.scheduleExpr,
    input.timezone,
    enabled,
    nextRunAt,
    input.maxRetries ?? 3,
    input.backoffMinutes ?? 15
  ]);
  if (!result.rows[0]) throw new AnalyserServiceError(409, "ROUTINE_KEY_EXISTS", "A routine with this key already exists");
  return mapRoutine(result.rows[0]);
}

export async function deleteRoutine(owner: string, key: string): Promise<void> {
  return deleteRoutineWithPool(getAnalyserPool(), owner, key);
}

export async function deleteRoutineWithPool(pool: AnalyserQueryPool, owner: string, key: string): Promise<void> {
  const active = await pool.query<{ id: string }>(`SELECT run.id
    FROM analyser_runs run
    JOIN analyser_routines routine ON routine.id = run.routine_id
    WHERE routine.service_account_id = $1 AND routine.key = $2
      AND run.status IN ('claimed','processing') AND run.lease_expires_at > NOW()
    LIMIT 1`, [owner, key]);
  if (active.rows[0]) {
    throw new AnalyserServiceError(409, "ROUTINE_HAS_ACTIVE_RUN", "Routine has an active run; wait for it to finish or fail");
  }
  const result = await pool.query<{ id: string }>(`DELETE FROM analyser_routines
    WHERE service_account_id = $1 AND key = $2
    RETURNING id`, [owner, key]);
  if (!result.rows[0]) throw new AnalyserServiceError(404, "ROUTINE_NOT_FOUND", "Routine not found");
}

export async function listRoutines(owner: string): Promise<RoutineRecord[]> {
  return listRoutinesWithPool(getAnalyserPool(), owner);
}

export async function listRoutinesWithPool(pool: AnalyserQueryPool, owner: string): Promise<RoutineRecord[]> {
  const result = await pool.query<RoutineRow>(`SELECT ${ROUTINE_COLUMNS}
    FROM analyser_routines
    WHERE service_account_id = $1
    ORDER BY key`, [owner]);
  return result.rows.map(mapRoutine);
}

export async function updateRoutine(
  owner: string,
  key: string,
  patch: UpdateRoutinePatch,
  options: SchedulerOptions = {}
): Promise<RoutineRecord> {
  return updateRoutineWithPool(getAnalyserPool(), owner, key, patch, options);
}

export async function updateRoutineWithPool(
  pool: AnalyserQueryPool,
  owner: string,
  key: string,
  patch: UpdateRoutinePatch,
  options: SchedulerOptions = {}
): Promise<RoutineRecord> {
  validateInteger(patch.maxRetries, 0, 10, "maxRetries");
  validateInteger(patch.backoffMinutes, 1, 1_440, "backoffMinutes");
  const currentResult = await pool.query<RoutineRow>(`SELECT ${ROUTINE_COLUMNS}
    FROM analyser_routines
    WHERE service_account_id = $1 AND key = $2`, [owner, key]);
  const currentRow = currentResult.rows[0];
  if (!currentRow) throw new AnalyserServiceError(404, "ROUTINE_NOT_FOUND", "Routine not found");
  if (patch.expectedVersion !== undefined && patch.expectedVersion !== currentRow.version) {
    throw new AnalyserServiceError(409, "VERSION_CONFLICT", "Routine version conflict");
  }

  const scheduleChanged = patch.scheduleKind !== undefined || patch.scheduleExpr !== undefined || patch.timezone !== undefined;
  const scheduleKind = patch.scheduleKind ?? currentRow.schedule_kind;
  const scheduleExpr = patch.scheduleExpr ?? currentRow.schedule_expr;
  const timezone = patch.timezone ?? currentRow.timezone;
  if (scheduleChanged) parseSchedule(scheduleKind, scheduleExpr, timezone);
  const enabled = patch.enabled ?? currentRow.enabled;
  const enabledAgain = currentRow.enabled === false && enabled === true;
  let nextRunAt = currentRow.next_run_at;
  if (!enabled) nextRunAt = null;
  else if (scheduleChanged || enabledAgain) {
    nextRunAt = (options.computeNext ?? computeNextRunAt)(scheduleKind, scheduleExpr, timezone, options.now ?? new Date());
  }

  const result = await pool.query<RoutineRow>(`UPDATE analyser_routines SET
      name = $3, skill_version = $4, schedule_kind = $5, schedule_expr = $6,
      timezone = $7, enabled = $8, next_run_at = $9, max_retries = $10,
      backoff_minutes = $11, version = version + 1, updated_at = NOW()
    WHERE service_account_id = $1 AND key = $2 AND version = $12
    RETURNING ${ROUTINE_COLUMNS}`, [
    owner,
    key,
    patch.name ?? currentRow.name,
    patch.skillVersion ?? currentRow.skill_version,
    scheduleKind,
    scheduleExpr,
    timezone,
    enabled,
    nextRunAt,
    patch.maxRetries ?? currentRow.max_retries,
    patch.backoffMinutes ?? currentRow.backoff_minutes,
    currentRow.version
  ]);
  if (!result.rows[0]) throw new AnalyserServiceError(409, "VERSION_CONFLICT", "Routine version conflict");
  return mapRoutine(result.rows[0]);
}

export async function claimDueRoutine(
  owner: string,
  input: { key?: string; holder: string; leaseSeconds?: number; now?: Date }
): Promise<ClaimResult | null> {
  return claimDueRoutineWithPool(getAnalyserPool(), owner, input);
}

export async function claimDueRoutineWithPool(
  pool: AnalyserTransactionPool,
  owner: string,
  input: { key?: string; holder: string; leaseSeconds?: number; now?: Date }
): Promise<ClaimResult | null> {
  const leaseSeconds = input.leaseSeconds ?? 900;
  validateLeaseSeconds(leaseSeconds);
  return inTransaction(pool, async (client) => {
    const expiryClock = input.now ? "$2::timestamptz" : "NOW()";
    await client.query(`UPDATE analyser_runs SET status = 'failed', error_summary = 'lease expired',
        finished_at = ${expiryClock}, updated_at = ${expiryClock}
      WHERE service_account_id = $1 AND status IN ('claimed','processing')
        AND lease_expires_at <= ${expiryClock}`, input.now ? [owner, input.now] : [owner]);

    const dueClock = input.now ? "$3::timestamptz" : "NOW()";
    const due = await client.query<RoutineRow>(`SELECT ${ROUTINE_COLUMNS}
      FROM analyser_routines
      WHERE service_account_id = $1 AND enabled AND next_run_at IS NOT NULL
        AND skill_missing = FALSE
        AND next_run_at <= ${dueClock}
        AND ($2::text IS NULL OR key = $2)
        AND NOT EXISTS (
          SELECT 1 FROM analyser_runs active_run
          WHERE active_run.routine_id = analyser_routines.id
            AND active_run.status IN ('claimed','processing')
        )
      ORDER BY next_run_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED`, input.now ? [owner, input.key ?? null, input.now] : [owner, input.key ?? null]);
    const routineRow = due.rows[0];
    if (!routineRow) return null;

    const collection = await getEffectiveCollectionSettingsWithPool(client, owner);
    const automationPolicy = await getEffectiveAutomationPolicyWithPool(client, owner);
    const attemptResult = await client.query<{ attempt: number }>(`SELECT (1 + COUNT(*))::integer AS attempt
      FROM analyser_runs failed_run
      WHERE failed_run.service_account_id = $1 AND failed_run.routine_id = $2
        AND failed_run.status = 'failed'
        AND NOT EXISTS (
          SELECT 1 FROM analyser_runs completed_run
          WHERE completed_run.routine_id = failed_run.routine_id
            AND completed_run.status = 'completed'
            AND completed_run.started_at > failed_run.started_at
        )`, [owner, routineRow.id]);
    const attempt = attemptResult.rows[0]?.attempt ?? 1;
    const policySnapshot = { collectionSettings: collection.settings, automationPolicy };
    const leaseClock = input.now ? "$8::timestamptz" : "NOW()";
    const values: unknown[] = [
      owner,
      routineRow.id,
      input.holder,
      leaseSeconds,
      JSON.stringify(policySnapshot),
      String(routineRow.committed_cursor),
      attempt
    ];
    if (input.now) values.push(input.now);
    const inserted = await client.query<RunRow>(`INSERT INTO analyser_runs
        (service_account_id, routine_id, status, holder, lease_expires_at,
          policy_snapshot, pending_read_cursor, attempt)
      VALUES ($1, $2, 'claimed', $3, ${leaseClock} + ($4::integer * INTERVAL '1 second'),
        $5::jsonb, $6::bigint, $7)
      RETURNING ${RUN_COLUMNS}`, values);
    return {
      run: mapRun(inserted.rows[0], routineRow.key),
      routine: mapRoutine(routineRow),
      collectionSettings: collection.settings,
      automationPolicy
    };
  });
}

export async function heartbeatRun(owner: string, runId: string, holder: string, leaseSeconds = 900): Promise<RunRecord> {
  return heartbeatRunWithPool(getAnalyserPool(), owner, runId, holder, leaseSeconds);
}

export async function heartbeatRunWithPool(
  pool: AnalyserQueryPool,
  owner: string,
  runId: string,
  holder: string,
  leaseSeconds = 900
): Promise<RunRecord> {
  validateLeaseSeconds(leaseSeconds);
  const result = await pool.query<RunRow>(`UPDATE analyser_runs SET
      lease_expires_at = NOW() + ($4::integer * INTERVAL '1 second'),
      status = 'processing', updated_at = NOW()
    WHERE service_account_id = $1 AND id = $2 AND holder = $3
      AND status IN ('claimed','processing') AND lease_expires_at > NOW()
    RETURNING ${RUN_COLUMNS}`, [owner, runId, holder, leaseSeconds]);
  if (!result.rows[0]) throw new AnalyserServiceError(409, "RUN_NOT_ACTIVE", "Run is not active");
  return mapRun(result.rows[0]);
}

export async function pullForRun(
  owner: string,
  runId: string,
  holder: string,
  limit?: number
): Promise<{ items: ObservationRecord[]; pendingReadCursor: string }> {
  return pullForRunWithPool(getAnalyserPool(), owner, runId, holder, limit);
}

export async function pullForRunWithPool(
  pool: AnalyserTransactionPool,
  owner: string,
  runId: string,
  holder: string,
  limit?: number
): Promise<{ items: ObservationRecord[]; pendingReadCursor: string }> {
  return inTransaction(pool, async (client) => {
    const locked = await client.query<RunRow>(`SELECT ${RUN_COLUMNS}
      FROM analyser_runs
      WHERE service_account_id = $1 AND id = $2 AND holder = $3
        AND status IN ('claimed','processing') AND lease_expires_at > NOW()
      FOR UPDATE`, [owner, runId, holder]);
    const run = locked.rows[0];
    if (!run) throw new AnalyserServiceError(409, "RUN_NOT_ACTIVE", "Run is not active");
    const afterSeq = String(run.pending_read_cursor);
    const pulled = await pullObservationsAfterWithPool(client, owner, afterSeq, limit);
    const advanced = BigInt(pulled.maxSeq) > BigInt(afterSeq);
    if (advanced) {
      await client.query(`UPDATE analyser_runs SET pending_read_cursor = $3::bigint, updated_at = NOW()
        WHERE service_account_id = $1 AND id = $2`, [owner, runId, pulled.maxSeq]);
    }
    return { items: pulled.items, pendingReadCursor: advanced ? pulled.maxSeq : afterSeq };
  });
}

function lockedRunRoutineSql(clock: string): string {
  return `SELECT ${clock} AS current_time,
      run.id AS run_id, run.routine_id AS run_routine_id, run.status AS run_status,
      run.holder AS run_holder, run.lease_expires_at AS run_lease_expires_at,
      run.policy_snapshot AS run_policy_snapshot, run.pending_read_cursor AS run_pending_read_cursor,
      run.attempt AS run_attempt, run.error_summary AS run_error_summary,
      run.started_at AS run_started_at, run.finished_at AS run_finished_at,
      routine.id AS routine_id, routine.key AS routine_key, routine.name AS routine_name,
      routine.skill_key AS routine_skill_key, routine.skill_version AS routine_skill_version,
      routine.schedule_kind AS routine_schedule_kind, routine.schedule_expr AS routine_schedule_expr,
      routine.timezone AS routine_timezone, routine.enabled AS routine_enabled,
      routine.skill_missing AS routine_skill_missing,
      routine.next_run_at AS routine_next_run_at, routine.committed_cursor AS routine_committed_cursor,
      routine.max_retries AS routine_max_retries, routine.backoff_minutes AS routine_backoff_minutes,
      routine.version AS routine_version, routine.created_at AS routine_created_at,
      routine.updated_at AS routine_updated_at
    FROM analyser_runs run
    JOIN analyser_routines routine ON routine.id = run.routine_id
    WHERE run.service_account_id = $1 AND run.id = $2 AND run.holder = $3
      AND run.status IN ('claimed','processing') AND run.lease_expires_at > ${clock}
    FOR UPDATE OF run, routine`;
}

export async function completeRun(
  owner: string,
  runId: string,
  holder: string,
  input: { now?: Date } = {},
  options: SchedulerOptions = {}
): Promise<{ run: RunRecord; routine: RoutineRecord }> {
  return completeRunWithPool(getAnalyserPool(), owner, runId, holder, input, options);
}

export async function completeRunWithPool(
  pool: AnalyserTransactionPool,
  owner: string,
  runId: string,
  holder: string,
  input: { now?: Date } = {},
  options: SchedulerOptions = {}
): Promise<{ run: RunRecord; routine: RoutineRecord }> {
  return inTransaction(pool, async (client) => {
    const suppliedNow = input.now ?? options.now;
    const clock = suppliedNow ? "$4::timestamptz" : "NOW()";
    const locked = await client.query<LockedRunRoutineRow>(lockedRunRoutineSql(clock), suppliedNow
      ? [owner, runId, holder, suppliedNow]
      : [owner, runId, holder]);
    const row = locked.rows[0];
    if (!row) throw new AnalyserServiceError(409, "RUN_NOT_ACTIVE", "Run is not active");
    const now = suppliedNow ?? new Date(row.current_time);
    const nextRunAt = (options.computeNext ?? computeNextRunAt)(
      row.routine_schedule_kind,
      row.routine_schedule_expr,
      row.routine_timezone,
      now
    );
    const finished = await client.query<RunRow>(`UPDATE analyser_runs SET
        status = 'completed', finished_at = $4::timestamptz, updated_at = $4::timestamptz
      WHERE service_account_id = $1 AND id = $2 AND holder = $3
      RETURNING ${RUN_COLUMNS}`, [owner, runId, holder, now]);
    const routine = await client.query<RoutineRow>(`UPDATE analyser_routines SET
        committed_cursor = GREATEST(committed_cursor, $2::bigint),
        next_run_at = $3::timestamptz, updated_at = $4::timestamptz
      WHERE service_account_id = $1 AND id = $5
      RETURNING ${ROUTINE_COLUMNS}`, [owner, String(row.run_pending_read_cursor), nextRunAt, now, row.routine_id]);
    return { run: mapRun(finished.rows[0], row.routine_key), routine: mapRoutine(routine.rows[0]) };
  });
}

export async function failRun(
  owner: string,
  runId: string,
  holder: string,
  input: { errorSummary: string; now?: Date },
  options: SchedulerOptions = {}
): Promise<{ run: RunRecord; routine: RoutineRecord }> {
  return failRunWithPool(getAnalyserPool(), owner, runId, holder, input, options);
}

export async function failRunWithPool(
  pool: AnalyserTransactionPool,
  owner: string,
  runId: string,
  holder: string,
  input: { errorSummary: string; now?: Date },
  options: SchedulerOptions = {}
): Promise<{ run: RunRecord; routine: RoutineRecord }> {
  return inTransaction(pool, async (client) => {
    const suppliedNow = input.now ?? options.now;
    const clock = suppliedNow ? "$4::timestamptz" : "NOW()";
    const locked = await client.query<LockedRunRoutineRow>(lockedRunRoutineSql(clock), suppliedNow
      ? [owner, runId, holder, suppliedNow]
      : [owner, runId, holder]);
    const row = locked.rows[0];
    if (!row) throw new AnalyserServiceError(409, "RUN_NOT_ACTIVE", "Run is not active");
    const now = suppliedNow ?? new Date(row.current_time);
    const nextRunAt = row.run_attempt < row.routine_max_retries
      ? new Date(now.getTime() + row.routine_backoff_minutes * row.run_attempt * 60_000)
      : (options.computeNext ?? computeNextRunAt)(
          row.routine_schedule_kind,
          row.routine_schedule_expr,
          row.routine_timezone,
          now
        );
    const finished = await client.query<RunRow>(`UPDATE analyser_runs SET
        status = 'failed', error_summary = $4, finished_at = $5::timestamptz,
        updated_at = $5::timestamptz
      WHERE service_account_id = $1 AND id = $2 AND holder = $3
      RETURNING ${RUN_COLUMNS}`, [owner, runId, holder, input.errorSummary.slice(0, 2_000), now]);
    const routineUpdate = await client.query<{ next_run_at: Date | string; updated_at: Date | string }>(`UPDATE analyser_routines SET
        next_run_at = $2::timestamptz, updated_at = $3::timestamptz
      WHERE service_account_id = $1 AND id = $4
      RETURNING next_run_at, updated_at`, [owner, nextRunAt, now, row.routine_id]);
    const routine = routineFromLocked(row);
    routine.nextRunAt = iso(routineUpdate.rows[0].next_run_at);
    routine.updatedAt = iso(routineUpdate.rows[0].updated_at);
    return { run: mapRun(finished.rows[0], row.routine_key), routine };
  });
}

export async function routineStatusSummaries(owner: string): Promise<RoutineStatusSummary[]> {
  return routineStatusSummariesWithPool(getAnalyserPool(), owner);
}

export async function routineStatusSummariesWithPool(
  pool: AnalyserQueryPool,
  owner: string
): Promise<RoutineStatusSummary[]> {
  const result = await pool.query<{
    key: string;
    enabled: boolean;
    skill_missing: boolean;
    next_run_at: Date | string | null;
    last_completed_at: Date | string | null;
    last_failed_at: Date | string | null;
    last_error_summary: string | null;
    active_run_id: string | null;
    active_holder: string | null;
    active_lease_expires_at: Date | string | null;
  }>(`SELECT routine.key, routine.enabled, routine.skill_missing, routine.next_run_at,
      completed.finished_at AS last_completed_at,
      failed.finished_at AS last_failed_at, failed.error_summary AS last_error_summary,
      active.id AS active_run_id, active.holder AS active_holder,
      active.lease_expires_at AS active_lease_expires_at
    FROM analyser_routines routine
    LEFT JOIN LATERAL (
      SELECT finished_at FROM analyser_runs
      WHERE routine_id = routine.id AND status = 'completed'
      ORDER BY finished_at DESC NULLS LAST LIMIT 1
    ) completed ON TRUE
    LEFT JOIN LATERAL (
      SELECT finished_at, error_summary FROM analyser_runs
      WHERE routine_id = routine.id AND status = 'failed'
      ORDER BY finished_at DESC NULLS LAST LIMIT 1
    ) failed ON TRUE
    LEFT JOIN LATERAL (
      SELECT id, holder, lease_expires_at FROM analyser_runs
      WHERE routine_id = routine.id AND status IN ('claimed','processing')
      ORDER BY started_at DESC LIMIT 1
    ) active ON TRUE
    WHERE routine.service_account_id = $1
    ORDER BY routine.key`, [owner]);
  return result.rows.map((row) => ({
    key: row.key,
    enabled: row.enabled,
    skillMissing: row.skill_missing,
    ...(row.next_run_at === null ? {} : { nextRunAt: iso(row.next_run_at) }),
    ...(row.last_completed_at === null ? {} : { lastCompletedAt: iso(row.last_completed_at) }),
    ...(row.last_failed_at === null ? {} : { lastFailedAt: iso(row.last_failed_at) }),
    ...(row.last_error_summary === null ? {} : { lastErrorSummary: row.last_error_summary }),
    activeRun: row.active_run_id && row.active_holder && row.active_lease_expires_at
      ? { id: row.active_run_id, holder: row.active_holder, leaseExpiresAt: iso(row.active_lease_expires_at) }
      : null
  }));
}

export async function setRoutineSkillMissingByKeys(
  owner: string,
  missingSkillKeys: string[]
): Promise<void> {
  return setRoutineSkillMissingByKeysWithPool(getAnalyserPool(), owner, missingSkillKeys);
}

export async function setRoutineSkillMissingByKeysWithPool(
  pool: AnalyserQueryPool,
  owner: string,
  missingSkillKeys: string[]
): Promise<void> {
  await pool.query(`UPDATE analyser_routines
    SET skill_missing = (skill_key = ANY($2::text[])), updated_at = NOW()
    WHERE service_account_id = $1`, [owner, missingSkillKeys]);
}
