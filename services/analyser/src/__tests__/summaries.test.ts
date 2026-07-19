import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.ANALYSER_DB_HOST ??= "127.0.0.1";
process.env.ANALYSER_DB_PORT ??= "5551";
process.env.ANALYSER_DB_NAME ??= "test";
process.env.ANALYSER_DB_USER ??= "test";
process.env.ANALYSER_DB_PASSWORD ??= "test";

const { listSummariesWithPool, upsertSummaryWithPool } = await import("../stores/summaries.js");

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

const row = {
  id: "00000000-0000-4000-8000-000000000001",
  kind: "weekly",
  period_start: "2026-07-13",
  period_end: "2026-07-19",
  title: "Week",
  body_markdown: "Body",
  metrics: { tasks: 3 },
  evidence_refs: [],
  routine_key: null,
  run_id: null,
  version: 2,
  created_at: "2026-07-20T00:00:00.000Z",
  updated_at: "2026-07-20T01:00:00.000Z"
};

describe("analyser summaries", () => {
  it("uses the unique conflict target and optimistic version guard", async () => {
    const pool = fakePool([{ rows: [row] }]);
    const saved = await upsertSummaryWithPool(pool, "owner-1", {
      kind: " weekly ", periodStart: "2026-07-13", periodEnd: "2026-07-19",
      title: " Week ", bodyMarkdown: " Body ", expectedVersion: 1
    });
    assert.equal(saved.version, 2);
    assert.match(pool.calls[0].text, /ON CONFLICT \(service_account_id, kind, period_start, period_end\) DO UPDATE/);
    assert.match(pool.calls[0].text, /WHERE \(\$11::integer IS NULL OR analyser_summaries\.version = \$11\)/);
    assert.equal(pool.calls[0].values?.[1], "weekly");
  });

  it("reports a version conflict when the guarded upsert returns no row", async () => {
    await assert.rejects(
      upsertSummaryWithPool(fakePool([{ rows: [] }]), "owner-1", {
        kind: "weekly", periodStart: "2026-07-13", periodEnd: "2026-07-19",
        title: "Week", bodyMarkdown: "Body", expectedVersion: 8
      }),
      (error: unknown) => (error as { status: number; code: string }).status === 409
        && (error as { code: string }).code === "VERSION_CONFLICT"
    );
  });

  it("lists metadata without the body and computes bodyChars in SQL", async () => {
    const pool = fakePool([{ rows: [{ ...row, body_markdown: undefined, body_chars: 4 }] }]);
    const result = await listSummariesWithPool(pool, "owner-1");
    assert.equal(result.items[0].bodyChars, 4);
    assert.equal("bodyMarkdown" in result.items[0], false);
    assert.match(pool.calls[0].text, /LENGTH\(body_markdown\)::integer AS body_chars/);
    assert.doesNotMatch(pool.calls[0].text, /SELECT[^]*body_markdown,/);
    assert.deepEqual(pool.calls[0].values, ["owner-1", 51]);
  });
});
