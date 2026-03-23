import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { ensureArtifactsSchema, getArtifactsPool } from "./db.js";
import type {
  ArtifactFileData,
  ArtifactFileInput,
  ArtifactItem,
  ArtifactItemKind,
  ArtifactProjectSummary,
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
  projectName: string;
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
    projectName: projectName?.trim() || normalizedProjectId
  };
}

function buildStorageRelativePath(ownerUsername: string, projectId: string, itemId: string, originalName: string): string {
  const ext = path.extname(originalName).toLowerCase().replace(/[^.a-z0-9]/g, "");
  const projectSegment = path.posix.join(PROJECTS_STORAGE_DIR, safeStorageSegment(projectId));
  return path.posix.join(ownerStorageSegment(ownerUsername), projectSegment, `${itemId}${ext}`);
}

function resolveStorageAbsolutePath(storagePath: string): string {
  const resolved = path.resolve(storageRoot, storagePath);
  const rootWithSep = storageRoot.endsWith(path.sep) ? storageRoot : `${storageRoot}${path.sep}`;
  if (!resolved.startsWith(rootWithSep) && resolved !== storageRoot) {
    throw new Error("Invalid storage path");
  }
  return resolved;
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

async function readItemRowById(client: PoolClient, id: string, ownerUsername: string): Promise<ArtifactItemRow | undefined> {
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
        version,
        created_at,
        updated_at
      FROM artifact_items
      WHERE id = $1 AND owner_username = $2
      LIMIT 1
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
  await ensureArtifactsSchema();
  const pool = getArtifactsPool();
  const owner = normalizeOwner(ownerUsername);
  const normalizedRequestedProjectId = projectId?.trim();
  const values: Array<string> = [owner];
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
      version,
      created_at,
      updated_at
    FROM artifact_items
    WHERE owner_username = $1
  `;

  if (normalizedRequestedProjectId) {
    values.push(isFallbackDefaultProjectId(normalizedRequestedProjectId) ? FALLBACK_DEFAULT_PROJECT_ID : normalizedRequestedProjectId);
    sql += ` AND project_id = $2`;
  }

  sql += " ORDER BY path ASC, updated_at DESC";

  const result = await pool.query<ArtifactItemRow>(sql, values);
  return result.rows.map((row) => toArtifactItem(row, false));
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
          ELSE COALESCE(NULLIF(MAX(project_name), ''), project_id)
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
          version
        )
        VALUES ($1, $2, $3, $4, 'file', $5, $6, $7, $8, $9::jsonb, '', $10, $11, $12, 1)
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
        storagePath
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
    const nextProjectName = updates.projectName?.trim() || existing.project_name;
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

    nextPath = await ensureUniquePath(client, owner, existing.project_id, nextPath, id);
    const nextParentPath = parentPathFromPath(nextPath);

    if (existing.kind === "folder" && existing.path !== nextPath) {
      await upsertFolderByPath(client, owner, existing.project_id, nextProjectName ?? undefined, nextParentPath, nextScope);

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
          nextProjectName ?? null
        ]
      );

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

      for (const descendant of descendants.rows) {
        const suffix = descendant.path.slice(existing.path.length + 1);
        const descendantPath = `${nextPath}/${suffix}`;
        await client.query(
          `
            UPDATE artifact_items
            SET
              path = $3,
              parent_path = $4,
              updated_at = NOW()
            WHERE id = $1 AND owner_username = $2
          `,
          [descendant.id, owner, descendantPath, parentPathFromPath(descendantPath)]
        );
      }
    } else {
      await upsertFolderByPath(client, owner, existing.project_id, nextProjectName ?? undefined, nextParentPath, nextScope);

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
          nextProjectName ?? null
        ]
      );
    }

    const updated = await readItemRowById(client, id, owner);
    await touchUpdatedAt(client, owner, existing.project_id, nextParentPath);
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

    const deleteTargets: Array<{ id: string; storage_path: string | null }> = [];

    if (existing.kind === "folder") {
      const likePrefix = `${escapeLikePattern(existing.path)}/%`;
      const result = await client.query<{ id: string; storage_path: string | null }>(
        `
          SELECT id, storage_path
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
      deleteTargets.push({ id: existing.id, storage_path: existing.storage_path });
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
      deleteTargets
        .filter((row) => typeof row.storage_path === "string" && row.storage_path.length > 0)
        .map(async (row) => {
          try {
            const absolutePath = resolveStorageAbsolutePath(row.storage_path!);
            await fs.rm(absolutePath, { force: true });
          } catch {
            // Best effort deletion.
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

