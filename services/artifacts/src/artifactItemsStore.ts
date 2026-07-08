import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { ensureArtifactsSchema, getArtifactsPool } from "./db.js";
import type {
  ArtifactFileData,
  ArtifactFileInput,
  ArtifactFileReplacementInput,
  ArtifactItem,
  ArtifactPreviewStatus,
  ArtifactItemKind,
  ArtifactProjectSummary,
  ArtifactItemListPage,
  ArtifactItemListOptions,
  ArtifactNotePatchInput,
  ArtifactNotePatchOperation,
  ArtifactNoteSectionUpdateInput,
  ArtifactItemUpdate,
  ArtifactNoteInput,
  ArtifactFolderInput,
  ArtifactScope
} from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const storageRoot = path.resolve(
  __dirname,
  process.env.ARTIFACTS_STORAGE_DIR?.trim() || "../storage"
);

const FALLBACK_DEFAULT_PROJECT_ID = "default";
const FALLBACK_DEFAULT_PROJECT_NAME = "default";
const PROJECTS_STORAGE_DIR = "projects";
const PREVIEWS_STORAGE_DIR = "_previews";
const WORD_PREVIEW_PENDING_STATUS: ArtifactPreviewStatus = "pending";
const WORD_PREVIEW_READY_STATUS: ArtifactPreviewStatus = "ready";
const WORD_PREVIEW_ERROR_STATUS: ArtifactPreviewStatus = "error";
const WORD_PREVIEW_TIMEOUT_MS = Number(process.env.ARTIFACTS_WORD_PREVIEW_TIMEOUT_MS || "120000");

type ArtifactItemRow = {
  id: string;
  owner_username: string;
  project_id: string;
  project_name: string | null;
  kind: ArtifactItemKind;
  title: string;
  path: string;
  parent_path: string;
  scope: ArtifactScope;
  tags_json: unknown;
  content_markdown: string | null;
  mime_type: string | null;
  size_bytes: string | number | null;
  storage_path: string | null;
  preview_pdf_storage_path: string | null;
  preview_pdf_size_bytes: string | number | null;
  preview_pdf_status: string | null;
  preview_pdf_error: string | null;
  preview_pdf_updated_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

type ArtifactProjectSummaryRow = {
  project_id: string;
  project_name: string | null;
  artifact_count: string;
  latest_updated_at: string;
};

function normalizeOwner(ownerUsername: string): string {
  const normalized = ownerUsername.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Owner username is required");
  }
  return normalized;
}

function normalizeScope(scope: string | undefined): ArtifactScope {
  const value = (scope ?? "private").trim().toLowerCase();
  if (value === "private" || value === "org" || value === "project") {
    return value;
  }
  return "private";
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags || tags.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const output: string[] = [];
  for (const tag of tags) {
    const normalized = tag.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }

  return output;
}

function parseTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const values = raw
    .map((item) => (typeof item === "string" ? item : String(item)))
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return normalizeTags(values);
}

function normalizePathSegment(segment: string): string {
  const trimmed = segment.trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed === "." || trimmed === "..") {
    return "";
  }

  return trimmed
    .replace(/[<>:"|?*\u0000-\u001F]/g, "-")
    .replace(/[\\/]/g, "-")
    .trim();
}

function normalizeItemPath(input: string): string {
  const replaced = input.replace(/\\/g, "/").trim();
  const segments = replaced
    .split("/")
    .map((segment) => normalizePathSegment(segment))
    .filter((segment) => segment.length > 0);

  return segments.join("/");
}

function parentPathFromPath(itemPath: string): string {
  const normalized = normalizeItemPath(itemPath);
  if (!normalized.includes("/")) {
    return "";
  }
  return normalized.slice(0, normalized.lastIndexOf("/"));
}

function leafNameFromPath(itemPath: string): string {
  const normalized = normalizeItemPath(itemPath);
  if (!normalized.includes("/")) {
    return normalized;
  }
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function splitLeafNameAndExt(leaf: string): { base: string; ext: string } {
  const dotIndex = leaf.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === leaf.length - 1) {
    return { base: leaf, ext: "" };
  }
  return {
    base: leaf.slice(0, dotIndex),
    ext: leaf.slice(dotIndex)
  };
}

function withNumericSuffix(itemPath: string, suffix: number): string {
  const parent = parentPathFromPath(itemPath);
  const leaf = leafNameFromPath(itemPath);
  const { base, ext } = splitLeafNameAndExt(leaf);
  const nextLeaf = `${base}-${suffix}${ext}`;
  return parent ? `${parent}/${nextLeaf}` : nextLeaf;
}

function parseSizeBytes(raw: string | number | null): number | undefined {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : undefined;
  }

  if (typeof raw === "string") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function normalizePreviewStatus(raw: string | null | undefined): ArtifactPreviewStatus | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === WORD_PREVIEW_PENDING_STATUS) return WORD_PREVIEW_PENDING_STATUS;
  if (value === WORD_PREVIEW_READY_STATUS) return WORD_PREVIEW_READY_STATUS;
  if (value === WORD_PREVIEW_ERROR_STATUS) return WORD_PREVIEW_ERROR_STATUS;
  return undefined;
}

function isWordDocumentFile(filePath: string, mimeType?: string | null): boolean {
  const normalizedMime = (mimeType ?? "").toLowerCase();
  if (
    normalizedMime.includes("application/msword") ||
    normalizedMime.includes("application/vnd.openxmlformats-officedocument.wordprocessingml.document") ||
    normalizedMime.includes("application/vnd.ms-word")
  ) {
    return true;
  }
  return /\.(doc|docx|docm)$/i.test(filePath);
}

function toArtifactItem(row: ArtifactItemRow, includeContent = false): ArtifactItem {
  const item: ArtifactItem = {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name ?? undefined,
    kind: row.kind,
    title: row.title,
    path: row.path,
    parentPath: row.parent_path,
    scope: normalizeScope(row.scope),
    tags: parseTags(row.tags_json),
    mimeType: row.mime_type ?? undefined,
    sizeBytes: parseSizeBytes(row.size_bytes),
    previewPdfStatus: normalizePreviewStatus(row.preview_pdf_status),
    previewPdfUpdatedAt: row.preview_pdf_updated_at ? new Date(row.preview_pdf_updated_at).toISOString() : undefined,
    version: row.version,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };

  if (includeContent) {
    item.contentMarkdown = row.content_markdown ?? "";
  }

  return item;
}

function isLikelyTextFile(mimeType: string | undefined, fileName: string): boolean {
  const mime = (mimeType ?? "").toLowerCase();
  if (mime.startsWith("text/")) {
    return true;
  }

  if (mime.includes("json") || mime.includes("xml") || mime.includes("javascript")) {
    return true;
  }

  const ext = path.extname(fileName).toLowerCase();
  return [
    ".md",
    ".markdown",
    ".txt",
    ".json",
    ".yaml",
    ".yml",
    ".xml",
    ".csv",
    ".log",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".css",
    ".html",
    ".sql"
  ].includes(ext);
}

function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function safeStorageSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized || "default";
}

function ownerStorageSegment(ownerUsername: string): string {
  return createHash("sha256").update(ownerUsername).digest("hex").slice(0, 24);
}

function isFallbackDefaultProjectId(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === FALLBACK_DEFAULT_PROJECT_ID;
}

function resolveProjectContext(projectId: string | undefined, projectName: string | undefined): {
  projectId: string;
  projectName: string | undefined;
} {
  const normalizedProjectId = projectId?.trim();
  if (!normalizedProjectId) {
    return {
      projectId: FALLBACK_DEFAULT_PROJECT_ID,
      projectName: FALLBACK_DEFAULT_PROJECT_NAME
    };
  }

  return {
    projectId: normalizedProjectId,
    projectName: projectName?.trim() || undefined
  };
}

function buildStorageRelativePath(ownerUsername: string, projectId: string, itemId: string, originalName: string): string {
  const ext = path.extname(originalName).toLowerCase().replace(/[^.a-z0-9]/g, "");
  const projectSegment = path.posix.join(PROJECTS_STORAGE_DIR, safeStorageSegment(projectId));
  return path.posix.join(ownerStorageSegment(ownerUsername), projectSegment, `${itemId}${ext}`);
}

function buildPreviewStorageRelativePath(ownerUsername: string, itemId: string): string {
  return path.posix.join(ownerStorageSegment(ownerUsername), PREVIEWS_STORAGE_DIR, `${itemId}.pdf`);
}

function resolveStorageAbsolutePath(storagePath: string): string {
  const resolved = path.resolve(storageRoot, storagePath);
  const rootWithSep = storageRoot.endsWith(path.sep) ? storageRoot : `${storageRoot}${path.sep}`;
  if (!resolved.startsWith(rootWithSep) && resolved !== storageRoot) {
    throw new Error("Invalid storage path");
  }
  return resolved;
}

async function runProcessWithTimeout(command: string, args: string[], timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let settled = false;
    let stderr = "";
    let stdout = "";

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`converter timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      const message = [stderr.trim(), stdout.trim()].filter(Boolean).join(" | ");
      reject(new Error(message || `converter exited with status ${code ?? "unknown"}`));
    });
  });
}

function resolveOfficeConverterCandidates(): string[] {
  const explicit = process.env.ARTIFACTS_OFFICE_CONVERTER_CMD?.trim();
  if (explicit) {
    return [explicit];
  }

  if (process.platform === "win32") {
    return [
      "soffice",
      "soffice.exe",
      "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
      "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe"
    ];
  }

  if (process.platform === "darwin") {
    return [
      "soffice",
      "/Applications/LibreOffice.app/Contents/MacOS/soffice"
    ];
  }

  return ["soffice", "libreoffice"];
}

async function convertWordFileToPdfBuffer(sourceAbsolutePath: string): Promise<Buffer> {
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-word-preview-"));
  const outDir = path.join(tmpBase, "out");
  try {
    await fs.mkdir(outDir, { recursive: true });
    const sourceName = path.basename(sourceAbsolutePath);
    const tempSourcePath = path.join(tmpBase, sourceName);
    await fs.copyFile(sourceAbsolutePath, tempSourcePath);

    const args = [
      "--headless",
      "--convert-to",
      "pdf:writer_pdf_Export",
      "--outdir",
      outDir,
      tempSourcePath
    ];

    const attempts: string[] = [];
    const commands = resolveOfficeConverterCandidates();
    for (const command of commands) {
      try {
        await runProcessWithTimeout(command, args, WORD_PREVIEW_TIMEOUT_MS);
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        attempts.push(`${command}: ${message}`);
        continue;
      }
    }

    const expectedPdfPath = path.join(outDir, `${path.parse(sourceName).name}.pdf`);
    let resolvedPdfPath = expectedPdfPath;
    try {
      await fs.access(expectedPdfPath);
    } catch {
      const outFiles = await fs.readdir(outDir);
      const discovered = outFiles.find((name) => name.toLowerCase().endsWith(".pdf"));
      if (!discovered) {
        throw new Error(
          `No PDF output found. Converter attempts: ${attempts.join(" || ") || "none"}`
        );
      }
      resolvedPdfPath = path.join(outDir, discovered);
    }

    return await fs.readFile(resolvedPdfPath);
  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {
      // Best-effort cleanup.
    });
  }
}

async function ensureUniquePath(
  client: PoolClient,
  ownerUsername: string,
  projectId: string,
  targetPath: string,
  excludeId?: string
): Promise<string> {
  const normalized = normalizeItemPath(targetPath);
  if (!normalized) {
    throw new Error("Path is required");
  }

  let candidate = normalized;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const values: Array<string> = [ownerUsername, projectId, candidate];
    let sql = `
      SELECT id
      FROM artifact_items
      WHERE owner_username = $1
        AND project_id = $2
        AND path = $3
    `;

    if (excludeId) {
      values.push(excludeId);
      sql += ` AND id <> $4`;
    }

    sql += " LIMIT 1";

    const result = await client.query<{ id: string }>(sql, values);
    if (result.rows.length === 0) {
      return candidate;
    }

    candidate = withNumericSuffix(normalized, attempt + 1);
  }

  throw new Error("Unable to allocate unique path");
}

async function ensureUniqueTreePath(
  client: PoolClient,
  ownerUsername: string,
  projectId: string,
  targetPath: string,
  excludeIds: string[]
): Promise<string> {
  const normalized = normalizeItemPath(targetPath);
  if (!normalized) {
    throw new Error("Path is required");
  }

  const uniqueExcludeIds = [...new Set(excludeIds.map((id) => id.trim()).filter((id) => id.length > 0))];
  let candidate = normalized;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const likePrefix = `${escapeLikePattern(candidate)}/%`;
    const result = await client.query<{ id: string }>(
      `
        SELECT id
        FROM artifact_items
        WHERE owner_username = $1
          AND project_id = $2
          AND (path = $3 OR path LIKE $4 ESCAPE '\\')
          AND NOT (id = ANY($5::text[]))
        LIMIT 1
      `,
      [ownerUsername, projectId, candidate, likePrefix, uniqueExcludeIds]
    );

    if (result.rows.length === 0) {
      return candidate;
    }

    candidate = withNumericSuffix(normalized, attempt + 1);
  }

  throw new Error("Unable to allocate unique folder path");
}

async function readItemRowById(
  client: PoolClient,
  id: string,
  ownerUsername: string,
  forUpdate = false
): Promise<ArtifactItemRow | undefined> {
  const result = await client.query<ArtifactItemRow>(
    `
      SELECT
        id,
        owner_username,
        project_id,
        project_name,
        kind,
        title,
        path,
        parent_path,
        scope,
        tags_json,
        content_markdown,
        mime_type,
        size_bytes,
        storage_path,
        preview_pdf_storage_path,
        preview_pdf_size_bytes,
        preview_pdf_status,
        preview_pdf_error,
        preview_pdf_updated_at,
        version,
        created_at,
        updated_at
      FROM artifact_items
      WHERE id = $1 AND owner_username = $2
      LIMIT 1
      ${forUpdate ? "FOR UPDATE" : ""}
    `,
    [id, ownerUsername]
  );

  return result.rows[0];
}

async function upsertFolderByPath(
  client: PoolClient,
  ownerUsername: string,
  projectId: string,
  projectName: string | undefined,
  folderPath: string,
  scope: ArtifactScope
): Promise<void> {
  const normalized = normalizeItemPath(folderPath);
  if (!normalized) {
    return;
  }

  const segments = normalized.split("/");
  let cursor = "";

  for (const segment of segments) {
    cursor = cursor ? `${cursor}/${segment}` : segment;
    const parentPath = parentPathFromPath(cursor);
    const title = leafNameFromPath(cursor);

    const existing = await client.query<{ id: string; kind: string }>(
      `
        SELECT id, kind
        FROM artifact_items
        WHERE owner_username = $1
          AND project_id = $2
          AND path = $3
        LIMIT 1
      `,
      [ownerUsername, projectId, cursor]
    );

    if (existing.rows.length > 0) {
      if (existing.rows[0].kind !== "folder") {
        throw new Error(`Path conflict at folder: ${cursor}`);
      }

      await client.query(
        `
          UPDATE artifact_items
          SET project_name = COALESCE($4, project_name), updated_at = NOW()
          WHERE owner_username = $1 AND project_id = $2 AND path = $3
        `,
        [ownerUsername, projectId, cursor, projectName ?? null]
      );
      continue;
    }

    await client.query(
      `
        INSERT INTO artifact_items (
          id,
          owner_username,
          project_id,
          project_name,
          kind,
          title,
          path,
          parent_path,
          scope,
          tags_json,
          content_markdown,
          mime_type,
          size_bytes,
          storage_path,
          version
        )
        VALUES ($1, $2, $3, $4, 'folder', $5, $6, $7, $8, '[]'::jsonb, '', NULL, NULL, NULL, 1)
      `,
      [randomUUID(), ownerUsername, projectId, projectName ?? null, title, cursor, parentPath, scope]
    );
  }
}

async function touchUpdatedAt(client: PoolClient, ownerUsername: string, projectId: string, folderPath: string): Promise<void> {
  const normalized = normalizeItemPath(folderPath);
  if (!normalized) {
    return;
  }

  await client.query(
    `
      UPDATE artifact_items
      SET updated_at = NOW()
      WHERE owner_username = $1
        AND project_id = $2
        AND path = $3
    `,
    [ownerUsername, projectId, normalized]
  );
}

function buildDefaultNotePath(title: string): string {
  const base = normalizePathSegment(title) || "untitled";
  return /\.[a-z0-9]{1,12}$/i.test(base) ? base : `${base}.md`;
}

function joinPath(parent: string | undefined, leaf: string): string {
  const normalizedLeaf = normalizeItemPath(leaf);
  const normalizedParent = normalizeItemPath(parent ?? "");
  if (!normalizedParent) {
    return normalizedLeaf;
  }
  return normalizedLeaf ? `${normalizedParent}/${normalizedLeaf}` : normalizedParent;
}

export async function listArtifactItems(projectId: string | undefined, ownerUsername: string): Promise<ArtifactItem[]> {
  return listArtifactItemsFiltered({ projectId }, ownerUsername);
}

export async function listArtifactItemsFiltered(
  options: ArtifactItemListOptions,
  ownerUsername: string
): Promise<ArtifactItem[]> {
  const page = await listArtifactItemsFilteredPage(options, ownerUsername);
  return page.items;
}

export async function listArtifactItemsFilteredPage(
  options: ArtifactItemListOptions,
  ownerUsername: string
): Promise<ArtifactItemListPage> {
  await ensureArtifactsSchema();
  const pool = getArtifactsPool();
  const owner = normalizeOwner(ownerUsername);
  const normalizedRequestedProjectId = options.projectId?.trim();
  const normalizedPathPrefix = normalizeItemPath(options.pathPrefix ?? "");
  const kinds = options.kinds?.filter((kind) => kind === "folder" || kind === "note" || kind === "file") ?? [];
  const updatedSince = options.updatedSince?.trim();
  const requestedLimit = options.limit;
  const limit = typeof requestedLimit === "number" && Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(Math.trunc(requestedLimit), 500))
    : undefined;
  const requestedOffset = options.cursor ? Number(options.cursor) : 0;
  const offset = Number.isFinite(requestedOffset) && requestedOffset > 0 ? Math.trunc(requestedOffset) : 0;
  const values: Array<string | string[] | number> = [owner];
  let sql = `
    SELECT
      id,
      owner_username,
      project_id,
      project_name,
      kind,
      title,
      path,
      parent_path,
      scope,
      tags_json,
      content_markdown,
      mime_type,
      size_bytes,
      storage_path,
          preview_pdf_storage_path,
          preview_pdf_size_bytes,
          preview_pdf_status,
          preview_pdf_error,
          preview_pdf_updated_at,
          version,
      created_at,
      updated_at
    FROM artifact_items
    WHERE owner_username = $1
  `;

  if (normalizedRequestedProjectId) {
    values.push(isFallbackDefaultProjectId(normalizedRequestedProjectId) ? FALLBACK_DEFAULT_PROJECT_ID : normalizedRequestedProjectId);
    sql += ` AND project_id = $${values.length}`;
  }

  if (normalizedPathPrefix) {
    values.push(normalizedPathPrefix, `${escapeLikePattern(normalizedPathPrefix)}/%`);
    sql += ` AND (path = $${values.length - 1} OR path LIKE $${values.length} ESCAPE '\\')`;
  }

  if (kinds.length > 0) {
    values.push(kinds);
    sql += ` AND kind = ANY($${values.length}::text[])`;
  }

  if (updatedSince) {
    const updatedSinceDate = new Date(updatedSince);
    if (Number.isNaN(updatedSinceDate.getTime())) {
      throw new Error("updatedSince must be a valid ISO date-time string");
    }
    values.push(updatedSinceDate.toISOString());
    sql += ` AND updated_at > $${values.length}::timestamptz`;
  }

  sql += " ORDER BY path ASC, project_id ASC, updated_at DESC, id ASC";
  if (limit) {
    values.push(limit + 1);
    sql += ` LIMIT $${values.length}`;
  }
  if (offset > 0) {
    values.push(offset);
    sql += ` OFFSET $${values.length}`;
  }

  const result = await pool.query<ArtifactItemRow>(sql, values);
  const rows = limit ? result.rows.slice(0, limit) : result.rows;
  const items = rows.map((row) => toArtifactItem(row, Boolean(options.includeContent) && row.kind === "note"));
  const nextCursor = limit && result.rows.length > limit ? String(offset + limit) : undefined;
  return { items, nextCursor };
}

export async function listArtifactItemProjects(ownerUsername: string): Promise<ArtifactProjectSummary[]> {
  await ensureArtifactsSchema();
  const pool = getArtifactsPool();
  const owner = normalizeOwner(ownerUsername);
  const result = await pool.query<ArtifactProjectSummaryRow>(
    `
      SELECT
        project_id,
        CASE
          WHEN project_id = $2 THEN $3
          ELSE NULLIF(MAX(project_name), '')
        END AS project_name,
        COUNT(*)::text AS artifact_count,
        MAX(updated_at) AS latest_updated_at
      FROM artifact_items
      WHERE owner_username = $1
      GROUP BY project_id
      ORDER BY MAX(updated_at) DESC
    `,
    [owner, FALLBACK_DEFAULT_PROJECT_ID, FALLBACK_DEFAULT_PROJECT_NAME]
  );

  return result.rows.map((row) => ({
    projectId: row.project_id,
    projectName: row.project_name ?? undefined,
    artifactCount: Number(row.artifact_count),
    latestUpdatedAt: new Date(row.latest_updated_at).toISOString()
  }));
}

export async function getArtifactItemDetail(id: string, ownerUsername: string): Promise<ArtifactItem | undefined> {
  await ensureArtifactsSchema();
  const pool = getArtifactsPool();
  const owner = normalizeOwner(ownerUsername);

  const client = await pool.connect();
  try {
    const row = await readItemRowById(client, id, owner);
    if (!row) {
      return undefined;
    }

    const item = toArtifactItem(row, true);

    if (row.kind === "file" && row.storage_path && isLikelyTextFile(item.mimeType, item.title)) {
      const maxPreviewSize = 1024 * 512;
      const size = item.sizeBytes ?? 0;
      if (size <= maxPreviewSize) {
        try {
          const absolutePath = resolveStorageAbsolutePath(row.storage_path);
          const fileText = await fs.readFile(absolutePath, "utf8");
          item.contentMarkdown = fileText;
        } catch {
          // Best effort preview only.
        }
      }
    }

    return item;
  } finally {
    client.release();
  }
}

function assertExpectedVersion(row: ArtifactItemRow, expectedVersion: number | undefined): void {
  if (expectedVersion === undefined) {
    return;
  }
  if (!Number.isInteger(expectedVersion) || expectedVersion <= 0) {
    throw new Error("expectedVersion must be a positive integer");
  }
  if (row.version !== expectedVersion) {
    throw new Error(`Version conflict: expected ${expectedVersion}, current ${row.version}`);
  }
}

function applyNotePatchOperation(content: string, operation: ArtifactNotePatchOperation): string {
  if (operation.type === "insert") {
    if (!Number.isInteger(operation.index) || operation.index < 0 || operation.index > content.length) {
      throw new Error("Insert index is out of range");
    }
    return `${content.slice(0, operation.index)}${operation.text}${content.slice(operation.index)}`;
  }

  if (!Number.isInteger(operation.start) || !Number.isInteger(operation.end)) {
    throw new Error("Patch start/end must be integers");
  }
  if (operation.start < 0 || operation.end < operation.start || operation.end > content.length) {
    throw new Error("Patch range is out of range");
  }

  if (operation.type === "delete") {
    return `${content.slice(0, operation.start)}${content.slice(operation.end)}`;
  }

  return `${content.slice(0, operation.start)}${operation.text}${content.slice(operation.end)}`;
}

function applyNotePatchOperations(content: string, operations: ArtifactNotePatchOperation[]): string {
  if (operations.length === 0) {
    throw new Error("At least one patch operation is required");
  }
  if (operations.length > 100) {
    throw new Error("Too many patch operations");
  }

  return operations.reduce((nextContent, operation) => applyNotePatchOperation(nextContent, operation), content);
}

function normalizeSectionBodyMarkdown(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim()
    .replace(/\n[ \t]*(?:\n[ \t]*){2,}/g, "\n\n");
}

function formatSectionBodyMarkdown(value: string): string {
  const normalized = normalizeSectionBodyMarkdown(value);
  return normalized ? `\n${normalized}\n\n` : "\n";
}

function findMarkdownSection(
  content: string,
  heading: string,
  level?: number
): { headingStart: number; bodyStart: number; sectionEnd: number; headingLine: string; level: number } | undefined {
  const normalizedHeading = heading.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalizedHeading) {
    throw new Error("heading is required");
  }

  const headingPattern = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(content)) !== null) {
    const headingLevel = match[1].length;
    if (level !== undefined && headingLevel !== level) {
      continue;
    }

    const text = match[2].trim().replace(/\s+/g, " ").toLowerCase();
    if (text !== normalizedHeading) {
      continue;
    }

    const headingStart = match.index;
    const lineEnd = content.indexOf("\n", headingStart);
    const bodyStart = lineEnd === -1 ? content.length : lineEnd + 1;
    const restPattern = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
    restPattern.lastIndex = bodyStart;

    let sectionEnd = content.length;
    let nextMatch: RegExpExecArray | null;
    while ((nextMatch = restPattern.exec(content)) !== null) {
      if (nextMatch[1].length <= headingLevel) {
        sectionEnd = nextMatch.index;
        break;
      }
    }

    return {
      headingStart,
      bodyStart,
      sectionEnd,
      headingLine: content.slice(headingStart, bodyStart),
      level: headingLevel
    };
  }

  return undefined;
}

function applyNoteSectionUpdate(content: string, input: ArtifactNoteSectionUpdateInput): string {
  const section = findMarkdownSection(content, input.heading, input.level);
  const mode = input.mode ?? "replaceBody";
  const nextBody = normalizeSectionBodyMarkdown(input.contentMarkdown);

  if (!section) {
    if (!input.createIfMissing) {
      throw new Error("Heading not found");
    }
    const level = input.level && input.level >= 1 && input.level <= 6 ? input.level : 2;
    const separator = content.trim().length === 0 ? "" : "\n\n";
    return `${content}${separator}${"#".repeat(level)} ${input.heading.trim()}\n${formatSectionBodyMarkdown(nextBody)}`;
  }

  const currentBody = normalizeSectionBodyMarkdown(content.slice(section.bodyStart, section.sectionEnd));
  let replacementBody = nextBody;
  if (mode === "appendBody") {
    replacementBody = [currentBody, nextBody].filter((part) => part.length > 0).join("\n\n");
  } else if (mode === "prependBody") {
    replacementBody = [nextBody, currentBody].filter((part) => part.length > 0).join("\n\n");
  }

  return `${content.slice(0, section.bodyStart)}${formatSectionBodyMarkdown(replacementBody)}${content.slice(section.sectionEnd)}`;
}

export const artifactItemsStoreTestHooks = {
  applyNoteSectionUpdate,
  resolveProjectContext
};

async function updateArtifactNoteContent(
  id: string,
  ownerUsername: string,
  input: { expectedVersion?: number; transform: (content: string) => string }
): Promise<ArtifactItem | undefined> {
  await ensureArtifactsSchema();
  const pool = getArtifactsPool();
  const owner = normalizeOwner(ownerUsername);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await readItemRowById(client, id, owner, true);
    if (!existing) {
      await client.query("ROLLBACK");
      return undefined;
    }
    if (existing.kind !== "note") {
      throw new Error("Only note items support markdown content updates");
    }

    assertExpectedVersion(existing, input.expectedVersion);
    const nextContent = input.transform(existing.content_markdown ?? "");

    await client.query(
      `
        UPDATE artifact_items
        SET
          content_markdown = $3,
          version = version + 1,
          updated_at = NOW()
        WHERE id = $1 AND owner_username = $2
      `,
      [id, owner, nextContent]
    );
    await touchUpdatedAt(client, owner, existing.project_id, existing.parent_path);

    const updated = await readItemRowById(client, id, owner);
    await client.query("COMMIT");
    return updated ? toArtifactItem(updated, true) : undefined;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function patchArtifactNoteContent(
  id: string,
  input: ArtifactNotePatchInput,
  ownerUsername: string
): Promise<ArtifactItem | undefined> {
  return updateArtifactNoteContent(id, ownerUsername, {
    expectedVersion: input.expectedVersion,
    transform: (content) => applyNotePatchOperations(content, input.operations)
  });
}

export async function updateArtifactNoteSection(
  id: string,
  input: ArtifactNoteSectionUpdateInput,
  ownerUsername: string
): Promise<ArtifactItem | undefined> {
  return updateArtifactNoteContent(id, ownerUsername, {
    expectedVersion: input.expectedVersion,
    transform: (content) => applyNoteSectionUpdate(content, input)
  });
}

export async function createArtifactFolder(input: ArtifactFolderInput, ownerUsername: string): Promise<ArtifactItem> {
  await ensureArtifactsSchema();
  const pool = getArtifactsPool();
  const owner = normalizeOwner(ownerUsername);
  const projectContext = resolveProjectContext(input.projectId, input.projectName);

  const requestedPath = normalizeItemPath(input.path || input.title || "");
  if (!requestedPath) {
    throw new Error("Folder path is required");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const uniquePath = await ensureUniquePath(client, owner, projectContext.projectId, requestedPath);
    const parentPath = parentPathFromPath(uniquePath);
    await upsertFolderByPath(
      client,
      owner,
      projectContext.projectId,
      projectContext.projectName,
      parentPath,
      normalizeScope(input.scope)
    );

    const id = randomUUID();
    const title = input.title?.trim() || leafNameFromPath(uniquePath);
    const result = await client.query<ArtifactItemRow>(
      `
        INSERT INTO artifact_items (
          id,
          owner_username,
          project_id,
          project_name,
          kind,
          title,
          path,
          parent_path,
          scope,
          tags_json,
          content_markdown,
          mime_type,
          size_bytes,
          storage_path,
          version
        )
        VALUES ($1, $2, $3, $4, 'folder', $5, $6, $7, $8, '[]'::jsonb, '', NULL, NULL, NULL, 1)
        RETURNING
          id,
          owner_username,
          project_id,
          project_name,
          kind,
          title,
          path,
          parent_path,
          scope,
          tags_json,
          content_markdown,
          mime_type,
          size_bytes,
          storage_path,
          preview_pdf_storage_path,
          preview_pdf_size_bytes,
          preview_pdf_status,
          preview_pdf_error,
          preview_pdf_updated_at,
          version,
          created_at,
          updated_at
      `,
      [
        id,
        owner,
        projectContext.projectId,
        projectContext.projectName ?? null,
        title,
        uniquePath,
        parentPath,
        normalizeScope(input.scope)
      ]
    );

    await touchUpdatedAt(client, owner, projectContext.projectId, parentPath);
    await client.query("COMMIT");
    return toArtifactItem(result.rows[0], true);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createArtifactNote(input: ArtifactNoteInput, ownerUsername: string): Promise<ArtifactItem> {
  await ensureArtifactsSchema();
  const pool = getArtifactsPool();
  const owner = normalizeOwner(ownerUsername);
  const projectContext = resolveProjectContext(input.projectId, input.projectName);

  const title = input.title.trim() || "Untitled";
  const rawPath = input.path?.trim() || buildDefaultNotePath(title);
  const normalizedPath = normalizeItemPath(rawPath);
  if (!normalizedPath) {
    throw new Error("Note path is required");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const uniquePath = await ensureUniquePath(client, owner, projectContext.projectId, normalizedPath);
    const parentPath = parentPathFromPath(uniquePath);
    await upsertFolderByPath(
      client,
      owner,
      projectContext.projectId,
      projectContext.projectName,
      parentPath,
      normalizeScope(input.scope)
    );

    const id = randomUUID();
    const result = await client.query<ArtifactItemRow>(
      `
        INSERT INTO artifact_items (
          id,
          owner_username,
          project_id,
          project_name,
          kind,
          title,
          path,
          parent_path,
          scope,
          tags_json,
          content_markdown,
          mime_type,
          size_bytes,
          storage_path,
          version
        )
        VALUES ($1, $2, $3, $4, 'note', $5, $6, $7, $8, $9::jsonb, $10, 'text/markdown', NULL, NULL, 1)
        RETURNING
          id,
          owner_username,
          project_id,
          project_name,
          kind,
          title,
          path,
          parent_path,
          scope,
          tags_json,
          content_markdown,
          mime_type,
          size_bytes,
          storage_path,
          preview_pdf_storage_path,
          preview_pdf_size_bytes,
          preview_pdf_status,
          preview_pdf_error,
          preview_pdf_updated_at,
          version,
          created_at,
          updated_at
      `,
      [
        id,
        owner,
        projectContext.projectId,
        projectContext.projectName ?? null,
        title,
        uniquePath,
        parentPath,
        normalizeScope(input.scope),
        JSON.stringify(normalizeTags(input.tags)),
        input.contentMarkdown ?? ""
      ]
    );

    await touchUpdatedAt(client, owner, projectContext.projectId, parentPath);
    await client.query("COMMIT");
    return toArtifactItem(result.rows[0], true);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createArtifactFile(input: ArtifactFileInput, ownerUsername: string): Promise<ArtifactItem> {
  await ensureArtifactsSchema();
  const pool = getArtifactsPool();
  const owner = normalizeOwner(ownerUsername);
  const projectContext = resolveProjectContext(input.projectId, input.projectName);

  const cleanFileName = normalizePathSegment(input.originalFilename) || "file";
  const requestedPath = joinPath(input.directoryPath, cleanFileName);
  const normalizedPath = normalizeItemPath(requestedPath);
  if (!normalizedPath) {
    throw new Error("File path is required");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const uniquePath = await ensureUniquePath(client, owner, projectContext.projectId, normalizedPath);
    const parentPath = parentPathFromPath(uniquePath);
    await upsertFolderByPath(
      client,
      owner,
      projectContext.projectId,
      projectContext.projectName,
      parentPath,
      normalizeScope(input.scope)
    );

    const id = randomUUID();
    const storagePath = buildStorageRelativePath(owner, projectContext.projectId, id, uniquePath);
    const absoluteStoragePath = resolveStorageAbsolutePath(storagePath);
    const shouldGenerateWordPreview = isWordDocumentFile(uniquePath, input.mimeType);

    await fs.mkdir(path.dirname(absoluteStoragePath), { recursive: true });
    await fs.writeFile(absoluteStoragePath, input.buffer);

    const inserted = await client.query<ArtifactItemRow>(
      `
        INSERT INTO artifact_items (
          id,
          owner_username,
          project_id,
          project_name,
          kind,
          title,
          path,
          parent_path,
          scope,
          tags_json,
          content_markdown,
          mime_type,
          size_bytes,
          storage_path,
          preview_pdf_status,
          version
        )
        VALUES ($1, $2, $3, $4, 'file', $5, $6, $7, $8, $9::jsonb, '', $10, $11, $12, $13, 1)
        RETURNING
          id,
          owner_username,
          project_id,
          project_name,
          kind,
          title,
          path,
          parent_path,
          scope,
          tags_json,
          content_markdown,
          mime_type,
          size_bytes,
          storage_path,
          preview_pdf_storage_path,
          preview_pdf_size_bytes,
          preview_pdf_status,
          preview_pdf_error,
          preview_pdf_updated_at,
          version,
          created_at,
          updated_at
      `,
      [
        id,
        owner,
        projectContext.projectId,
        projectContext.projectName ?? null,
        leafNameFromPath(uniquePath),
        uniquePath,
        parentPath,
        normalizeScope(input.scope),
        JSON.stringify(normalizeTags(input.tags)),
        input.mimeType || "application/octet-stream",
        input.sizeBytes,
        storagePath,
        shouldGenerateWordPreview ? WORD_PREVIEW_PENDING_STATUS : null
      ]
    );

    await touchUpdatedAt(client, owner, projectContext.projectId, parentPath);
    await client.query("COMMIT");
    return toArtifactItem(inserted.rows[0], false);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function replaceArtifactFileContent(
  id: string,
  input: ArtifactFileReplacementInput,
  ownerUsername: string
): Promise<ArtifactItem | undefined> {
  await ensureArtifactsSchema();
  const pool = getArtifactsPool();
  const owner = normalizeOwner(ownerUsername);

  const client = await pool.connect();
  let oldPreviewStoragePath: string | undefined;
  try {
    await client.query("BEGIN");

    const existing = await readItemRowById(client, id, owner, true);
    if (!existing) {
      await client.query("ROLLBACK");
      return undefined;
    }
    if (existing.kind !== "file" || !existing.storage_path) {
      throw new Error("Only file items support file content replacement");
    }
    if (input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
      throw new Error(`Artifact file version conflict: expected ${input.expectedVersion}, current ${existing.version}`);
    }

    const requestedFilename = input.originalFilename?.trim();
    const nextMimeType = input.mimeType || existing.mime_type || "application/octet-stream";
    let nextPath = existing.path;
    let nextParentPath = existing.parent_path;
    let nextStoragePath = existing.storage_path;
    let nextTitle = existing.title;

    if (requestedFilename) {
      const cleanFileName = normalizePathSegment(requestedFilename);
      if (cleanFileName) {
        const requestedPath = existing.parent_path ? `${existing.parent_path}/${cleanFileName}` : cleanFileName;
        nextPath = await ensureUniquePath(client, owner, existing.project_id, requestedPath, id);
        nextParentPath = parentPathFromPath(nextPath);
        nextTitle = leafNameFromPath(nextPath);
        nextStoragePath = buildStorageRelativePath(owner, existing.project_id, existing.id, nextPath);
      }
    }

    const absoluteStoragePath = resolveStorageAbsolutePath(nextStoragePath);
    await fs.mkdir(path.dirname(absoluteStoragePath), { recursive: true });
    await fs.writeFile(absoluteStoragePath, input.buffer);

    await upsertFolderByPath(
      client,
      owner,
      existing.project_id,
      existing.project_name ?? undefined,
      nextParentPath,
      normalizeScope(existing.scope)
    );

    const nextPreviewStatus = isWordDocumentFile(nextPath, nextMimeType) ? WORD_PREVIEW_PENDING_STATUS : null;
    oldPreviewStoragePath = existing.preview_pdf_storage_path ?? undefined;

    await client.query(
      `
        UPDATE artifact_items
        SET
          title = $3,
          path = $4,
          parent_path = $5,
          mime_type = $6,
          size_bytes = $7,
          storage_path = $8,
          preview_pdf_storage_path = NULL,
          preview_pdf_size_bytes = NULL,
          preview_pdf_status = $9,
          preview_pdf_error = NULL,
          preview_pdf_updated_at = NULL,
          version = version + 1,
          updated_at = NOW()
        WHERE id = $1 AND owner_username = $2
      `,
      [
        id,
        owner,
        nextTitle,
        nextPath,
        nextParentPath,
        nextMimeType,
        input.sizeBytes,
        nextStoragePath,
        nextPreviewStatus
      ]
    );

    const updated = await readItemRowById(client, id, owner);
    if (existing.parent_path !== nextParentPath) {
      await touchUpdatedAt(client, owner, existing.project_id, existing.parent_path);
    }
    await touchUpdatedAt(client, owner, existing.project_id, nextParentPath);
    await client.query("COMMIT");

    if (existing.storage_path !== nextStoragePath) {
      await fs.rm(resolveStorageAbsolutePath(existing.storage_path), { force: true }).catch(() => {
        // Best-effort cleanup of the old file path after extension changes.
      });
    }
    if (oldPreviewStoragePath) {
      await fs.rm(resolveStorageAbsolutePath(oldPreviewStoragePath), { force: true }).catch(() => {
        // Best-effort cleanup of stale previews.
      });
    }

    return updated ? toArtifactItem(updated, false) : undefined;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateArtifactItem(
  id: string,
  updates: ArtifactItemUpdate,
  ownerUsername: string
): Promise<ArtifactItem | undefined> {
  await ensureArtifactsSchema();
  const pool = getArtifactsPool();
  const owner = normalizeOwner(ownerUsername);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await readItemRowById(client, id, owner);
    if (!existing) {
      await client.query("ROLLBACK");
      return undefined;
    }

    const nextScope = updates.scope ? normalizeScope(updates.scope) : normalizeScope(existing.scope);
    const nextTags = updates.tags ? normalizeTags(updates.tags) : parseTags(existing.tags_json);
    const nextProjectId = updates.projectId?.trim() || existing.project_id;
    const projectChanged = nextProjectId !== existing.project_id;
    const nextProjectName = updates.projectName?.trim() || (projectChanged ? undefined : existing.project_name);
    const requestedPath = updates.path?.trim();
    const requestedTitle = updates.title?.trim();

    let nextPath = existing.path;
    if (requestedPath) {
      nextPath = normalizeItemPath(requestedPath);
    } else if (requestedTitle) {
      const parentPath = existing.parent_path;
      const currentLeaf = leafNameFromPath(existing.path);
      const { ext } = splitLeafNameAndExt(currentLeaf);
      const normalizedLeaf = normalizePathSegment(requestedTitle) || currentLeaf;
      const leaf = existing.kind === "file" && ext && !normalizedLeaf.toLowerCase().endsWith(ext.toLowerCase())
        ? `${normalizedLeaf}${ext}`
        : normalizedLeaf;
      nextPath = parentPath ? `${parentPath}/${leaf}` : leaf;
    }

    if (!nextPath) {
      throw new Error("Path is required");
    }

    let folderDescendants: Array<{ id: string; path: string }> = [];
    if (existing.kind === "folder") {
      const likePrefix = `${escapeLikePattern(existing.path)}/%`;
      const descendants = await client.query<{ id: string; path: string }>(
        `
          SELECT id, path
          FROM artifact_items
          WHERE owner_username = $1
            AND project_id = $2
            AND path LIKE $3 ESCAPE '\\'
          ORDER BY path ASC
        `,
        [owner, existing.project_id, likePrefix]
      );
      folderDescendants = descendants.rows;
      nextPath = await ensureUniqueTreePath(
        client,
        owner,
        nextProjectId,
        nextPath,
        [id, ...folderDescendants.map((descendant) => descendant.id)]
      );
    } else {
      nextPath = await ensureUniquePath(client, owner, nextProjectId, nextPath, id);
    }
    const nextParentPath = parentPathFromPath(nextPath);

    if (existing.kind === "folder" && (existing.path !== nextPath || projectChanged)) {
      await upsertFolderByPath(client, owner, nextProjectId, nextProjectName ?? undefined, nextParentPath, nextScope);

      await client.query(
        `
          UPDATE artifact_items
          SET
            title = $3,
            path = $4,
            parent_path = $5,
            scope = $6,
            tags_json = $7::jsonb,
            project_name = $8,
            project_id = $9,
            version = version + 1,
            updated_at = NOW()
          WHERE id = $1 AND owner_username = $2
        `,
        [
          id,
          owner,
          requestedTitle || leafNameFromPath(nextPath),
          nextPath,
          nextParentPath,
          nextScope,
          JSON.stringify(nextTags),
          nextProjectName ?? null,
          nextProjectId
        ]
      );

      for (const descendant of folderDescendants) {
        const suffix = descendant.path.slice(existing.path.length + 1);
        const descendantPath = `${nextPath}/${suffix}`;
        await client.query(
          `
            UPDATE artifact_items
            SET
              path = $3,
              parent_path = $4,
              project_id = $5,
              project_name = $6,
              updated_at = NOW()
            WHERE id = $1 AND owner_username = $2
          `,
          [descendant.id, owner, descendantPath, parentPathFromPath(descendantPath), nextProjectId, nextProjectName ?? null]
        );
      }
    } else {
      await upsertFolderByPath(client, owner, nextProjectId, nextProjectName ?? undefined, nextParentPath, nextScope);

      await client.query(
        `
          UPDATE artifact_items
          SET
            title = $3,
            path = $4,
            parent_path = $5,
            scope = $6,
            tags_json = $7::jsonb,
            content_markdown = $8,
            project_name = $9,
            project_id = $10,
            version = version + 1,
            updated_at = NOW()
          WHERE id = $1 AND owner_username = $2
        `,
        [
          id,
          owner,
          requestedTitle || existing.title,
          nextPath,
          nextParentPath,
          nextScope,
          JSON.stringify(nextTags),
          existing.kind === "note" ? updates.contentMarkdown ?? existing.content_markdown ?? "" : existing.content_markdown ?? "",
          nextProjectName ?? null,
          nextProjectId
        ]
      );
    }

    const updated = await readItemRowById(client, id, owner);
    if (projectChanged) {
      await touchUpdatedAt(client, owner, existing.project_id, existing.parent_path);
    }
    await touchUpdatedAt(client, owner, nextProjectId, nextParentPath);
    await client.query("COMMIT");

    if (!updated) {
      return undefined;
    }

    return toArtifactItem(updated, true);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteArtifactItem(id: string, ownerUsername: string): Promise<boolean> {
  await ensureArtifactsSchema();
  const pool = getArtifactsPool();
  const owner = normalizeOwner(ownerUsername);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await readItemRowById(client, id, owner);
    if (!existing) {
      await client.query("ROLLBACK");
      return false;
    }

    const deleteTargets: Array<{ id: string; storage_path: string | null; preview_pdf_storage_path: string | null }> = [];

    if (existing.kind === "folder") {
      const likePrefix = `${escapeLikePattern(existing.path)}/%`;
      const result = await client.query<{ id: string; storage_path: string | null; preview_pdf_storage_path: string | null }>(
        `
          SELECT id, storage_path, preview_pdf_storage_path
          FROM artifact_items
          WHERE owner_username = $1
            AND project_id = $2
            AND (path = $3 OR path LIKE $4 ESCAPE '\\')
        `,
        [owner, existing.project_id, existing.path, likePrefix]
      );

      deleteTargets.push(...result.rows);
      await client.query(
        `
          DELETE FROM artifact_items
          WHERE owner_username = $1
            AND project_id = $2
            AND (path = $3 OR path LIKE $4 ESCAPE '\\')
        `,
        [owner, existing.project_id, existing.path, likePrefix]
      );
    } else {
      deleteTargets.push({
        id: existing.id,
        storage_path: existing.storage_path,
        preview_pdf_storage_path: existing.preview_pdf_storage_path
      });
      await client.query(
        `
          DELETE FROM artifact_items
          WHERE id = $1 AND owner_username = $2
        `,
        [id, owner]
      );
    }

    await touchUpdatedAt(client, owner, existing.project_id, existing.parent_path);
    await client.query("COMMIT");

    await Promise.all(
      deleteTargets.map(async (row) => {
        const targets = [row.storage_path, row.preview_pdf_storage_path].filter(
          (value): value is string => typeof value === "string" && value.length > 0
        );
        for (const storage of targets) {
          try {
            const absolutePath = resolveStorageAbsolutePath(storage);
            await fs.rm(absolutePath, { force: true });
          } catch {
            // Best effort deletion.
          }
        }
      })
    );

    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function generateWordPreviewPdf(id: string, ownerUsername: string): Promise<ArtifactPreviewStatus | undefined> {
  await ensureArtifactsSchema();
  const pool = getArtifactsPool();
  const owner = normalizeOwner(ownerUsername);

  const client = await pool.connect();
  let row: ArtifactItemRow | undefined;
  let previewStoragePath: string | undefined;
  try {
    await client.query("BEGIN");
    row = await readItemRowById(client, id, owner);
    if (!row || row.kind !== "file" || !row.storage_path) {
      await client.query("ROLLBACK");
      return undefined;
    }

    if (!isWordDocumentFile(row.path, row.mime_type)) {
      await client.query("ROLLBACK");
      return undefined;
    }

    const currentStatus = normalizePreviewStatus(row.preview_pdf_status);
    if (currentStatus === WORD_PREVIEW_PENDING_STATUS) {
      await client.query("ROLLBACK");
      return WORD_PREVIEW_PENDING_STATUS;
    }

    previewStoragePath = row.preview_pdf_storage_path || buildPreviewStorageRelativePath(owner, row.id);

    await client.query(
      `
        UPDATE artifact_items
        SET
          preview_pdf_status = $3,
          preview_pdf_error = NULL
        WHERE id = $1 AND owner_username = $2
      `,
      [row.id, owner, WORD_PREVIEW_PENDING_STATUS]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  if (!row || !previewStoragePath) {
    return undefined;
  }
  if (!row.storage_path) {
    return undefined;
  }

  const sourceAbsolutePath = resolveStorageAbsolutePath(row.storage_path);

  try {
    const pdfBuffer = await convertWordFileToPdfBuffer(sourceAbsolutePath);
    const previewAbsolutePath = resolveStorageAbsolutePath(previewStoragePath);
    await fs.mkdir(path.dirname(previewAbsolutePath), { recursive: true });
    await fs.writeFile(previewAbsolutePath, pdfBuffer);

    await pool.query(
      `
        UPDATE artifact_items
        SET
          preview_pdf_storage_path = $3,
          preview_pdf_size_bytes = $4,
          preview_pdf_status = $5,
          preview_pdf_error = NULL,
          preview_pdf_updated_at = NOW()
        WHERE id = $1 AND owner_username = $2
      `,
      [row.id, owner, previewStoragePath, pdfBuffer.length, WORD_PREVIEW_READY_STATUS]
    );

    return WORD_PREVIEW_READY_STATUS;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Word preview conversion failed";
    await pool.query(
      `
        UPDATE artifact_items
        SET
          preview_pdf_status = $3,
          preview_pdf_error = $4
        WHERE id = $1 AND owner_username = $2
      `,
      [row.id, owner, WORD_PREVIEW_ERROR_STATUS, message.slice(0, 800)]
    );
    return WORD_PREVIEW_ERROR_STATUS;
  }
}

export async function readArtifactPreviewPdfData(id: string, ownerUsername: string): Promise<ArtifactFileData | undefined> {
  await ensureArtifactsSchema();
  const pool = getArtifactsPool();
  const owner = normalizeOwner(ownerUsername);

  const client = await pool.connect();
  try {
    const row = await readItemRowById(client, id, owner);
    if (!row || row.kind !== "file" || !row.preview_pdf_storage_path) {
      return undefined;
    }
    if (normalizePreviewStatus(row.preview_pdf_status) !== WORD_PREVIEW_READY_STATUS) {
      return undefined;
    }

    const absolutePath = resolveStorageAbsolutePath(row.preview_pdf_storage_path);
    const fileBuffer = await fs.readFile(absolutePath);
    const item = toArtifactItem(row, false);

    const sourceBase = path.basename(row.path, path.extname(row.path));
    return {
      item,
      buffer: fileBuffer,
      mimeType: "application/pdf",
      fileName: `${sourceBase}.pdf`
    };
  } catch {
    return undefined;
  } finally {
    client.release();
  }
}

export async function readArtifactFileData(id: string, ownerUsername: string): Promise<ArtifactFileData | undefined> {
  await ensureArtifactsSchema();
  const pool = getArtifactsPool();
  const owner = normalizeOwner(ownerUsername);

  const client = await pool.connect();
  try {
    const row = await readItemRowById(client, id, owner);
    if (!row || row.kind !== "file" || !row.storage_path) {
      return undefined;
    }

    const absolutePath = resolveStorageAbsolutePath(row.storage_path);
    const fileBuffer = await fs.readFile(absolutePath);
    const item = toArtifactItem(row, false);

    return {
      item,
      buffer: fileBuffer,
      mimeType: row.mime_type || "application/octet-stream",
      fileName: row.title
    };
  } finally {
    client.release();
  }
}

