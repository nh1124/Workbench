import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

export type ManifestResource = {
  relativePath: string;
  domain: "artifacts";
  kind: "note" | "file";
  resourceId?: string;
  checksum?: string;
  sizeBytes?: number;
  dirty?: boolean;
  lastSeenAt?: string;
  lastSyncedAt?: string;
  localUpdatedAt?: string;
  lastError?: string;
};

export type OutboxItem = {
  id: string;
  clientOpId: string;
  relativePath: string;
  domain: "artifacts";
  action: "create" | "update" | "delete";
  resourceId?: string;
  payload: Record<string, unknown>;
  status: "pending" | "applied" | "failed";
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
};

export type Manifest = {
  jobs?: unknown[];
  resources?: ManifestResource[];
  outbox?: OutboxItem[];
  lastScanAt?: string;
  lastPushAt?: string;
};

export type ManifestStore = {
  db: DatabaseSync;
  path: string;
};

type ResourceRow = {
  relative_path: string;
  domain: string;
  kind: string;
  resource_id: string | null;
  checksum: string | null;
  size_bytes: number | null;
  dirty: number;
  last_seen_at: string | null;
  last_synced_at: string | null;
  local_updated_at: string | null;
  last_error: string | null;
};

type OutboxRow = {
  id: string;
  client_op_id: string;
  relative_path: string;
  domain: string;
  action: string;
  resource_id: string | null;
  payload_json: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  applied_at: string | null;
};

type JobRow = {
  job_id: string;
  kind: string;
  target: string;
  result_json: string;
  completed_at: string;
};

type MetaRow = {
  key: string;
  value: string;
};

type NormalizedManifest = {
  jobs: unknown[];
  resources: ManifestResource[];
  outbox: OutboxItem[];
  lastScanAt?: string;
  lastPushAt?: string;
};

function manifestDbPath(syncRoot: string): string {
  return join(syncRoot, ".workbench", "manifest.sqlite");
}

function manifestJsonPath(syncRoot: string): string {
  return join(syncRoot, ".workbench", "manifest.json");
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseJsonRecord(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return jsonRecord(JSON.parse(raw));
  } catch {
    return {};
  }
}

function parseJsonValue(raw: string | null | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function toResource(row: ResourceRow): ManifestResource {
  return {
    relativePath: row.relative_path,
    domain: row.domain === "artifacts" ? "artifacts" : "artifacts",
    kind: row.kind === "file" ? "file" : "note",
    resourceId: row.resource_id ?? undefined,
    checksum: row.checksum ?? undefined,
    sizeBytes: row.size_bytes ?? undefined,
    dirty: row.dirty === 1,
    lastSeenAt: row.last_seen_at ?? undefined,
    lastSyncedAt: row.last_synced_at ?? undefined,
    localUpdatedAt: row.local_updated_at ?? undefined,
    lastError: row.last_error ?? undefined
  };
}

function toOutbox(row: OutboxRow): OutboxItem {
  return {
    id: row.id,
    clientOpId: row.client_op_id,
    relativePath: row.relative_path,
    domain: row.domain === "artifacts" ? "artifacts" : "artifacts",
    action: row.action === "delete" ? "delete" : row.action === "update" ? "update" : "create",
    resourceId: row.resource_id ?? undefined,
    payload: parseJsonRecord(row.payload_json),
    status: row.status === "applied" ? "applied" : row.status === "failed" ? "failed" : "pending",
    attempts: Number(row.attempts ?? 0),
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appliedAt: row.applied_at ?? undefined
  };
}

function toJob(row: JobRow): unknown {
  return {
    jobId: row.job_id,
    kind: row.kind,
    target: row.target,
    result: parseJsonValue(row.result_json),
    completedAt: row.completed_at
  };
}

function normalizeManifest(manifest: Manifest): NormalizedManifest {
  return {
    jobs: Array.isArray(manifest.jobs) ? manifest.jobs : [],
    resources: Array.isArray(manifest.resources) ? manifest.resources : [],
    outbox: Array.isArray(manifest.outbox) ? manifest.outbox : [],
    lastScanAt: manifest.lastScanAt,
    lastPushAt: manifest.lastPushAt
  };
}

export function openManifestStore(syncRoot: string): ManifestStore {
  const db = new DatabaseSync(manifestDbPath(syncRoot));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resources (
      relative_path TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      kind TEXT NOT NULL,
      resource_id TEXT,
      checksum TEXT,
      size_bytes INTEGER,
      dirty INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT,
      last_synced_at TEXT,
      local_updated_at TEXT,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY,
      client_op_id TEXT NOT NULL UNIQUE,
      relative_path TEXT NOT NULL,
      domain TEXT NOT NULL,
      action TEXT NOT NULL,
      resource_id TEXT,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      applied_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_outbox_status_created
      ON outbox (status, created_at);

    CREATE TABLE IF NOT EXISTS local_jobs (
      job_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      target TEXT NOT NULL,
      result_json TEXT NOT NULL,
      completed_at TEXT NOT NULL
    );
  `);
  return { db, path: manifestDbPath(syncRoot) };
}

export function closeManifestStore(store: ManifestStore): void {
  store.db.close();
}

export function readManifestFromStore(store: ManifestStore): Manifest {
  const resources = store.db.prepare(`
    SELECT relative_path, domain, kind, resource_id, checksum, size_bytes, dirty,
           last_seen_at, last_synced_at, local_updated_at, last_error
    FROM resources
    ORDER BY relative_path ASC
  `).all() as ResourceRow[];
  const outbox = store.db.prepare(`
    SELECT id, client_op_id, relative_path, domain, action, resource_id, payload_json,
           status, attempts, last_error, created_at, updated_at, applied_at
    FROM outbox
    ORDER BY created_at ASC
  `).all() as OutboxRow[];
  const jobs = store.db.prepare(`
    SELECT job_id, kind, target, result_json, completed_at
    FROM local_jobs
    ORDER BY completed_at DESC
    LIMIT 500
  `).all() as JobRow[];
  const meta = store.db.prepare("SELECT key, value FROM meta").all() as MetaRow[];
  const metaMap = new Map(meta.map((row) => [row.key, row.value]));
  return {
    jobs: jobs.map(toJob),
    resources: resources.map(toResource),
    outbox: outbox.map(toOutbox),
    lastScanAt: metaMap.get("lastScanAt"),
    lastPushAt: metaMap.get("lastPushAt")
  };
}

export function replaceManifestInStore(store: ManifestStore, manifest: Manifest): void {
  const normalized = normalizeManifest(manifest);
  store.db.exec("BEGIN IMMEDIATE");
  try {
    store.db.exec("DELETE FROM resources; DELETE FROM outbox; DELETE FROM local_jobs;");
    for (const resource of normalized.resources) {
      upsertResource(store, resource);
    }
    for (const item of normalized.outbox) {
      store.db.prepare(`
        INSERT INTO outbox (
          id, client_op_id, relative_path, domain, action, resource_id, payload_json,
          status, attempts, last_error, created_at, updated_at, applied_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id)
        DO UPDATE SET
          client_op_id = excluded.client_op_id,
          relative_path = excluded.relative_path,
          domain = excluded.domain,
          action = excluded.action,
          resource_id = excluded.resource_id,
          payload_json = excluded.payload_json,
          status = excluded.status,
          attempts = excluded.attempts,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at,
          applied_at = excluded.applied_at
      `).run(
        item.id,
        item.clientOpId,
        item.relativePath,
        item.domain,
        item.action,
        item.resourceId ?? null,
        JSON.stringify(item.payload ?? {}),
        item.status,
        item.attempts,
        item.lastError ?? null,
        item.createdAt,
        item.updatedAt,
        item.appliedAt ?? null
      );
    }
    for (const job of normalized.jobs) {
      const record = jsonRecord(job);
      const jobId = typeof record.jobId === "string" ? record.jobId : undefined;
      if (!jobId) continue;
      recordLocalJob(store, {
        jobId,
        kind: typeof record.kind === "string" ? record.kind : "unknown",
        target: typeof record.target === "string" ? record.target : "unknown",
        result: jsonRecord(record.result),
        completedAt: typeof record.completedAt === "string" ? record.completedAt : new Date().toISOString()
      });
    }
    setMeta(store, "lastScanAt", normalized.lastScanAt);
    setMeta(store, "lastPushAt", normalized.lastPushAt);
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}

export function setMeta(store: ManifestStore, key: string, value: string | undefined): void {
  if (!value) {
    store.db.prepare("DELETE FROM meta WHERE key = ?").run(key);
    return;
  }
  store.db.prepare(`
    INSERT INTO meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key)
    DO UPDATE SET value = excluded.value
  `).run(key, value);
}

export function readManifestStats(store: ManifestStore): {
  outboxPending: number;
  outboxFailed: number;
  lastScanAt?: string;
  lastPushAt?: string;
} {
  const pending = store.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE status = 'pending'").get() as { count: number };
  const failed = store.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE status = 'failed'").get() as { count: number };
  const meta = store.db.prepare("SELECT key, value FROM meta WHERE key IN ('lastScanAt', 'lastPushAt')").all() as MetaRow[];
  const metaMap = new Map(meta.map((row) => [row.key, row.value]));
  return {
    outboxPending: Number(pending.count ?? 0),
    outboxFailed: Number(failed.count ?? 0),
    lastScanAt: metaMap.get("lastScanAt"),
    lastPushAt: metaMap.get("lastPushAt")
  };
}

export function getResource(store: ManifestStore, relativePath: string): ManifestResource | undefined {
  const row = store.db.prepare(`
    SELECT relative_path, domain, kind, resource_id, checksum, size_bytes, dirty,
           last_seen_at, last_synced_at, local_updated_at, last_error
    FROM resources
    WHERE relative_path = ?
  `).get(relativePath) as ResourceRow | undefined;
  return row ? toResource(row) : undefined;
}

export function listResources(store: ManifestStore): ManifestResource[] {
  return (store.db.prepare(`
    SELECT relative_path, domain, kind, resource_id, checksum, size_bytes, dirty,
           last_seen_at, last_synced_at, local_updated_at, last_error
    FROM resources
    ORDER BY relative_path ASC
  `).all() as ResourceRow[]).map(toResource);
}

export function upsertResource(store: ManifestStore, resource: ManifestResource): void {
  store.db.prepare(`
    INSERT INTO resources (
      relative_path, domain, kind, resource_id, checksum, size_bytes, dirty,
      last_seen_at, last_synced_at, local_updated_at, last_error
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(relative_path)
    DO UPDATE SET
      domain = excluded.domain,
      kind = excluded.kind,
      resource_id = excluded.resource_id,
      checksum = excluded.checksum,
      size_bytes = excluded.size_bytes,
      dirty = excluded.dirty,
      last_seen_at = excluded.last_seen_at,
      last_synced_at = excluded.last_synced_at,
      local_updated_at = excluded.local_updated_at,
      last_error = excluded.last_error
  `).run(
    resource.relativePath,
    resource.domain,
    resource.kind,
    resource.resourceId ?? null,
    resource.checksum ?? null,
    resource.sizeBytes ?? null,
    resource.dirty ? 1 : 0,
    resource.lastSeenAt ?? null,
    resource.lastSyncedAt ?? null,
    resource.localUpdatedAt ?? null,
    resource.lastError ?? null
  );
}

export function removeResource(store: ManifestStore, relativePath: string): void {
  store.db.prepare("DELETE FROM resources WHERE relative_path = ?").run(relativePath);
}

export function hasOpenOutboxForPath(store: ManifestStore, relativePath: string): boolean {
  const row = store.db.prepare(`
    SELECT id
    FROM outbox
    WHERE relative_path = ? AND status != 'applied'
    LIMIT 1
  `).get(relativePath) as { id: string } | undefined;
  return Boolean(row);
}

export function enqueueOutbox(
  store: ManifestStore,
  item: Omit<OutboxItem, "id" | "clientOpId" | "status" | "attempts" | "createdAt" | "updatedAt">
): OutboxItem {
  const now = new Date().toISOString();
  const id = randomUUID();
  const outboxItem: OutboxItem = {
    ...item,
    id,
    clientOpId: `daemon-${id}`,
    status: "pending",
    attempts: 0,
    createdAt: now,
    updatedAt: now
  };
  store.db.prepare(`
    INSERT INTO outbox (
      id, client_op_id, relative_path, domain, action, resource_id, payload_json,
      status, attempts, last_error, created_at, updated_at, applied_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    outboxItem.id,
    outboxItem.clientOpId,
    outboxItem.relativePath,
    outboxItem.domain,
    outboxItem.action,
    outboxItem.resourceId ?? null,
    JSON.stringify(outboxItem.payload ?? {}),
    outboxItem.status,
    outboxItem.attempts,
    null,
    outboxItem.createdAt,
    outboxItem.updatedAt,
    null
  );
  return outboxItem;
}

export function listPendingOutbox(store: ManifestStore, limit: number): OutboxItem[] {
  return (store.db.prepare(`
    SELECT id, client_op_id, relative_path, domain, action, resource_id, payload_json,
           status, attempts, last_error, created_at, updated_at, applied_at
    FROM outbox
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT ?
  `).all(limit) as OutboxRow[]).map(toOutbox);
}

export function markOutboxApplied(store: ManifestStore, id: string, appliedAt: string): void {
  store.db.prepare(`
    UPDATE outbox
    SET status = 'applied',
        attempts = attempts + 1,
        applied_at = ?,
        updated_at = ?,
        last_error = NULL
    WHERE id = ?
  `).run(appliedAt, appliedAt, id);
}

export function markOutboxFailed(store: ManifestStore, id: string, errorMessage: string, updatedAt: string): void {
  store.db.prepare(`
    UPDATE outbox
    SET status = 'failed',
        attempts = attempts + 1,
        last_error = ?,
        updated_at = ?
    WHERE id = ?
  `).run(errorMessage.slice(0, 2000), updatedAt, id);
}

export function recordLocalJob(
  store: ManifestStore,
  job: { jobId: string; kind: string; target: string; result: Record<string, unknown>; completedAt: string }
): void {
  store.db.prepare(`
    INSERT INTO local_jobs (job_id, kind, target, result_json, completed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(job_id)
    DO UPDATE SET
      kind = excluded.kind,
      target = excluded.target,
      result_json = excluded.result_json,
      completed_at = excluded.completed_at
  `).run(job.jobId, job.kind, job.target, JSON.stringify(job.result), job.completedAt);
  store.db.prepare(`
    DELETE FROM local_jobs
    WHERE job_id NOT IN (
      SELECT job_id
      FROM local_jobs
      ORDER BY completed_at DESC
      LIMIT 500
    )
  `).run();
}

export async function migrateLegacyManifestJson(syncRoot: string, store: ManifestStore): Promise<void> {
  const path = manifestJsonPath(syncRoot);
  let parsed: Manifest | undefined;
  try {
    parsed = JSON.parse(await fs.readFile(path, "utf8")) as Manifest;
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;

  const current = readManifestFromStore(store);
  if ((current.resources?.length ?? 0) > 0 || (current.outbox?.length ?? 0) > 0 || (current.jobs?.length ?? 0) > 0) {
    return;
  }
  replaceManifestInStore(store, parsed);
}

export async function writeManifestDebugSnapshot(syncRoot: string, store: ManifestStore): Promise<void> {
  const path = manifestJsonPath(syncRoot);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, `${JSON.stringify(readManifestFromStore(store), null, 2)}\n`, "utf8");
}
