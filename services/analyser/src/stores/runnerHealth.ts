import { getAnalyserPool } from "../db.js";
import type { AnalyserQueryPool } from "./machines.js";

export const STALL_GRACE_MINUTES = 60;

export interface AnalyserRunnerSummary {
  runner: string;
  lastSeenAt: string;
  lastStatus: "claimed" | "processing" | "completed" | "failed";
  runsLast24h: number;
}

export interface AnalyserOverdueRoutine {
  key: string;
  nextRunAt: string;
  overdueMinutes: number;
}

export interface AnalyserRunnerHealth {
  state: "never_claimed" | "stalled" | "healthy";
  lastClaimAt: string | null;
  runners: AnalyserRunnerSummary[];
  overdueRoutines: AnalyserOverdueRoutine[];
}

type RunnerRow = {
  runner: string;
  last_seen_at: Date | string;
  last_status: AnalyserRunnerSummary["lastStatus"];
  runs_last_24h: number;
};

type OverdueRoutineRow = {
  key: string;
  next_run_at: Date | string;
  overdue_minutes: number;
};

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function getRunnerHealth(
  owner: string,
  options: { now?: Date } = {}
): Promise<AnalyserRunnerHealth> {
  return getRunnerHealthWithPool(getAnalyserPool(), owner, options);
}

export async function getRunnerHealthWithPool(
  pool: AnalyserQueryPool,
  owner: string,
  options: { now?: Date } = {}
): Promise<AnalyserRunnerHealth> {
  const now = options.now ?? new Date();
  const [runnerResult, overdueResult] = await Promise.all([
    pool.query<RunnerRow>(`WITH runs AS (
        SELECT split_part(holder, '/', 1) AS runner, status, started_at
        FROM analyser_runs
        WHERE service_account_id = $1
      ), latest AS (
        SELECT DISTINCT ON (runner) runner, started_at AS last_seen_at, status AS last_status
        FROM runs
        ORDER BY runner, started_at DESC
      ), recent AS (
        SELECT runner, COUNT(*)::integer AS runs_last_24h
        FROM runs
        WHERE started_at > ($2::timestamptz - INTERVAL '24 hours')
        GROUP BY runner
      )
      SELECT latest.runner, latest.last_seen_at, latest.last_status,
        COALESCE(recent.runs_last_24h, 0) AS runs_last_24h
      FROM latest
      LEFT JOIN recent ON recent.runner = latest.runner
      ORDER BY latest.last_seen_at DESC
      LIMIT 20`, [owner, now]),
    pool.query<OverdueRoutineRow>(`SELECT key, next_run_at,
        GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ($2::timestamptz - next_run_at)) / 60))::integer AS overdue_minutes
      FROM analyser_routines
      WHERE service_account_id = $1 AND enabled AND skill_missing = FALSE
        AND next_run_at IS NOT NULL AND next_run_at <= $2::timestamptz
      ORDER BY next_run_at ASC
      LIMIT 20`, [owner, now])
  ]);

  const runners = runnerResult.rows.map((row) => ({
    runner: row.runner,
    lastSeenAt: iso(row.last_seen_at),
    lastStatus: row.last_status,
    runsLast24h: row.runs_last_24h
  }));
  const overdueRoutines = overdueResult.rows.map((row) => ({
    key: row.key,
    nextRunAt: iso(row.next_run_at),
    overdueMinutes: row.overdue_minutes
  }));
  const lastClaimAt = runners.reduce<string | null>(
    (latest, runner) => latest === null || runner.lastSeenAt > latest ? runner.lastSeenAt : latest,
    null
  );
  const minutesSinceLastClaim = lastClaimAt === null
    ? null
    : (now.getTime() - new Date(lastClaimAt).getTime()) / 60_000;
  const state: AnalyserRunnerHealth["state"] = lastClaimAt === null
    ? "never_claimed"
    : overdueRoutines.length > 0
      && minutesSinceLastClaim !== null
      && minutesSinceLastClaim > STALL_GRACE_MINUTES
      ? "stalled"
      : "healthy";

  return { state, lastClaimAt, runners, overdueRoutines };
}
