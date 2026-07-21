import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.ANALYSER_DB_HOST ??= "127.0.0.1";
process.env.ANALYSER_DB_PORT ??= "5551";
process.env.ANALYSER_DB_NAME ??= "test";
process.env.ANALYSER_DB_USER ??= "test";
process.env.ANALYSER_DB_PASSWORD ??= "test";

const {
  getDerivedCaptureWithPool,
  ingestDerivedCaptureWithPool,
  listDerivedCapturesWithPool
} = await import("../stores/derivedCaptures.js");

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

const firstRow = {
  id: "00000000-0000-4000-8000-000000000002",
  machine_id: "11111111-1111-4111-8111-111111111111",
  kind: "screenshot_summary",
  title: "Editor state",
  summary_markdown: "Implemented the analyser store.",
  evidence_refs: [{ service: "artifacts", resourceType: "item", resourceId: "artifact-1" }],
  occurred_at: "2026-07-21T02:00:00.000Z",
  received_at: "2026-07-21T02:00:01.000Z",
  created_at: "2026-07-21T02:00:01.000Z"
};

const secondRow = {
  ...firstRow,
  id: "00000000-0000-4000-8000-000000000001",
  occurred_at: "2026-07-21T01:00:00.000Z"
};

const input = {
  machineId: firstRow.machine_id,
  kind: " screenshot_summary ",
  title: " Editor state ",
  summaryMarkdown: "Implemented the analyser store.",
  evidenceRefs: firstRow.evidence_refs,
  occurredAt: firstRow.occurred_at,
  dedupeKey: " capture:1 "
};

describe("analyser derived captures", () => {
  it("ingests through jsonb_to_recordset with the owner dedupe conflict target", async () => {
    const pool = fakePool([{ rows: [{ exists: 1 }] }, { rows: [firstRow], rowCount: 1 }]);
    const result = await ingestDerivedCaptureWithPool(pool, "owner-1", input);

    assert.equal(result.created, true);
    assert.equal(result.capture.kind, "screenshot_summary");
    assert.match(pool.calls[1].text, /jsonb_to_recordset/);
    assert.match(pool.calls[1].text, /ON CONFLICT \(service_account_id, dedupe_key\) DO NOTHING/);
    const records = JSON.parse(String(pool.calls[1].values?.[1])) as Array<Record<string, unknown>>;
    assert.deepEqual(records[0], {
      machineId: firstRow.machine_id,
      kind: "screenshot_summary",
      title: "Editor state",
      summaryMarkdown: "Implemented the analyser store.",
      evidenceRefs: firstRow.evidence_refs,
      occurredAt: firstRow.occurred_at,
      dedupeKey: "capture:1"
    });
  });

  it("reads back a duplicate and reports created false", async () => {
    const pool = fakePool([{ rows: [{ exists: 1 }] }, { rows: [], rowCount: 0 }, { rows: [firstRow] }]);
    const result = await ingestDerivedCaptureWithPool(pool, "owner-1", input);

    assert.equal(result.created, false);
    assert.equal(result.capture.id, firstRow.id);
    assert.match(pool.calls[2].text, /WHERE service_account_id = \$1 AND dedupe_key = \$2/);
    assert.deepEqual(pool.calls[2].values, ["owner-1", "capture:1"]);
  });

  it("rejects an empty kind, oversized summary, and embedded image data", async () => {
    const assertInvalid = async (value: typeof input): Promise<void> => {
      await assert.rejects(
        ingestDerivedCaptureWithPool(fakePool([]), "owner-1", value),
        (error: unknown) => (error as { status: number; code: string }).status === 400
          && (error as { code: string }).code === "INVALID_DERIVED_CAPTURE"
      );
    };

    await assertInvalid({ ...input, kind: " " });
    await assertInvalid({ ...input, summaryMarkdown: "x".repeat(20_001) });
    await assertInvalid({ ...input, summaryMarkdown: "![capture](data:image/png;base64,AAAA)" });
  });

  it("rejects a derived capture for an unknown machine", async () => {
    await assert.rejects(
      ingestDerivedCaptureWithPool(fakePool([{ rows: [] }]), "owner-1", input),
      (error: unknown) => (error as { status: number; code: string }).status === 404
        && (error as { code: string }).code === "MACHINE_NOT_FOUND"
    );
  });

  it("lists in descending keyset order and accepts the returned cursor", async () => {
    const firstPool = fakePool([{ rows: [firstRow, secondRow] }]);
    const firstPage = await listDerivedCapturesWithPool(firstPool, "owner-1", { limit: 1 });
    const expectedCursor = Buffer.from(`${firstRow.occurred_at}|${firstRow.id}`, "utf8").toString("base64url");

    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.nextCursor, expectedCursor);
    assert.match(firstPool.calls[0].text, /ORDER BY date_trunc\('milliseconds', occurred_at\) DESC, id DESC/);
    assert.deepEqual(firstPool.calls[0].values, ["owner-1", 2]);

    const nextPool = fakePool([{ rows: [] }]);
    await listDerivedCapturesWithPool(nextPool, "owner-1", { cursor: expectedCursor });
    assert.match(nextPool.calls[0].text, /\(date_trunc\('milliseconds', occurred_at\), id\) < \(\$2::timestamptz, \$3::uuid\)/);
    assert.match(nextPool.calls[0].text, /ORDER BY date_trunc\('milliseconds', occurred_at\) DESC, id DESC/);
    assert.deepEqual(nextPool.calls[0].values, ["owner-1", firstRow.occurred_at, firstRow.id, 51]);
  });

  it("returns DERIVED_CAPTURE_NOT_FOUND when get has no matching row", async () => {
    await assert.rejects(
      getDerivedCaptureWithPool(fakePool([{ rows: [] }]), "owner-1", firstRow.id),
      (error: unknown) => (error as { status: number; code: string }).status === 404
        && (error as { code: string }).code === "DERIVED_CAPTURE_NOT_FOUND"
    );
  });
});
