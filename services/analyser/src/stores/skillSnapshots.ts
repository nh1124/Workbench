import { createHash } from "node:crypto";
import { getAnalyserPool } from "../db.js";
import { AnalyserServiceError } from "../serviceError.js";
import {
  skillSnapshotInputSchema,
  type SkillSnapshotInput,
  type SkillSnapshotListItem,
  type SkillSnapshotListQuery,
  type SkillSnapshotRecord
} from "../types.js";
import type { AnalyserQueryPool } from "./machines.js";

type SkillSnapshotRow = {
  id: string;
  skill_key: string;
  skill_version: string | null;
  content_hash: string;
  body_markdown?: string;
  source_ref: string | null;
  captured_at: Date | string;
  updated_at: Date | string;
};

const SKILL_SNAPSHOT_LIST_COLUMNS = `id, skill_key, skill_version, content_hash, source_ref,
  captured_at, updated_at`;
const SKILL_SNAPSHOT_COLUMNS = `${SKILL_SNAPSHOT_LIST_COLUMNS}, body_markdown`;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseInput(input: unknown): SkillSnapshotInput {
  const parsed = skillSnapshotInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new AnalyserServiceError(400, "INVALID_SKILL_SNAPSHOT", "Invalid skill snapshot input");
  }
  return parsed.data;
}

function mapSkillSnapshotListItem(row: SkillSnapshotRow): SkillSnapshotListItem {
  return {
    id: row.id,
    skillKey: row.skill_key,
    ...(row.skill_version === null ? {} : { skillVersion: row.skill_version }),
    contentHash: row.content_hash,
    ...(row.source_ref === null ? {} : { sourceRef: row.source_ref }),
    capturedAt: iso(row.captured_at),
    updatedAt: iso(row.updated_at)
  };
}

function mapSkillSnapshot(row: SkillSnapshotRow): SkillSnapshotRecord {
  return {
    ...mapSkillSnapshotListItem(row),
    bodyMarkdown: row.body_markdown ?? ""
  };
}

export function normalizeSkillBody(body: string): string {
  return body.replace(/\r\n?/g, "\n").replace(/\s+$/u, "");
}

export function hashSkillBody(body: string): string {
  return createHash("sha256").update(normalizeSkillBody(body), "utf8").digest("hex");
}

export async function upsertSkillSnapshot(
  owner: string,
  input: SkillSnapshotInput
): Promise<SkillSnapshotRecord> {
  return upsertSkillSnapshotWithPool(getAnalyserPool(), owner, input);
}

export async function upsertSkillSnapshotWithPool(
  pool: AnalyserQueryPool,
  owner: string,
  rawInput: SkillSnapshotInput
): Promise<SkillSnapshotRecord> {
  const input = parseInput(rawInput);
  const result = await pool.query<SkillSnapshotRow>(`INSERT INTO analyser_skill_snapshots
      (service_account_id, skill_key, skill_version, content_hash, body_markdown, source_ref)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (service_account_id, skill_key) DO UPDATE SET
      skill_version = EXCLUDED.skill_version,
      content_hash = EXCLUDED.content_hash,
      body_markdown = EXCLUDED.body_markdown,
      source_ref = EXCLUDED.source_ref,
      updated_at = NOW()
    RETURNING ${SKILL_SNAPSHOT_COLUMNS}`, [
    owner,
    input.skillKey,
    input.skillVersion ?? null,
    hashSkillBody(input.bodyMarkdown),
    input.bodyMarkdown,
    input.sourceRef ?? null
  ]);
  return mapSkillSnapshot(result.rows[0]);
}

export async function listSkillSnapshots(
  owner: string,
  options: SkillSnapshotListQuery = {}
): Promise<{ items: SkillSnapshotListItem[] }> {
  return listSkillSnapshotsWithPool(getAnalyserPool(), owner, options);
}

export async function listSkillSnapshotsWithPool(
  pool: AnalyserQueryPool,
  owner: string,
  options: SkillSnapshotListQuery = {}
): Promise<{ items: SkillSnapshotListItem[] }> {
  const limit = options.limit ?? 200;
  const result = await pool.query<SkillSnapshotRow>(`SELECT ${SKILL_SNAPSHOT_LIST_COLUMNS}
    FROM analyser_skill_snapshots
    WHERE service_account_id = $1
    ORDER BY skill_key
    LIMIT $2`, [owner, limit]);
  return { items: result.rows.map(mapSkillSnapshotListItem) };
}

export async function getSkillSnapshot(owner: string, skillKey: string): Promise<SkillSnapshotRecord | null> {
  return getSkillSnapshotWithPool(getAnalyserPool(), owner, skillKey);
}

export async function getSkillSnapshotWithPool(
  pool: AnalyserQueryPool,
  owner: string,
  skillKey: string
): Promise<SkillSnapshotRecord | null> {
  const result = await pool.query<SkillSnapshotRow>(`SELECT ${SKILL_SNAPSHOT_COLUMNS}
    FROM analyser_skill_snapshots
    WHERE service_account_id = $1 AND skill_key = $2`, [owner, skillKey]);
  return result.rows[0] ? mapSkillSnapshot(result.rows[0]) : null;
}
