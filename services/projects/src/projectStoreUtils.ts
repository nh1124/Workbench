import { ensureProjectsSchema, getProjectsPool } from "./db.js";

export type CursorPayload = { t: string; id: string };

export class InvalidCursorError extends Error {
  constructor() {
    super("Invalid cursor");
    this.name = "InvalidCursorError";
  }
}

export class VersionConflictError extends Error {
  constructor(message = "Version conflict") {
    super(message);
    this.name = "VersionConflictError";
  }
}

export class DuplicateRelationError extends Error {
  constructor(message = "Project relation already exists") {
    super(message);
    this.name = "DuplicateRelationError";
  }
}

export class InvalidRelationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRelationError";
  }
}

export function normalizeOwner(ownerAccountId: string): string {
  const owner = ownerAccountId.trim().toLowerCase();
  if (!owner) throw new Error("Owner account id is required");
  return owner;
}

export function clampLimit(limit: number | undefined, defaultLimit = 20, maxLimit = 100): number {
  if (limit === undefined) return defaultLimit;
  if (!Number.isFinite(limit)) return defaultLimit;
  return Math.max(1, Math.min(maxLimit, Math.floor(limit)));
}

export function parseCursor(cursor: string | undefined): CursorPayload | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<CursorPayload>;
    if (typeof parsed.t !== "string" || typeof parsed.id !== "string" || !parsed.t || !parsed.id) {
      throw new InvalidCursorError();
    }
    if (!Number.isFinite(Date.parse(parsed.t))) throw new InvalidCursorError();
    return { t: parsed.t, id: parsed.id };
  } catch (error) {
    if (error instanceof InvalidCursorError) throw error;
    throw new InvalidCursorError();
  }
}

export function toCursor(timestamp: string | Date, id: string): string {
  const t = timestamp instanceof Date ? timestamp.toISOString() : new Date(timestamp).toISOString();
  return Buffer.from(JSON.stringify({ t, id }), "utf8").toString("base64url");
}

export async function projectExistsForOwner(projectId: string, ownerAccountId: string): Promise<boolean> {
  await ensureProjectsSchema();
  const owner = normalizeOwner(ownerAccountId);
  const result = await getProjectsPool().query(
    `SELECT 1 FROM projects WHERE id = $1 AND owner_account_id = $2 LIMIT 1`,
    [projectId, owner]
  );
  return (result.rowCount ?? 0) > 0;
}

export function iso(value: string | Date): string {
  return new Date(value).toISOString();
}
