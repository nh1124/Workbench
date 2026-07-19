import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.ANALYSER_DB_HOST ??= "127.0.0.1";
process.env.ANALYSER_DB_PORT ??= "5551";
process.env.ANALYSER_DB_NAME ??= "test";
process.env.ANALYSER_DB_USER ??= "test";
process.env.ANALYSER_DB_PASSWORD ??= "test";

const proposals = await import("../stores/proposals.js");

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
  id: "00000000-0000-4000-8000-000000000002",
  kind: "cleanup",
  title: "Clean up",
  body_markdown: "Details",
  evidence_refs: [],
  proposed_action: null,
  confidence_evidence: null,
  status: "open",
  approved_by: null,
  approved_at: null,
  approval_provenance: null,
  routine_key: null,
  run_id: null,
  dedupe_key: "dedupe-1",
  version: 1,
  created_at: "2026-07-20T00:00:00.000Z",
  updated_at: "2026-07-20T00:00:00.000Z"
};

describe("analyser proposals", () => {
  it("returns the existing proposal when a dedupe insert conflicts", async () => {
    const pool = fakePool([{ rows: [] }, { rows: [row] }]);
    const result = await proposals.createProposalWithPool(pool, "owner-1", {
      kind: "cleanup", title: "Clean up", bodyMarkdown: "Details", dedupeKey: "dedupe-1"
    });
    assert.equal(result.created, false);
    assert.equal(result.proposal.id, row.id);
    assert.match(pool.calls[0].text, /ON CONFLICT \(service_account_id, dedupe_key\) WHERE dedupe_key IS NOT NULL DO NOTHING/);
    assert.match(pool.calls[1].text, /dedupe_key = \$2/);
  });

  it("rejects content updates when the proposal is not open", async () => {
    const pool = fakePool([{ rows: [] }, { rows: [{ status: "approved", version: 2 }] }]);
    await assert.rejects(
      proposals.updateProposalContentWithPool(pool, "owner-1", row.id, { title: "New", expectedVersion: 2 }),
      (error: unknown) => (error as { status: number; code: string }).status === 409
        && (error as { code: string }).code === "PROPOSAL_NOT_OPEN"
    );
  });

  it("rejects resolve transitions from a non-open status", async () => {
    const pool = fakePool([{ rows: [] }, { rows: [{ status: "rejected", version: 2 }] }]);
    await assert.rejects(
      proposals.resolveProposalWithPool(pool, "owner-1", row.id, {
        status: "approved", resolvedBy: "user-1", provenance: "ui", expectedVersion: 2
      }),
      (error: unknown) => (error as { status: number; code: string }).status === 409
        && (error as { code: string }).code === "INVALID_TRANSITION"
    );
  });

  it("requires a recorded operation linked to the approved proposal", async () => {
    const pool = fakePool([{ rows: [] }, { rows: [{ status: "approved", version: 2, operation_recorded: false }] }]);
    await assert.rejects(
      proposals.markProposalExecutedWithPool(pool, "owner-1", row.id, { operationId: "operation-1", expectedVersion: 2 }),
      (error: unknown) => (error as { status: number; code: string }).status === 400
        && (error as { code: string }).code === "OPERATION_NOT_RECORDED"
    );
    assert.match(pool.calls[0].text, /AND EXISTS \(SELECT 1 FROM analyser_operations operation/);
    assert.match(pool.calls[0].text, /proposal\.status = 'approved'/);
  });

  it("only marks approved proposals executed", async () => {
    const pool = fakePool([{ rows: [] }, { rows: [{ status: "open", version: 1, operation_recorded: true }] }]);
    await assert.rejects(
      proposals.markProposalExecutedWithPool(pool, "owner-1", row.id, { operationId: "operation-1", expectedVersion: 1 }),
      (error: unknown) => (error as { status: number; code: string }).status === 409
        && (error as { code: string }).code === "INVALID_TRANSITION"
    );
  });

  it("exports no direct open-to-executed function", () => {
    assert.deepEqual(Object.keys(proposals).sort(), [
      "createProposal", "createProposalWithPool", "getProposal", "getProposalWithPool",
      "listProposals", "listProposalsWithPool", "markProposalExecuted", "markProposalExecutedWithPool",
      "resolveProposal", "resolveProposalWithPool", "supersedeProposal", "supersedeProposalWithPool",
      "updateProposalContent", "updateProposalContentWithPool"
    ].sort());
  });
});
