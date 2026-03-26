import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTasksSchema, getTasksPool } from "./db.js";
import type { TaskAttachment } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const storageRoot = path.resolve(
  __dirname,
  process.env.TASKS_STORAGE_DIR?.trim() || "../storage"
);

type AttachmentRow = {
  id: string;
  task_id: string;
  owner_username: string;
  filename: string;
  mime_type: string | null;
  size_bytes: string | number | null;
  storage_path: string;
  created_at: string;
};

function normalizeOwner(ownerCoreUserId: string): string {
  return ownerCoreUserId.trim().toLowerCase();
}

function ownerStorageSegment(ownerUsername: string): string {
  return createHash("sha256").update(ownerUsername).digest("hex").slice(0, 24);
}

function buildStoragePath(ownerUsername: string, taskId: string, attachmentId: string, originalFilename: string): string {
  const ext = path.extname(originalFilename).toLowerCase().replace(/[^.a-z0-9]/g, "");
  return path.posix.join(ownerStorageSegment(ownerUsername), taskId, `${attachmentId}${ext}`);
}

function resolveAbsolutePath(storagePath: string): string {
  const resolved = path.resolve(storageRoot, storagePath);
  const rootWithSep = storageRoot.endsWith(path.sep) ? storageRoot : `${storageRoot}${path.sep}`;
  if (!resolved.startsWith(rootWithSep) && resolved !== storageRoot) {
    throw new Error("Invalid storage path");
  }
  return resolved;
}

function parseSizeBytes(raw: string | number | null): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === "string") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function toAttachment(row: AttachmentRow): TaskAttachment {
  return {
    id: row.id,
    taskId: row.task_id,
    filename: row.filename,
    mimeType: row.mime_type ?? undefined,
    sizeBytes: parseSizeBytes(row.size_bytes),
    createdAt: new Date(row.created_at).toISOString()
  };
}

export async function listAttachments(taskId: string, ownerCoreUserId: string): Promise<TaskAttachment[]> {
  await ensureTasksSchema();
  const pool = getTasksPool();
  const owner = normalizeOwner(ownerCoreUserId);

  const result = await pool.query<AttachmentRow>(
    `
      SELECT id, task_id, owner_username, filename, mime_type, size_bytes, storage_path, created_at
      FROM task_attachments
      WHERE owner_username = $1 AND task_id = $2
      ORDER BY created_at ASC
    `,
    [owner, taskId]
  );

  return result.rows.map(toAttachment);
}

export async function createAttachment(
  taskId: string,
  ownerCoreUserId: string,
  file: { originalname: string; buffer: Buffer; mimetype: string; size: number }
): Promise<TaskAttachment> {
  await ensureTasksSchema();
  const pool = getTasksPool();
  const owner = normalizeOwner(ownerCoreUserId);

  const id = randomUUID();
  const storagePath = buildStoragePath(owner, taskId, id, file.originalname);
  const absolutePath = resolveAbsolutePath(storagePath);

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, file.buffer);

  const result = await pool.query<AttachmentRow>(
    `
      INSERT INTO task_attachments (id, task_id, owner_username, filename, mime_type, size_bytes, storage_path)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, task_id, owner_username, filename, mime_type, size_bytes, storage_path, created_at
    `,
    [id, taskId, owner, file.originalname, file.mimetype || null, file.size, storagePath]
  );

  return toAttachment(result.rows[0]);
}

export async function readAttachmentData(
  attachmentId: string,
  taskId: string,
  ownerCoreUserId: string
): Promise<{ attachment: TaskAttachment; buffer: Buffer; filename: string; mimeType: string } | undefined> {
  await ensureTasksSchema();
  const pool = getTasksPool();
  const owner = normalizeOwner(ownerCoreUserId);

  const result = await pool.query<AttachmentRow>(
    `
      SELECT id, task_id, owner_username, filename, mime_type, size_bytes, storage_path, created_at
      FROM task_attachments
      WHERE id = $1 AND task_id = $2 AND owner_username = $3
      LIMIT 1
    `,
    [attachmentId, taskId, owner]
  );

  const row = result.rows[0];
  if (!row) return undefined;

  const absolutePath = resolveAbsolutePath(row.storage_path);
  const buffer = await fs.readFile(absolutePath);

  return {
    attachment: toAttachment(row),
    buffer,
    filename: row.filename,
    mimeType: row.mime_type || "application/octet-stream"
  };
}

export async function deleteAttachment(
  attachmentId: string,
  taskId: string,
  ownerCoreUserId: string
): Promise<boolean> {
  await ensureTasksSchema();
  const pool = getTasksPool();
  const owner = normalizeOwner(ownerCoreUserId);

  const result = await pool.query<AttachmentRow>(
    `
      DELETE FROM task_attachments
      WHERE id = $1 AND task_id = $2 AND owner_username = $3
      RETURNING storage_path
    `,
    [attachmentId, taskId, owner]
  );

  if (result.rows.length === 0) return false;

  const storagePath = result.rows[0].storage_path;
  try {
    const absolutePath = resolveAbsolutePath(storagePath);
    await fs.rm(absolutePath, { force: true });
  } catch {
    // Best-effort file deletion.
  }

  return true;
}

export async function deleteAttachmentsForTask(taskId: string, ownerCoreUserId: string): Promise<void> {
  await ensureTasksSchema();
  const pool = getTasksPool();
  const owner = normalizeOwner(ownerCoreUserId);

  const result = await pool.query<{ storage_path: string }>(
    `
      DELETE FROM task_attachments
      WHERE task_id = $1 AND owner_username = $2
      RETURNING storage_path
    `,
    [taskId, owner]
  );

  await Promise.all(
    result.rows.map(async (row) => {
      try {
        const absolutePath = resolveAbsolutePath(row.storage_path);
        await fs.rm(absolutePath, { force: true });
      } catch {
        // Best-effort.
      }
    })
  );
}
