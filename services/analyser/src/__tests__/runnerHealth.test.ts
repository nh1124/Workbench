import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.ANALYSER_DB_HOST ??= "127.0.0.1";
process.env.ANALYSER_DB_PORT ??= "5551";
process.env.ANALYSER_DB_NAME ??= "test";
process.env.ANALYSER_DB_USER ??= "test";
process.env.ANALYSER_DB_PASSWORD ??= "test";

const {
  getRunnerHealthWithPool,
  STALL_GRACE_MINUTES
} = await import("../stores/runnerHealth.js");

type Result = { rows: unknown[]; rowCount?: number };
type Call = { text: string; values?: unknown[] };

function fakePool(responses: Result[]) {
  const calls: Call[] = [];
  return {
    calls,
    async query<Row = never>(text: string, values?: unknown[]) {
      calls.push({ text, values });
      return (responses.shift() ?? { rows: [] }) as { rows: Row[]; rowCount?: number };
    }
  };
}

const now = new Date("2026-07-25T12:00:00.000Z");

describe("analyser runner health", () => {
  it("maps runner summaries and reports healthy when no routines are overdue", async () => {
    const pool = fakePool([
      { rows: [
        {
          runner: "agent",
          last_seen_at: "2026-07-25T11:50:00.000Z",
          last_status: "completed",
          runs_last_24h: 4
        },
        {
          runner: "codex-loop",
          last_seen_at: new Date("2026-07-25T11:40:00.000Z"),
          last_status: "processing",
          runs_last_24h: 2
        }
      ] },
      { rows: [] }
    ]);

    const health = await getRunnerHealthWithPool(pool, "owner-1", { now });

    assert.equal(health.state, "healthy");
    assert.equal(health.lastClaimAt, "2026-07-25T11:50:00.000Z");
    assert.deepEqual(health.runners, [
      {
        runner: "agent",
        lastSeenAt: "2026-07-25T11:50:00.000Z",
        lastStatus: "completed",
        runsLast24h: 4
      },
      {
        runner: "codex-loop",
        lastSeenAt: "2026-07-25T11:40:00.000Z",
        lastStatus: "processing",
        runsLast24h: 2
      }
    ]);
    assert.match(pool.calls[0].text, /split_part\(holder, '\/', 1\) AS runner/);
  });

  it("reports never claimed when there are no runs", async () => {
    const pool = fakePool([{ rows: [] }, { rows: [] }]);

    const health = await getRunnerHealthWithPool(pool, "owner-1", { now });

    assert.equal(health.state, "never_claimed");
    assert.equal(health.lastClaimAt, null);
    assert.deepEqual(health.runners, []);
  });

  it("reports stalled when an overdue routine has no claim within the grace window", async () => {
    const lastSeenAt = new Date(now.getTime() - (STALL_GRACE_MINUTES + 1) * 60_000);
    const pool = fakePool([
      { rows: [{
        runner: "agent",
        last_seen_at: lastSeenAt,
        last_status: "failed",
        runs_last_24h: 1
      }] },
      { rows: [{
        key: "daily-work-summary",
        next_run_at: "2026-07-25T10:00:00.000Z",
        overdue_minutes: 120
      }] }
    ]);

    const health = await getRunnerHealthWithPool(pool, "owner-1", { now });

    assert.equal(health.state, "stalled");
    assert.deepEqual(health.overdueRoutines, [{
      key: "daily-work-summary",
      nextRunAt: "2026-07-25T10:00:00.000Z",
      overdueMinutes: 120
    }]);
  });

  it("remains healthy when an overdue routine has a recent claim", async () => {
    const pool = fakePool([
      { rows: [{
        runner: "agent",
        last_seen_at: new Date(now.getTime() - (STALL_GRACE_MINUTES - 1) * 60_000),
        last_status: "claimed",
        runs_last_24h: 1
      }] },
      { rows: [{
        key: "daily-work-summary",
        next_run_at: "2026-07-25T11:55:00.000Z",
        overdue_minutes: 5
      }] }
    ]);

    const health = await getRunnerHealthWithPool(pool, "owner-1", { now });

    assert.equal(health.state, "healthy");
  });

  it("filters intentionally blocked routines and passes the supplied clock to both queries", async () => {
    const pool = fakePool([{ rows: [] }, { rows: [] }]);

    await getRunnerHealthWithPool(pool, "owner-1", { now });

    assert.equal(pool.calls.length, 2);
    assert.match(pool.calls[1].text, /AND enabled AND skill_missing = FALSE/);
    assert.deepEqual(pool.calls[0].values, ["owner-1", now]);
    assert.deepEqual(pool.calls[1].values, ["owner-1", now]);
  });
});
