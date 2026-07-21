import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_AUTOMATION_POLICY, publicationInputSchema, type AnalyserOperationKind } from "../types.js";

process.env.ANALYSER_DB_HOST ??= "127.0.0.1";
process.env.ANALYSER_DB_PORT ??= "5551";
process.env.ANALYSER_DB_NAME ??= "test";
process.env.ANALYSER_DB_USER ??= "test";
process.env.ANALYSER_DB_PASSWORD ??= "test";

const { recordOperationWithPool } = await import("../stores/operations.js");
const { finalizePublicationWithPool, recordPublicationWithPool, reservePublicationWithPool } = await import("../stores/publications.js");

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

const operationRow = {
  id: "00000000-0000-4000-8000-000000000003",
  operation_kind: "artifact_move",
  approval_basis: "policy",
  proposal_id: null,
  before_refs: [],
  after_refs: [],
  result: "succeeded",
  detail: null,
  run_id: null,
  agent_label: null,
  idempotency_key: "op-1",
  created_at: "2026-07-20T00:00:00.000Z"
};

const policyRow = (overrides: Partial<typeof DEFAULT_AUTOMATION_POLICY> = {}) => ({
  policy_json: { ...DEFAULT_AUTOMATION_POLICY, ...overrides }
});

describe("analyser operations", () => {
  it("rejects policy approval when the kind is not in the allowlist", async () => {
    const pool = fakePool([{ rows: [] }, { rows: [policyRow({ allowedOperationKinds: [] })] }, { rows: [] }]);
    await assert.rejects(
      recordOperationWithPool(pool, "owner-1", {
        operationKind: "artifact_move", approvalBasis: "policy", result: "succeeded", idempotencyKey: "op-1"
      }),
      (error: unknown) => (error as { status: number; code: string }).status === 403
        && (error as { code: string }).code === "POLICY_FORBIDDEN"
    );
  });

  it("rejects policy approval when automation is disabled", async () => {
    const pool = fakePool([{ rows: [] }, { rows: [policyRow({ enabled: false })] }, { rows: [] }]);
    await assert.rejects(
      recordOperationWithPool(pool, "owner-1", {
        operationKind: "artifact_move", approvalBasis: "policy", result: "skipped", idempotencyKey: "op-2"
      }),
      (error: unknown) => (error as { status: number; code: string }).status === 403
    );
  });

  it("requires an approved proposal for proposal approval basis", async () => {
    const pool = fakePool([{ rows: [] }, { rows: [] }, { rows: [] }]);
    await assert.rejects(
      recordOperationWithPool(pool, "owner-1", {
        operationKind: "artifact_move", approvalBasis: "proposal", proposalId: "proposal-1",
        result: "succeeded", idempotencyKey: "op-3"
      }),
      (error: unknown) => (error as { status: number; code: string }).status === 409
        && (error as { code: string }).code === "PROPOSAL_NOT_APPROVED"
    );
    assert.match(pool.calls[1].text, /status = 'approved'/);
  });

  it("returns created false after an idempotency conflict", async () => {
    const pool = fakePool([
      { rows: [] }, { rows: [policyRow()] }, { rows: [] }, { rows: [operationRow] }, { rows: [] }
    ]);
    const result = await recordOperationWithPool(pool, "owner-1", {
      operationKind: "artifact_move", approvalBasis: "policy", result: "succeeded", idempotencyKey: "op-1"
    });
    assert.equal(result.created, false);
    assert.equal(result.operation.id, operationRow.id);
    assert.match(pool.calls[2].text, /ON CONFLICT \(service_account_id, idempotency_key\) DO NOTHING/);
    assert.match(pool.calls[3].text, /idempotency_key = \$2/);
  });

  it("allowlists detail independently for every operation kind", async () => {
    const cases: Array<{
      operationKind: AnalyserOperationKind;
      detail: Record<string, string>;
      expected: Record<string, string>;
    }> = [
      {
        operationKind: "artifact_move",
        detail: {
          fromPath: "inbox/a.md", toPath: "archive/a.md", projectId: "project-1",
          content: "drop", token: "drop"
        },
        expected: { fromPath: "inbox/a.md", toPath: "archive/a.md", projectId: "project-1" }
      },
      {
        operationKind: "artifact_metadata_update",
        detail: { field: "title", projectId: "project-1", documentBody: "drop", Cookie: "drop" },
        expected: { field: "title", projectId: "project-1" }
      },
      {
        operationKind: "artifact_secondary_membership_add",
        detail: { projectId: "project-2", requestBody: "drop", authorization: "drop" },
        expected: { projectId: "project-2" }
      },
      {
        operationKind: "progress_note_upsert",
        detail: { noteId: "note-1", projectId: "project-1", content: "drop", secret: "drop" },
        expected: { noteId: "note-1", projectId: "project-1" }
      }
    ];

    for (const [index, testCase] of cases.entries()) {
      const pool = fakePool([
        { rows: [] }, { rows: [policyRow()] },
        { rows: [{ ...operationRow, operation_kind: testCase.operationKind, detail: testCase.expected }] },
        { rows: [] }
      ]);
      await recordOperationWithPool(pool, "owner-1", {
        operationKind: testCase.operationKind,
        approvalBasis: "policy",
        result: "succeeded",
        idempotencyKey: `op-detail-${index}`,
        detail: testCase.detail
      });
      assert.deepEqual(JSON.parse(String(pool.calls[2].values?.[7])), testCase.expected, testCase.operationKind);
    }
  });
});

const publicationRow = {
  id: "00000000-0000-4000-8000-000000000004",
  source_kind: "summary",
  source_id: "00000000-0000-4000-8000-000000000001",
  target_kind: "note",
  target_id: "note-1",
  target_ref: null,
  content_hash: "abcdef12",
  provenance: "agent",
  created_at: "2026-07-20T00:00:00.000Z"
};

describe("analyser publications", () => {
  it("returns created false for duplicate publication content", async () => {
    const pool = fakePool([{ rows: [{ id: publicationRow.source_id }] }, { rows: [] }, { rows: [publicationRow] }]);
    const result = await recordPublicationWithPool(pool, "owner-1", {
      sourceKind: "summary", sourceId: publicationRow.source_id, targetKind: "note",
      targetId: "note-1", contentHash: "abcdef12", provenance: "agent"
    });
    assert.equal(result.created, false);
    assert.match(pool.calls[1].text, /ON CONFLICT \(service_account_id, source_kind, source_id, target_kind, content_hash\) DO NOTHING/);
  });

  it("rejects non-hex content hashes before querying", async () => {
    assert.equal(publicationInputSchema.safeParse({
      sourceKind: "summary", sourceId: "summary-1", targetKind: "note", targetId: "note-1",
      contentHash: "not-hex!", provenance: "agent"
    }).success, false);
    const pool = fakePool([]);
    await assert.rejects(
      recordPublicationWithPool(pool, "owner-1", {
        sourceKind: "summary", sourceId: "summary-1", targetKind: "note", targetId: "note-1",
        contentHash: "not-hex!", provenance: "agent"
      }),
      (error: unknown) => (error as { status: number; code: string }).status === 400
    );
    assert.equal(pool.calls.length, 0);
  });
});

describe("analyser publication reservations (export race prevention)", () => {
  it("reserves with an empty target_id sentinel before the caller creates the target", async () => {
    const reservedRow = { ...publicationRow, target_id: "", target_ref: null };
    const pool = fakePool([{ rows: [{ id: publicationRow.source_id }] }, { rows: [reservedRow] }]);
    const result = await reservePublicationWithPool(pool, "owner-1", {
      sourceKind: "summary", sourceId: publicationRow.source_id, targetKind: "note",
      contentHash: "abcdef12", provenance: "ui"
    });
    assert.equal(result.reserved, true);
    assert.equal(result.publication.targetId, "");
    assert.match(pool.calls[1].text, /VALUES \(\$1, \$2, \$3, \$4, \$5, NULL, \$6, \$7\)/);
    assert.match(pool.calls[1].text, /ON CONFLICT \(service_account_id, source_kind, source_id, target_kind, content_hash\) DO NOTHING/);
    assert.deepEqual(pool.calls[1].values?.slice(0, 5), ["owner-1", "summary", publicationRow.source_id, "note", ""]);
  });

  it("loses the reservation race and returns the existing row instead of creating a second one", async () => {
    const pool = fakePool([
      { rows: [{ id: publicationRow.source_id }] },
      { rows: [] }, // ON CONFLICT DO NOTHING: someone else already reserved it
      { rows: [publicationRow] } // read-back finds the winner's (already finalized) row
    ]);
    const result = await reservePublicationWithPool(pool, "owner-1", {
      sourceKind: "summary", sourceId: publicationRow.source_id, targetKind: "note",
      contentHash: "abcdef12", provenance: "ui"
    });
    assert.equal(result.reserved, false);
    assert.equal(result.publication.targetId, "note-1");
  });

  it("finalize only overwrites the caller's own still-empty reservation, never an already-finalized row", async () => {
    const pool = fakePool([{ rows: [publicationRow] }]);
    const finalized = await finalizePublicationWithPool(pool, "owner-1", publicationRow.id, {
      targetId: "note-1",
      targetRef: { service: "notes", resourceType: "note", resourceId: "note-1" }
    });
    assert.equal(finalized.targetId, "note-1");
    assert.match(pool.calls[0].text, /WHERE service_account_id = \$1 AND id = \$2 AND target_id = ''/);
  });

  it("finalize fails closed when the reservation was already finalized (no matching empty row)", async () => {
    const pool = fakePool([{ rows: [] }]);
    await assert.rejects(
      finalizePublicationWithPool(pool, "owner-1", publicationRow.id, { targetId: "note-1" }),
      (error: unknown) => (error as { status: number; code: string }).status === 409
        && (error as { code: string }).code === "PUBLICATION_ALREADY_FINALIZED"
    );
  });
});
