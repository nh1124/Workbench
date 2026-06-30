import { randomUUID } from "node:crypto";
import { getMindmapsPool } from "./db.js";
import { buildMindmapExport } from "./exporters.js";
import { createDefaultMindmapBody } from "./templates.js";
import type {
  MindmapArtifactExportInput,
  MindmapArtifactExportRecord,
  MindmapCreateInput,
  MindmapDocumentBody,
  MindmapDocumentRecord,
  MindmapExportContent,
  MindmapExportFormat,
  MindmapListResult,
  MindmapMode,
  MindmapNode,
  MindmapUpdateInput
} from "./types.js";

export class MindmapServiceError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type DocumentRow = {
  id: string;
  owner_core_user_id: string;
  title: string;
  description: string | null;
  mode: MindmapMode;
  project_id: string | null;
  project_name: string | null;
  body_json: MindmapDocumentBody;
  tags: string[] | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
};

type ArtifactExportRow = {
  id: string;
  document_id: string;
  owner_core_user_id: string;
  source_version: number;
  artifact_item_id: string;
  artifact_item_path: string | null;
  artifact_title: string | null;
  project_id: string | null;
  project_name: string | null;
  export_format: MindmapExportFormat;
  created_at: Date | string;
};

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function optionalText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 24);
}

function normalizeMode(value: MindmapMode | undefined): MindmapMode {
  return value === "logical_tree" ? "logical_tree" : "mindmap";
}

function mapDocument(row: DocumentRow): MindmapDocumentRecord {
  return {
    id: row.id,
    ownerCoreUserId: row.owner_core_user_id,
    title: row.title,
    description: row.description ?? undefined,
    mode: normalizeMode(row.mode),
    projectId: row.project_id ?? undefined,
    projectName: row.project_name ?? undefined,
    body: row.body_json,
    tags: row.tags ?? [],
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function mapArtifactExport(row: ArtifactExportRow): MindmapArtifactExportRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    ownerCoreUserId: row.owner_core_user_id,
    sourceVersion: row.source_version,
    artifactItemId: row.artifact_item_id,
    artifactItemPath: row.artifact_item_path ?? undefined,
    artifactTitle: row.artifact_title ?? undefined,
    projectId: row.project_id ?? undefined,
    projectName: row.project_name ?? undefined,
    exportFormat: row.export_format,
    createdAt: iso(row.created_at)
  };
}

function collectSearchText(node: MindmapNode, parts: string[]): void {
  parts.push(node.title);
  if (node.note) parts.push(node.note);
  for (const marker of node.markers ?? []) parts.push(marker);
  for (const child of node.children ?? []) collectSearchText(child, parts);
}

function searchTextForDocument(input: {
  title: string;
  description?: string;
  projectName?: string;
  tags: string[];
  body: MindmapDocumentBody;
}): string {
  const parts = [input.title, input.description ?? "", input.projectName ?? "", ...input.tags];
  collectSearchText(input.body.root, parts);
  return parts.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
}

async function readDocument(ownerCoreUserId: string, id: string): Promise<MindmapDocumentRecord | undefined> {
  const pool = getMindmapsPool();
  const result = await pool.query<DocumentRow>(
    `
      SELECT id, owner_core_user_id, title, description, mode, project_id, project_name,
             body_json, tags, version, created_at, updated_at
      FROM mindmap_documents
      WHERE owner_core_user_id = $1 AND id = $2 AND deleted_at IS NULL
      LIMIT 1
    `,
    [ownerCoreUserId, id]
  );
  const row = result.rows[0];
  return row ? mapDocument(row) : undefined;
}

export async function listMindmaps(
  ownerCoreUserId: string,
  options: {
    projectId?: string;
    q?: string;
    mode?: MindmapMode;
    limit?: number;
  } = {}
): Promise<MindmapListResult> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const params: unknown[] = [ownerCoreUserId];
  const filters = ["owner_core_user_id = $1", "deleted_at IS NULL"];

  if (options.projectId?.trim()) {
    params.push(options.projectId.trim());
    filters.push(`project_id = $${params.length}`);
  }
  if (options.mode) {
    params.push(options.mode);
    filters.push(`mode = $${params.length}`);
  }
  if (options.q?.trim()) {
    params.push(`%${options.q.trim().toLowerCase()}%`);
    filters.push(`search_text LIKE $${params.length}`);
  }
  params.push(limit);

  const pool = getMindmapsPool();
  const result = await pool.query<DocumentRow>(
    `
      SELECT id, owner_core_user_id, title, description, mode, project_id, project_name,
             body_json, tags, version, created_at, updated_at
      FROM mindmap_documents
      WHERE ${filters.join(" AND ")}
      ORDER BY updated_at DESC, id DESC
      LIMIT $${params.length}
    `,
    params
  );

  return {
    items: result.rows.map(mapDocument)
  };
}

export async function createMindmap(ownerCoreUserId: string, input: MindmapCreateInput): Promise<MindmapDocumentRecord> {
  const title = input.title.trim();
  if (!title) {
    throw new MindmapServiceError(400, "MINDMAP_TITLE_REQUIRED", "Mindmap title is required");
  }

  const mode = normalizeMode(input.mode ?? (input.template === "logical_tree" ? "logical_tree" : "mindmap"));
  const tags = normalizeTags(input.tags);
  const body = input.body ?? createDefaultMindmapBody(title, mode, input.template);
  const searchText = searchTextForDocument({
    title,
    description: optionalText(input.description),
    projectName: optionalText(input.projectName),
    tags,
    body
  });

  const pool = getMindmapsPool();
  const result = await pool.query<DocumentRow>(
    `
      INSERT INTO mindmap_documents (
        id, owner_core_user_id, title, description, mode, project_id, project_name,
        body_json, tags, search_text
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
      RETURNING id, owner_core_user_id, title, description, mode, project_id, project_name,
                body_json, tags, version, created_at, updated_at
    `,
    [
      randomUUID(),
      ownerCoreUserId,
      title,
      optionalText(input.description) ?? null,
      mode,
      optionalText(input.projectId) ?? null,
      optionalText(input.projectName) ?? null,
      JSON.stringify(body),
      tags,
      searchText
    ]
  );

  return mapDocument(result.rows[0]);
}

export async function getMindmap(ownerCoreUserId: string, id: string): Promise<MindmapDocumentRecord> {
  const document = await readDocument(ownerCoreUserId, id);
  if (!document) {
    throw new MindmapServiceError(404, "MINDMAP_NOT_FOUND", "Mindmap not found");
  }
  return document;
}

export async function updateMindmap(
  ownerCoreUserId: string,
  id: string,
  input: MindmapUpdateInput
): Promise<MindmapDocumentRecord> {
  const existing = await getMindmap(ownerCoreUserId, id);
  if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
    throw new MindmapServiceError(409, "VERSION_CONFLICT", "Mindmap was updated by another client");
  }

  const nextTitle = input.title !== undefined ? input.title.trim() : existing.title;
  if (!nextTitle) {
    throw new MindmapServiceError(400, "MINDMAP_TITLE_REQUIRED", "Mindmap title is required");
  }
  const nextDescription = input.description !== undefined ? optionalText(input.description) : existing.description;
  const nextMode = input.mode !== undefined ? normalizeMode(input.mode) : existing.mode;
  const nextProjectId = input.projectId === null ? undefined : input.projectId !== undefined ? optionalText(input.projectId) : existing.projectId;
  const nextProjectName =
    input.projectName === null ? undefined : input.projectName !== undefined ? optionalText(input.projectName) : existing.projectName;
  const nextBody = input.body ?? existing.body;
  const nextTags = input.tags !== undefined ? normalizeTags(input.tags) : existing.tags;
  const searchText = searchTextForDocument({
    title: nextTitle,
    description: nextDescription,
    projectName: nextProjectName,
    tags: nextTags,
    body: nextBody
  });

  const pool = getMindmapsPool();
  const params: unknown[] = [
    ownerCoreUserId,
    id,
    nextTitle,
    nextDescription ?? null,
    nextMode,
    nextProjectId ?? null,
    nextProjectName ?? null,
    JSON.stringify(nextBody),
    nextTags,
    searchText
  ];
  const versionFilter = input.expectedVersion !== undefined ? `AND version = $${params.push(input.expectedVersion)}` : "";

  const result = await pool.query<DocumentRow>(
    `
      UPDATE mindmap_documents
      SET title = $3,
          description = $4,
          mode = $5,
          project_id = $6,
          project_name = $7,
          body_json = $8::jsonb,
          tags = $9,
          search_text = $10,
          version = version + 1,
          updated_at = NOW()
      WHERE owner_core_user_id = $1 AND id = $2 AND deleted_at IS NULL ${versionFilter}
      RETURNING id, owner_core_user_id, title, description, mode, project_id, project_name,
                body_json, tags, version, created_at, updated_at
    `,
    params
  );

  const row = result.rows[0];
  if (!row) {
    throw new MindmapServiceError(409, "VERSION_CONFLICT", "Mindmap was updated by another client");
  }
  return mapDocument(row);
}

export async function deleteMindmap(ownerCoreUserId: string, id: string): Promise<void> {
  const pool = getMindmapsPool();
  const result = await pool.query(
    `
      UPDATE mindmap_documents
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE owner_core_user_id = $1 AND id = $2 AND deleted_at IS NULL
    `,
    [ownerCoreUserId, id]
  );
  if (result.rowCount === 0) {
    throw new MindmapServiceError(404, "MINDMAP_NOT_FOUND", "Mindmap not found");
  }
}

export async function exportMindmap(
  ownerCoreUserId: string,
  id: string,
  format: MindmapExportFormat
): Promise<MindmapExportContent> {
  const document = await getMindmap(ownerCoreUserId, id);
  return buildMindmapExport(document, format);
}

export async function recordMindmapArtifactExport(
  ownerCoreUserId: string,
  documentId: string,
  input: MindmapArtifactExportInput
): Promise<MindmapArtifactExportRecord> {
  await getMindmap(ownerCoreUserId, documentId);
  const pool = getMindmapsPool();
  const result = await pool.query<ArtifactExportRow>(
    `
      INSERT INTO mindmap_artifact_exports (
        id, document_id, owner_core_user_id, source_version, artifact_item_id,
        artifact_item_path, artifact_title, project_id, project_name, export_format
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, document_id, owner_core_user_id, source_version, artifact_item_id,
                artifact_item_path, artifact_title, project_id, project_name, export_format, created_at
    `,
    [
      randomUUID(),
      documentId,
      ownerCoreUserId,
      input.sourceVersion,
      input.artifactItemId,
      optionalText(input.artifactItemPath) ?? null,
      optionalText(input.artifactTitle) ?? null,
      optionalText(input.projectId) ?? null,
      optionalText(input.projectName) ?? null,
      input.exportFormat
    ]
  );
  return mapArtifactExport(result.rows[0]);
}
