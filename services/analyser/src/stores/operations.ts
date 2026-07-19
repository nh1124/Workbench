import { getAnalyserPool } from "../db.js";
import { AnalyserServiceError } from "../serviceError.js";
import {
  ANALYSER_OPERATION_KINDS,
  operationInputSchema,
  type AnalyserOperationKind,
  type OperationInput,
  type OperationRecord,
  type ResourceRef
} from "../types.js";
import type { AnalyserQueryPool } from "./machines.js";
import { getEffectiveAutomationPolicyWithPool, type AnalyserTransactionPool } from "./policies.js";

type OperationRow = {
  id: string;
  operation_kind: AnalyserOperationKind;
  approval_basis: "policy" | "proposal";
  proposal_id: string | null;
  before_refs: ResourceRef[] | null;
  after_refs: ResourceRef[] | null;
  result: "succeeded" | "failed" | "skipped";
  detail: Record<string, string | number | boolean | null> | null;
  run_id: string | null;
  agent_label: string | null;
  idempotency_key: string;
  created_at: Date | string;
};

const OPERATION_COLUMNS = `id, operation_kind, approval_basis, proposal_id, before_refs,
  after_refs, result, detail, run_id, agent_label, idempotency_key, created_at`;
const SECRET_DETAIL_KEY = /^(token|secret|password|authorization|cookie)$/i;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapOperation(row: OperationRow): OperationRecord {
  return {
    id: row.id,
    operationKind: row.operation_kind,
    approvalBasis: row.approval_basis,
    ...(row.proposal_id === null ? {} : { proposalId: row.proposal_id }),
    beforeRefs: row.before_refs ?? [],
    afterRefs: row.after_refs ?? [],
    result: row.result,
    ...(row.detail === null ? {} : { detail: row.detail }),
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    ...(row.agent_label === null ? {} : { agentLabel: row.agent_label }),
    idempotencyKey: row.idempotency_key,
    createdAt: iso(row.created_at)
  };
}

function parseInput(value: unknown): OperationInput {
  const rawKind = value && typeof value === "object" ? (value as { operationKind?: unknown }).operationKind : undefined;
  if (typeof rawKind !== "string" || !(ANALYSER_OPERATION_KINDS as readonly string[]).includes(rawKind)) {
    throw new AnalyserServiceError(400, "OPERATION_KIND_NOT_ALLOWED", "Operation kind is not allowed");
  }
  const parsed = operationInputSchema.safeParse(value);
  if (!parsed.success) throw new AnalyserServiceError(400, "INVALID_OPERATION", "Invalid operation input");
  return parsed.data;
}

function sanitizeDetail(detail: OperationInput["detail"]): Record<string, string | number | boolean | null> | undefined {
  if (detail === undefined) return undefined;
  return Object.fromEntries(Object.entries(detail).filter(([key]) => !SECRET_DETAIL_KEY.test(key)));
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): [string, string] {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const separator = decoded.lastIndexOf("|");
    const createdAt = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    if (separator < 0 || Number.isNaN(new Date(createdAt).getTime()) || !id || encodeCursor(createdAt, id) !== cursor) throw new Error("invalid");
    return [createdAt, id];
  } catch {
    throw new AnalyserServiceError(400, "INVALID_CURSOR", "Invalid operation cursor");
  }
}

function boundedLimit(value: number | undefined): number {
  return value === undefined ? 50 : Math.min(200, Math.max(1, Math.trunc(value)));
}

export async function recordOperation(owner: string, input: OperationInput): Promise<{ operation: OperationRecord; created: boolean }> {
  return recordOperationWithPool(getAnalyserPool(), owner, input);
}

export async function recordOperationWithPool(
  pool: AnalyserTransactionPool,
  owner: string,
  rawInput: OperationInput
): Promise<{ operation: OperationRecord; created: boolean }> {
  const input = parseInput(rawInput);
  const detail = sanitizeDetail(input.detail);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (input.approvalBasis === "policy") {
      const policy = await getEffectiveAutomationPolicyWithPool(client, owner);
      if (!policy.enabled || !policy.allowedOperationKinds.includes(input.operationKind)) {
        throw new AnalyserServiceError(403, "POLICY_FORBIDDEN", "Automation policy does not allow this operation");
      }
    } else {
      const approved = await client.query<{ id: string }>(`SELECT id FROM analyser_proposals
        WHERE service_account_id = $1 AND id = $2 AND status = 'approved'`, [owner, input.proposalId]);
      if (!approved.rows[0]) throw new AnalyserServiceError(409, "PROPOSAL_NOT_APPROVED", "Proposal is not approved");
    }
    const inserted = await client.query<OperationRow>(`INSERT INTO analyser_operations
      (service_account_id, operation_kind, approval_basis, proposal_id, before_refs,
        after_refs, result, detail, run_id, agent_label, idempotency_key)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9, $10, $11)
      ON CONFLICT (service_account_id, idempotency_key) DO NOTHING
      RETURNING ${OPERATION_COLUMNS}`, [
      owner, input.operationKind, input.approvalBasis, input.proposalId ?? null,
      JSON.stringify(input.beforeRefs ?? []), JSON.stringify(input.afterRefs ?? []), input.result,
      detail === undefined ? null : JSON.stringify(detail), input.runId ?? null,
      input.agentLabel ?? null, input.idempotencyKey
    ]);
    let operation: OperationRecord;
    let created: boolean;
    if (inserted.rows[0]) {
      operation = mapOperation(inserted.rows[0]);
      created = true;
    } else {
      const existing = await client.query<OperationRow>(`SELECT ${OPERATION_COLUMNS}
        FROM analyser_operations WHERE service_account_id = $1 AND idempotency_key = $2`, [owner, input.idempotencyKey]);
      if (!existing.rows[0]) throw new AnalyserServiceError(500, "OPERATION_RECORD_FAILED", "Operation dedupe record not found");
      operation = mapOperation(existing.rows[0]);
      created = false;
    }
    await client.query("COMMIT");
    return { operation, created };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getOperation(owner: string, id: string): Promise<OperationRecord> {
  return getOperationWithPool(getAnalyserPool(), owner, id);
}

export async function getOperationWithPool(pool: AnalyserQueryPool, owner: string, id: string): Promise<OperationRecord> {
  const result = await pool.query<OperationRow>(`SELECT ${OPERATION_COLUMNS}
    FROM analyser_operations WHERE service_account_id = $1 AND id = $2`, [owner, id]);
  if (!result.rows[0]) throw new AnalyserServiceError(404, "OPERATION_NOT_FOUND", "Operation not found");
  return mapOperation(result.rows[0]);
}

export async function listOperations(
  owner: string,
  options: { operationKind?: AnalyserOperationKind; result?: OperationRecord["result"]; proposalId?: string; limit?: number; cursor?: string } = {}
): Promise<{ items: OperationRecord[]; nextCursor?: string }> {
  return listOperationsWithPool(getAnalyserPool(), owner, options);
}

export async function listOperationsWithPool(
  pool: AnalyserQueryPool,
  owner: string,
  options: { operationKind?: AnalyserOperationKind; result?: OperationRecord["result"]; proposalId?: string; limit?: number; cursor?: string } = {}
): Promise<{ items: OperationRecord[]; nextCursor?: string }> {
  const values: unknown[] = [owner];
  const where = ["service_account_id = $1"];
  const add = (clause: string, value: unknown): void => { values.push(value); where.push(clause.replace("?", `$${values.length}`)); };
  if (options.operationKind) add("operation_kind = ?", options.operationKind);
  if (options.result) add("result = ?", options.result);
  if (options.proposalId) add("proposal_id = ?", options.proposalId);
  if (options.cursor) {
    const [createdAt, id] = decodeCursor(options.cursor);
    values.push(createdAt, id);
    where.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
  }
  const limit = boundedLimit(options.limit);
  values.push(limit + 1);
  const result = await pool.query<OperationRow>(`SELECT ${OPERATION_COLUMNS}
    FROM analyser_operations WHERE ${where.join(" AND ")}
    ORDER BY created_at DESC, id DESC LIMIT $${values.length}`, values);
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const tail = rows.at(-1);
  return { items: rows.map(mapOperation), ...(hasMore && tail ? { nextCursor: encodeCursor(iso(tail.created_at), tail.id) } : {}) };
}
