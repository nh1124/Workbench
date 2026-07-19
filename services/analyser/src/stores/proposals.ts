import { getAnalyserPool } from "../db.js";
import { AnalyserServiceError } from "../serviceError.js";
import {
  proposalContentUpdateSchema,
  proposalExecutionSchema,
  proposalInputSchema,
  proposalResolutionSchema,
  proposalSupersedeSchema,
  type ConfidenceEvidence,
  type ProposalContentUpdate,
  type ProposalExecution,
  type ProposalInput,
  type ProposalListItem,
  type ProposalRecord,
  type ProposalResolution,
  type ProposalStatus,
  type ProposalSupersede,
  type ProposedAction,
  type ResourceRef
} from "../types.js";
import type { AnalyserQueryPool } from "./machines.js";

type ProposalRow = {
  id: string;
  kind: string;
  title: string;
  body_markdown: string;
  evidence_refs: ResourceRef[] | null;
  proposed_action: ProposedAction | null;
  confidence_evidence: ConfidenceEvidence | null;
  status: ProposalStatus;
  approved_by: string | null;
  approved_at: Date | string | null;
  approval_provenance: string | null;
  routine_key: string | null;
  run_id: string | null;
  dedupe_key: string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
};

type ProposalListRow = Omit<ProposalRow, "body_markdown"> & { body_chars: string | number };
type ProposalStateRow = { status: ProposalStatus; version: number };

const PROPOSAL_COLUMNS = `id, kind, title, body_markdown, evidence_refs, proposed_action,
  confidence_evidence, status, approved_by, approved_at, approval_provenance,
  routine_key, run_id, dedupe_key, version, created_at, updated_at`;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown, code: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AnalyserServiceError(400, code, "Invalid proposal input");
  return parsed.data;
}

function mapProposal(row: ProposalRow): ProposalRecord {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    bodyMarkdown: row.body_markdown,
    evidenceRefs: row.evidence_refs ?? [],
    ...(row.proposed_action === null ? {} : { proposedAction: row.proposed_action }),
    ...(row.confidence_evidence === null ? {} : { confidenceEvidence: row.confidence_evidence }),
    status: row.status,
    ...(row.approved_by === null ? {} : { approvedBy: row.approved_by }),
    ...(row.approved_at === null ? {} : { approvedAt: iso(row.approved_at) }),
    ...(row.approval_provenance === null ? {} : { approvalProvenance: row.approval_provenance }),
    ...(row.routine_key === null ? {} : { routineKey: row.routine_key }),
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    ...(row.dedupe_key === null ? {} : { dedupeKey: row.dedupe_key }),
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function mapProposalListItem(row: ProposalListRow): ProposalListItem {
  const full = mapProposal({ ...row, body_markdown: "" });
  const { bodyMarkdown: _body, ...metadata } = full;
  return { ...metadata, bodyChars: Number(row.body_chars) };
}

function encodeCursor(updatedAt: string, id: string): string {
  return Buffer.from(`${updatedAt}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): [string, string] {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const separator = decoded.lastIndexOf("|");
    const updatedAt = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    if (separator < 0 || Number.isNaN(new Date(updatedAt).getTime()) || !id || encodeCursor(updatedAt, id) !== cursor) throw new Error("invalid");
    return [updatedAt, id];
  } catch {
    throw new AnalyserServiceError(400, "INVALID_CURSOR", "Invalid proposal cursor");
  }
}

function boundedLimit(value: number | undefined): number {
  return value === undefined ? 50 : Math.min(200, Math.max(1, Math.trunc(value)));
}

async function proposalState(pool: AnalyserQueryPool, owner: string, id: string): Promise<ProposalStateRow> {
  const result = await pool.query<ProposalStateRow>(`SELECT status, version FROM analyser_proposals
    WHERE service_account_id = $1 AND id = $2`, [owner, id]);
  if (!result.rows[0]) throw new AnalyserServiceError(404, "PROPOSAL_NOT_FOUND", "Proposal not found");
  return result.rows[0];
}

export async function createProposal(owner: string, input: ProposalInput): Promise<{ proposal: ProposalRecord; created: boolean }> {
  return createProposalWithPool(getAnalyserPool(), owner, input);
}

export async function createProposalWithPool(
  pool: AnalyserQueryPool,
  owner: string,
  rawInput: ProposalInput
): Promise<{ proposal: ProposalRecord; created: boolean }> {
  const input = parse(proposalInputSchema, rawInput, "INVALID_PROPOSAL");
  const result = await pool.query<ProposalRow>(`INSERT INTO analyser_proposals
    (service_account_id, kind, title, body_markdown, evidence_refs, proposed_action,
      confidence_evidence, status, routine_key, run_id, dedupe_key)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, 'open', $8, $9, $10)
    ON CONFLICT (service_account_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
    RETURNING ${PROPOSAL_COLUMNS}`, [
    owner, input.kind, input.title, input.bodyMarkdown, JSON.stringify(input.evidenceRefs ?? []),
    input.proposedAction === undefined ? null : JSON.stringify(input.proposedAction),
    input.confidenceEvidence === undefined ? null : JSON.stringify(input.confidenceEvidence),
    input.routineKey ?? null, input.runId ?? null, input.dedupeKey ?? null
  ]);
  if (result.rows[0]) return { proposal: mapProposal(result.rows[0]), created: true };
  if (!input.dedupeKey) throw new AnalyserServiceError(500, "PROPOSAL_CREATE_FAILED", "Proposal was not created");
  const existing = await pool.query<ProposalRow>(`SELECT ${PROPOSAL_COLUMNS}
    FROM analyser_proposals WHERE service_account_id = $1 AND dedupe_key = $2`, [owner, input.dedupeKey]);
  if (!existing.rows[0]) throw new AnalyserServiceError(500, "PROPOSAL_CREATE_FAILED", "Proposal dedupe record not found");
  return { proposal: mapProposal(existing.rows[0]), created: false };
}

export async function getProposal(owner: string, id: string): Promise<ProposalRecord> {
  return getProposalWithPool(getAnalyserPool(), owner, id);
}

export async function getProposalWithPool(pool: AnalyserQueryPool, owner: string, id: string): Promise<ProposalRecord> {
  const result = await pool.query<ProposalRow>(`SELECT ${PROPOSAL_COLUMNS}
    FROM analyser_proposals WHERE service_account_id = $1 AND id = $2`, [owner, id]);
  if (!result.rows[0]) throw new AnalyserServiceError(404, "PROPOSAL_NOT_FOUND", "Proposal not found");
  return mapProposal(result.rows[0]);
}

export async function listProposals(
  owner: string,
  options: { status?: ProposalStatus; kind?: string; routineKey?: string; limit?: number; cursor?: string } = {}
): Promise<{ items: ProposalListItem[]; nextCursor?: string }> {
  return listProposalsWithPool(getAnalyserPool(), owner, options);
}

export async function listProposalsWithPool(
  pool: AnalyserQueryPool,
  owner: string,
  options: { status?: ProposalStatus; kind?: string; routineKey?: string; limit?: number; cursor?: string } = {}
): Promise<{ items: ProposalListItem[]; nextCursor?: string }> {
  const values: unknown[] = [owner];
  const where = ["service_account_id = $1"];
  const add = (clause: string, value: unknown): void => { values.push(value); where.push(clause.replace("?", `$${values.length}`)); };
  if (options.status) add("status = ?", options.status);
  if (options.kind) add("kind = ?", options.kind);
  if (options.routineKey) add("routine_key = ?", options.routineKey);
  if (options.cursor) {
    const [updatedAt, id] = decodeCursor(options.cursor);
    values.push(updatedAt, id);
    where.push(`(updated_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
  }
  const limit = boundedLimit(options.limit);
  values.push(limit + 1);
  const result = await pool.query<ProposalListRow>(`SELECT id, kind, title, evidence_refs, proposed_action,
      confidence_evidence, status, approved_by, approved_at, approval_provenance,
      routine_key, run_id, dedupe_key, version, created_at, updated_at,
      LENGTH(body_markdown)::integer AS body_chars
    FROM analyser_proposals WHERE ${where.join(" AND ")}
    ORDER BY updated_at DESC, id DESC LIMIT $${values.length}`, values);
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const tail = rows.at(-1);
  return { items: rows.map(mapProposalListItem), ...(hasMore && tail ? { nextCursor: encodeCursor(iso(tail.updated_at), tail.id) } : {}) };
}

export async function updateProposalContent(owner: string, id: string, input: ProposalContentUpdate): Promise<ProposalRecord> {
  return updateProposalContentWithPool(getAnalyserPool(), owner, id, input);
}

export async function updateProposalContentWithPool(
  pool: AnalyserQueryPool, owner: string, id: string, rawInput: ProposalContentUpdate
): Promise<ProposalRecord> {
  const input = parse(proposalContentUpdateSchema, rawInput, "INVALID_PROPOSAL_UPDATE");
  const result = await pool.query<ProposalRow>(`UPDATE analyser_proposals SET
      title = COALESCE($3, title), body_markdown = COALESCE($4, body_markdown),
      evidence_refs = COALESCE($5::jsonb, evidence_refs),
      proposed_action = CASE WHEN $6::boolean THEN $7::jsonb ELSE proposed_action END,
      confidence_evidence = CASE WHEN $8::boolean THEN $9::jsonb ELSE confidence_evidence END,
      version = version + 1, updated_at = NOW()
    WHERE service_account_id = $1 AND id = $2 AND status = 'open' AND version = $10
    RETURNING ${PROPOSAL_COLUMNS}`, [
    owner, id, input.title ?? null, input.bodyMarkdown ?? null,
    input.evidenceRefs === undefined ? null : JSON.stringify(input.evidenceRefs),
    input.proposedAction !== undefined, input.proposedAction === undefined ? null : JSON.stringify(input.proposedAction),
    input.confidenceEvidence !== undefined, input.confidenceEvidence === undefined ? null : JSON.stringify(input.confidenceEvidence),
    input.expectedVersion
  ]);
  if (result.rows[0]) return mapProposal(result.rows[0]);
  const state = await proposalState(pool, owner, id);
  if (state.status !== "open") throw new AnalyserServiceError(409, "PROPOSAL_NOT_OPEN", "Proposal is not open");
  throw new AnalyserServiceError(409, "VERSION_CONFLICT", "Proposal version conflict");
}

export async function resolveProposal(owner: string, id: string, input: ProposalResolution): Promise<ProposalRecord> {
  return resolveProposalWithPool(getAnalyserPool(), owner, id, input);
}

export async function resolveProposalWithPool(
  pool: AnalyserQueryPool, owner: string, id: string, rawInput: ProposalResolution
): Promise<ProposalRecord> {
  const input = parse(proposalResolutionSchema, rawInput, "INVALID_PROPOSAL_RESOLUTION");
  const result = await pool.query<ProposalRow>(`UPDATE analyser_proposals SET
      status = $3, approved_by = $4, approved_at = NOW(), approval_provenance = $5,
      version = version + 1, updated_at = NOW()
    WHERE service_account_id = $1 AND id = $2 AND status = 'open' AND version = $6
    RETURNING ${PROPOSAL_COLUMNS}`, [owner, id, input.status, input.resolvedBy, input.provenance, input.expectedVersion]);
  if (result.rows[0]) return mapProposal(result.rows[0]);
  const state = await proposalState(pool, owner, id);
  if (state.status !== "open") throw new AnalyserServiceError(409, "INVALID_TRANSITION", "Proposal cannot be resolved from its current status");
  throw new AnalyserServiceError(409, "VERSION_CONFLICT", "Proposal version conflict");
}

export async function markProposalExecuted(owner: string, id: string, input: ProposalExecution): Promise<ProposalRecord> {
  return markProposalExecutedWithPool(getAnalyserPool(), owner, id, input);
}

export async function markProposalExecutedWithPool(
  pool: AnalyserQueryPool, owner: string, id: string, rawInput: ProposalExecution
): Promise<ProposalRecord> {
  const input = parse(proposalExecutionSchema, rawInput, "INVALID_PROPOSAL_EXECUTION");
  const result = await pool.query<ProposalRow>(`UPDATE analyser_proposals proposal SET
      status = 'executed', version = proposal.version + 1, updated_at = NOW()
    WHERE proposal.service_account_id = $1 AND proposal.id = $2
      AND proposal.status = 'approved' AND proposal.version = $4
      AND EXISTS (SELECT 1 FROM analyser_operations operation
        WHERE operation.id = $3 AND operation.service_account_id = $1 AND operation.proposal_id = $2)
    RETURNING ${PROPOSAL_COLUMNS}`, [owner, id, input.operationId, input.expectedVersion]);
  if (result.rows[0]) return mapProposal(result.rows[0]);
  const check = await pool.query<ProposalStateRow & { operation_recorded: boolean }>(`SELECT proposal.status, proposal.version,
      EXISTS (SELECT 1 FROM analyser_operations operation
        WHERE operation.id = $3 AND operation.service_account_id = $1 AND operation.proposal_id = $2) AS operation_recorded
    FROM analyser_proposals proposal WHERE proposal.service_account_id = $1 AND proposal.id = $2`, [owner, id, input.operationId]);
  const state = check.rows[0];
  if (!state) throw new AnalyserServiceError(404, "PROPOSAL_NOT_FOUND", "Proposal not found");
  if (state.status !== "approved") throw new AnalyserServiceError(409, "INVALID_TRANSITION", "Only approved proposals can be executed");
  if (state.version !== input.expectedVersion) throw new AnalyserServiceError(409, "VERSION_CONFLICT", "Proposal version conflict");
  throw new AnalyserServiceError(400, "OPERATION_NOT_RECORDED", "Operation is not recorded for this proposal");
}

export async function supersedeProposal(owner: string, id: string, input: ProposalSupersede): Promise<ProposalRecord> {
  return supersedeProposalWithPool(getAnalyserPool(), owner, id, input);
}

export async function supersedeProposalWithPool(
  pool: AnalyserQueryPool, owner: string, id: string, rawInput: ProposalSupersede
): Promise<ProposalRecord> {
  const input = parse(proposalSupersedeSchema, rawInput, "INVALID_PROPOSAL_SUPERSEDE");
  const result = await pool.query<ProposalRow>(`UPDATE analyser_proposals SET
      status = 'superseded', version = version + 1, updated_at = NOW()
    WHERE service_account_id = $1 AND id = $2 AND status = 'open' AND version = $3
    RETURNING ${PROPOSAL_COLUMNS}`, [owner, id, input.expectedVersion]);
  if (result.rows[0]) return mapProposal(result.rows[0]);
  const state = await proposalState(pool, owner, id);
  if (state.status !== "open") throw new AnalyserServiceError(409, "INVALID_TRANSITION", "Only open proposals can be superseded");
  throw new AnalyserServiceError(409, "VERSION_CONFLICT", "Proposal version conflict");
}
