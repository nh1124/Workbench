import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname } from "node:path";
import type { DaemonConfig } from "./config.js";
import {
  getResource,
  hasOpenOutboxForPath,
  listOpenOutboxForResource,
  listOpenOutboxForPath,
  listResources,
  removeResource,
  setMeta,
  upsertResource as upsertManifestResource,
  writeManifestDebugSnapshot,
  type ManifestResource,
  type OutboxItem
} from "./manifestStore.js";
import {
  decodeContentBase64,
  decodeLocalItemId,
  enqueueManifestOutbox,
  itemUpdatedAt,
  localItemId,
  localProjectId,
  localProjectName,
  refreshManifestStats,
  supersedeOpenOutboxForPath,
  uniqueRelativePath
} from "./localStore.js";
import {
  artifactKindForPath,
  defaultNotePath,
  directoryPathFor,
  hashFile,
  isIgnoredSyncRelativePath,
  mimeTypeForPath,
  normalizeArtifactFolderPath,
  normalizeArtifactRelativePath,
  relativeSyncPath,
  resolveSyncRootRelativePath,
  sanitizePathSegment,
  titleFor,
  waitForStableFile,
  walkSyncDirectories,
  walkSyncFiles
} from "./paths.js";
import type { DaemonState, LocalArtifactItem } from "./types.js";

export function artifactKindForOutboxItem(item: OutboxItem): "folder" | "note" | "file" {
  return item.payload.kind === "folder" ? "folder" : artifactKindForPath(item.relativePath);
}

export function buildLocalFolderItem(state: DaemonState, folderPath: string, updatedAt: string): LocalArtifactItem {
  return {
    id: localItemId("folder", folderPath),
    projectId: localProjectId(state),
    projectName: localProjectName(state),
    kind: "folder",
    title: basename(folderPath),
    path: folderPath,
    parentPath: directoryPathFor(folderPath) ?? "",
    scope: "private",
    tags: [],
    version: 1,
    createdAt: updatedAt,
    updatedAt
  };
}

export async function buildLocalArtifactItem(
  state: DaemonState,
  resource: ManifestResource,
  options: { includeContent?: boolean } = {}
): Promise<LocalArtifactItem> {
  const updatedAt = itemUpdatedAt(resource);
  const item: LocalArtifactItem = {
    id: resource.resourceId ?? localItemId(resource.kind, resource.relativePath),
    projectId: localProjectId(state),
    projectName: localProjectName(state),
    kind: resource.kind,
    title: titleFor(resource.relativePath),
    path: resource.relativePath,
    parentPath: directoryPathFor(resource.relativePath) ?? "",
    scope: "private",
    tags: [],
    mimeType: resource.kind === "folder" ? undefined : resource.kind === "note" ? "text/markdown" : mimeTypeForPath(resource.relativePath),
    sizeBytes: resource.sizeBytes,
    version: 1,
    createdAt: updatedAt,
    updatedAt
  };

  if (resource.kind === "note" && options.includeContent) {
    const absolutePath = resolveSyncRootRelativePath(state.config, resource.relativePath);
    if (absolutePath) {
      try {
        item.contentMarkdown = await fs.readFile(absolutePath, "utf8");
      } catch {
        item.contentMarkdown = "";
      }
    }
  }

  return item;
}

export async function listLocalArtifactItems(
  state: DaemonState,
  options: { includeContent?: boolean; projectId?: string } = {}
): Promise<LocalArtifactItem[]> {
  if (options.projectId && options.projectId !== localProjectId(state)) {
    return [];
  }

  const resources = listResources(state.manifestStore)
    .filter((resource) => resource.domain === "artifacts" && !isIgnoredSyncRelativePath(resource.relativePath));
  const trackedFolderPaths = new Set(
    resources.filter((resource) => resource.kind === "folder").map((resource) => resource.relativePath)
  );
  const folderUpdatedAt = new Map<string, string>();

  for (const resource of resources) {
    const updatedAt = itemUpdatedAt(resource);
    let folderPath = directoryPathFor(resource.relativePath);
    while (folderPath) {
      const current = folderUpdatedAt.get(folderPath);
      if (!current || current < updatedAt) {
        folderUpdatedAt.set(folderPath, updatedAt);
      }
      folderPath = directoryPathFor(folderPath);
    }
  }

  for (const folderPath of await walkSyncDirectories(state.config)) {
    if (trackedFolderPaths.has(folderPath)) continue;
    const absolutePath = resolveSyncRootRelativePath(state.config, folderPath);
    if (!absolutePath) continue;
    let updatedAt = new Date().toISOString();
    try {
      updatedAt = (await fs.stat(absolutePath)).mtime.toISOString();
    } catch {
      // Best-effort metadata for folders discovered from the sync root.
    }
    const current = folderUpdatedAt.get(folderPath);
    if (!current || current < updatedAt) {
      folderUpdatedAt.set(folderPath, updatedAt);
    }
  }

  const folders = [...folderUpdatedAt.entries()].map(([folderPath, updatedAt]) => buildLocalFolderItem(state, folderPath, updatedAt));
  const items = await Promise.all(resources.map((resource) => buildLocalArtifactItem(state, resource, options)));
  return [...folders, ...items].sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
}

export async function getLocalArtifactItemById(
  state: DaemonState,
  id: string,
  options: { includeContent?: boolean } = {}
): Promise<LocalArtifactItem | undefined> {
  const local = decodeLocalItemId(id);
  if (local?.kind === "folder") {
    const items = await listLocalArtifactItems(state);
    return items.find((item) => item.id === id && item.kind === "folder");
  }

  const resources = listResources(state.manifestStore);
  const resource = resources.find((item) => item.resourceId === id)
    ?? (local ? resources.find((item) => item.kind === local.kind && item.relativePath === local.relativePath) : undefined);
  return resource ? buildLocalArtifactItem(state, resource, options) : undefined;
}


export async function buildOutboxPayloadForFile(
  config: DaemonConfig,
  absolutePath: string,
  relativePath: string,
  kind: "note" | "file"
): Promise<Record<string, unknown>> {
  if (kind === "note") {
    return {
      kind: "note",
      path: relativePath,
      title: titleFor(relativePath),
      contentMarkdown: await fs.readFile(absolutePath, "utf8")
    };
  }

  const buffer = await fs.readFile(absolutePath);
  return {
    kind: "file",
    filename: basename(relativePath),
    directoryPath: directoryPathFor(relativePath),
    mimeType: mimeTypeForPath(relativePath),
    contentBase64: buffer.toString("base64"),
    maxSyncFileBytes: config.maxSyncFileBytes
  };
}

export function buildOutboxPayloadForFolder(relativePath: string): Record<string, unknown> {
  return {
    kind: "folder",
    path: relativePath,
    title: titleFor(relativePath)
  };
}

type PendingLocalCreateCandidate = {
  absolutePath: string;
  relativePath: string;
  kind: "note" | "file";
  checksum: string;
  sizeBytes: number;
  localUpdatedAt: string;
};

function renameCandidateKey(kind: "note" | "file", checksum: string, sizeBytes: number): string {
  return `${kind}\0${sizeBytes}\0${checksum}`;
}

function addRenameCandidateGroup<T>(
  groups: Map<string, T[]>,
  key: string,
  value: T
): void {
  const existing = groups.get(key);
  if (existing) {
    existing.push(value);
  } else {
    groups.set(key, [value]);
  }
}

async function buildOutboxPayloadForRename(
  config: DaemonConfig,
  candidate: PendingLocalCreateCandidate
): Promise<Record<string, unknown>> {
  if (candidate.kind === "note") {
    return buildOutboxPayloadForFile(config, candidate.absolutePath, candidate.relativePath, candidate.kind);
  }

  return {
    kind: "file",
    path: candidate.relativePath,
    title: basename(candidate.relativePath)
  };
}

async function queueCleanLocalRenameUpdates(
  state: DaemonState,
  currentPaths: Set<string>,
  pendingCreateCandidates: PendingLocalCreateCandidate[],
  now: string
): Promise<Set<string>> {
  const candidateGroups = new Map<string, PendingLocalCreateCandidate[]>();
  for (const candidate of pendingCreateCandidates) {
    if (!resolveSyncRootRelativePath(state.config, candidate.relativePath)) continue;
    if (hasOpenOutboxForPath(state.manifestStore, candidate.relativePath)) continue;
    addRenameCandidateGroup(
      candidateGroups,
      renameCandidateKey(candidate.kind, candidate.checksum, candidate.sizeBytes),
      candidate
    );
  }

  const resourceGroups = new Map<string, ManifestResource[]>();
  for (const resource of listResources(state.manifestStore)) {
    if (resource.kind === "folder") continue;
    if (!resource.resourceId || resource.dirty) continue;
    if (!resource.checksum || typeof resource.sizeBytes !== "number") continue;
    if (isIgnoredSyncRelativePath(resource.relativePath)) continue;
    if (!resolveSyncRootRelativePath(state.config, resource.relativePath)) continue;
    if (currentPaths.has(resource.relativePath)) continue;
    if (hasOpenOutboxForPath(state.manifestStore, resource.relativePath)) continue;
    if (listOpenOutboxForResource(state.manifestStore, resource.resourceId).length > 0) continue;
    addRenameCandidateGroup(
      resourceGroups,
      renameCandidateKey(resource.kind, resource.checksum, resource.sizeBytes),
      resource
    );
  }

  const renamedCandidatePaths = new Set<string>();
  for (const [key, resources] of resourceGroups) {
    const candidates = candidateGroups.get(key);
    if (resources.length !== 1 || candidates?.length !== 1) continue;

    const resource = resources[0];
    const candidate = candidates[0];
    const payload = await buildOutboxPayloadForRename(state.config, candidate);
    enqueueManifestOutbox(state.manifestStore, {
      relativePath: candidate.relativePath,
      domain: "artifacts",
      action: "update",
      resourceId: resource.resourceId,
      payload
    });
    removeResource(state.manifestStore, resource.relativePath);
    upsertManifestResource(state.manifestStore, {
      ...resource,
      relativePath: candidate.relativePath,
      kind: candidate.kind,
      checksum: candidate.checksum,
      sizeBytes: candidate.sizeBytes,
      dirty: true,
      lastSeenAt: now,
      localUpdatedAt: candidate.localUpdatedAt
    });
    renamedCandidatePaths.add(candidate.relativePath);
  }

  return renamedCandidatePaths;
}

function hasOpenOutboxAction(
  state: DaemonState,
  relativePath: string,
  predicate: (item: OutboxItem) => boolean
): boolean {
  return listOpenOutboxForPath(state.manifestStore, relativePath).some(predicate);
}

function ancestorFolderPaths(relativePath: string): string[] {
  const ancestors: string[] = [];
  let current = directoryPathFor(relativePath);
  while (current) {
    ancestors.push(current);
    current = directoryPathFor(current);
  }
  return ancestors;
}

function hasOpenFolderDeleteAncestor(state: DaemonState, relativePath: string): boolean {
  return ancestorFolderPaths(relativePath).some((folderPath) => hasOpenOutboxAction(
    state,
    folderPath,
    (item) => item.action === "delete" && item.payload.kind === "folder"
  ));
}

export async function scanSyncFolder(state: DaemonState): Promise<void> {
  const currentPaths = new Set<string>();
  const pendingCreateCandidates: PendingLocalCreateCandidate[] = [];
  const folders = await walkSyncDirectories(state.config);
  const files = await walkSyncFiles(state.config);
  const now = new Date().toISOString();

  for (const relativePath of folders) {
    if (!relativePath || isIgnoredSyncRelativePath(relativePath)) continue;
    currentPaths.add(relativePath);
    const absolutePath = resolveSyncRootRelativePath(state.config, relativePath);
    if (!absolutePath) continue;
    let stat;
    try {
      stat = await fs.stat(absolutePath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const existing = getResource(state.manifestStore, relativePath);
    const openOutboxItems = listOpenOutboxForPath(state.manifestStore, relativePath);
    if (openOutboxItems.some((item) => item.action === "delete")) {
      supersedeOpenOutboxForPath(
        state,
        relativePath,
        (item) => item.action === "delete",
        "Local folder exists again; pending delete was superseded by recovery scan.",
        now
      );
    }

    if (existing?.kind === "folder" && !existing.dirty) {
      upsertManifestResource(state.manifestStore, {
        ...existing,
        lastSeenAt: now,
        localUpdatedAt: stat.mtime.toISOString()
      });
      continue;
    }
    if (hasOpenOutboxForPath(state.manifestStore, relativePath)) continue;

    enqueueManifestOutbox(state.manifestStore, {
      relativePath,
      domain: "artifacts",
      action: existing?.resourceId ? "update" : "create",
      resourceId: existing?.resourceId,
      payload: buildOutboxPayloadForFolder(relativePath)
    });
    upsertManifestResource(state.manifestStore, {
      relativePath,
      domain: "artifacts",
      kind: "folder",
      resourceId: existing?.resourceId,
      dirty: true,
      lastSeenAt: now,
      localUpdatedAt: stat.mtime.toISOString()
    });
  }

  for (const absolutePath of files) {
    const relativePath = relativeSyncPath(state.config, absolutePath);
    if (!relativePath) continue;
    if (isIgnoredSyncRelativePath(relativePath)) continue;
    currentPaths.add(relativePath);
    const stat = await waitForStableFile(absolutePath);
    if (!stat) continue;
    const kind = artifactKindForPath(relativePath);
    const existing = getResource(state.manifestStore, relativePath);
    if (stat.size > state.config.maxSyncFileBytes) {
      upsertManifestResource(state.manifestStore, {
        ...(existing ?? { relativePath, domain: "artifacts", kind }),
        checksum: existing?.checksum,
        sizeBytes: stat.size,
        dirty: false,
        lastSeenAt: now,
        localUpdatedAt: stat.mtime.toISOString()
      });
      continue;
    }

    const checksum = await hashFile(absolutePath);
    const openOutboxItems = listOpenOutboxForPath(state.manifestStore, relativePath);
    const hasOpenDelete = openOutboxItems.some((item) => item.action === "delete");
    const hasStaleWrite = openOutboxItems.some(
      (item) => (item.action === "create" || item.action === "update") && existing?.checksum !== checksum
    );
    if (hasOpenDelete) {
      supersedeOpenOutboxForPath(
        state,
        relativePath,
        (item) => item.action === "delete",
        "Local file exists again; pending delete was superseded by recovery scan.",
        now
      );
    }
    if (hasStaleWrite) {
      supersedeOpenOutboxForPath(
        state,
        relativePath,
        (item) => item.action === "create" || item.action === "update",
        "Local file changed before sync completed; stale write was superseded by recovery scan.",
        now
      );
    }

    if (existing?.checksum === checksum && !existing.dirty) {
      upsertManifestResource(state.manifestStore, {
        ...existing,
        lastSeenAt: now,
        localUpdatedAt: stat.mtime.toISOString()
      });
      continue;
    }
    if (hasOpenOutboxForPath(state.manifestStore, relativePath)) continue;

    if (!existing) {
      pendingCreateCandidates.push({
        absolutePath,
        relativePath,
        kind,
        checksum,
        sizeBytes: stat.size,
        localUpdatedAt: stat.mtime.toISOString()
      });
      continue;
    }

    const payload = await buildOutboxPayloadForFile(state.config, absolutePath, relativePath, kind);
    const action = existing?.resourceId ? "update" : "create";
    enqueueManifestOutbox(state.manifestStore, {
      relativePath,
      domain: "artifacts",
      action,
      resourceId: action === "update" ? existing?.resourceId : undefined,
      payload
    });
    upsertManifestResource(state.manifestStore, {
      ...(existing ?? { relativePath, domain: "artifacts", kind }),
      kind,
      checksum,
      sizeBytes: stat.size,
      dirty: true,
      lastSeenAt: now,
      localUpdatedAt: stat.mtime.toISOString()
    });
  }

  const renamedCandidatePaths = await queueCleanLocalRenameUpdates(state, currentPaths, pendingCreateCandidates, now);
  for (const candidate of pendingCreateCandidates) {
    if (renamedCandidatePaths.has(candidate.relativePath)) continue;
    if (hasOpenOutboxForPath(state.manifestStore, candidate.relativePath)) continue;

    const payload = await buildOutboxPayloadForFile(
      state.config,
      candidate.absolutePath,
      candidate.relativePath,
      candidate.kind
    );
    enqueueManifestOutbox(state.manifestStore, {
      relativePath: candidate.relativePath,
      domain: "artifacts",
      action: "create",
      payload
    });
    upsertManifestResource(state.manifestStore, {
      relativePath: candidate.relativePath,
      domain: "artifacts",
      kind: candidate.kind,
      checksum: candidate.checksum,
      sizeBytes: candidate.sizeBytes,
      dirty: true,
      lastSeenAt: now,
      localUpdatedAt: candidate.localUpdatedAt
    });
  }

  for (const resource of listResources(state.manifestStore)) {
    if (isIgnoredSyncRelativePath(resource.relativePath)) {
      removeResource(state.manifestStore, resource.relativePath);
      continue;
    }
    if (currentPaths.has(resource.relativePath)) continue;
    if (resource.kind !== "folder" && hasOpenFolderDeleteAncestor(state, resource.relativePath)) continue;

    const supersededWrites = supersedeOpenOutboxForPath(
      state,
      resource.relativePath,
      (item) => item.action === "create" || item.action === "update",
      "Local file was removed before sync completed; stale write was superseded by recovery scan.",
      now
    );
    if (supersededWrites.length > 0 && !resource.resourceId) {
      removeResource(state.manifestStore, resource.relativePath);
      continue;
    }
    if (hasOpenOutboxAction(state, resource.relativePath, (item) => item.action === "delete")) continue;
    if (hasOpenOutboxForPath(state.manifestStore, resource.relativePath)) continue;

    if (!resource.resourceId) {
      removeResource(state.manifestStore, resource.relativePath);
      continue;
    }
    enqueueManifestOutbox(state.manifestStore, {
      relativePath: resource.relativePath,
      domain: "artifacts",
      action: "delete",
      resourceId: resource.resourceId,
      payload: resource.kind === "folder" ? buildOutboxPayloadForFolder(resource.relativePath) : {}
    });
    upsertManifestResource(state.manifestStore, {
      ...resource,
      dirty: true,
      lastSeenAt: now
    });
  }

  setMeta(state.manifestStore, "lastScanAt", now);
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
}



function getLocalArtifactResourceById(state: DaemonState, id: string): ManifestResource | undefined {
  const local = decodeLocalItemId(id);
  const resources = listResources(state.manifestStore);
  return resources.find((item) => item.resourceId === id)
    ?? (local ? resources.find((item) => item.kind === local.kind && item.relativePath === local.relativePath) : undefined);
}

async function readLocalNoteContent(state: DaemonState, relativePath: string): Promise<string> {
  const absolutePath = resolveSyncRootRelativePath(state.config, relativePath);
  if (!absolutePath) return "";
  try {
    return await fs.readFile(absolutePath, "utf8");
  } catch {
    return "";
  }
}

function assertExpectedLocalVersion(value: unknown): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error("expectedVersion must be a positive integer");
  }
  if (value !== 1) {
    throw new Error(`Version conflict: expected ${value}, current 1`);
  }
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function readRequiredInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isInteger(value)) {
    throw new Error(`${key} must be an integer`);
  }
  return Number(value);
}

function applyLocalNotePatchOperation(content: string, operation: unknown): string {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    throw new Error("Patch operation must be an object");
  }
  const record = operation as Record<string, unknown>;
  const type = record.type;
  if (type === "insert") {
    const index = readRequiredInteger(record, "index");
    if (index < 0 || index > content.length) {
      throw new Error("Insert index is out of range");
    }
    return `${content.slice(0, index)}${readRequiredString(record, "text")}${content.slice(index)}`;
  }

  if (type !== "delete" && type !== "replace") {
    throw new Error("Patch operation type must be insert, delete, or replace");
  }

  const start = readRequiredInteger(record, "start");
  const end = readRequiredInteger(record, "end");
  if (start < 0 || end < start || end > content.length) {
    throw new Error("Patch range is out of range");
  }

  if (type === "delete") {
    return `${content.slice(0, start)}${content.slice(end)}`;
  }
  return `${content.slice(0, start)}${readRequiredString(record, "text")}${content.slice(end)}`;
}

function applyLocalNotePatchOperations(content: string, operations: unknown): string {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error("At least one patch operation is required");
  }
  if (operations.length > 100) {
    throw new Error("Too many patch operations");
  }
  return operations.reduce((nextContent, operation) => applyLocalNotePatchOperation(nextContent, operation), content);
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function findMarkdownSection(
  content: string,
  heading: string,
  level?: number
): { bodyStart: number; sectionEnd: number; level: number } | undefined {
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

    const lineEnd = content.indexOf("\n", match.index);
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

    return { bodyStart, sectionEnd, level: headingLevel };
  }

  return undefined;
}

function applyLocalNoteSectionUpdate(content: string, input: Record<string, unknown>): string {
  const heading = readRequiredString(input, "heading");
  const rawLevel = input.level;
  const level = rawLevel === undefined ? undefined : readRequiredInteger(input, "level");
  if (level !== undefined && (level < 1 || level > 6)) {
    throw new Error("level must be between 1 and 6");
  }
  const rawMode = input.mode;
  const mode = rawMode === undefined ? "replaceBody" : rawMode;
  if (mode !== "replaceBody" && mode !== "appendBody" && mode !== "prependBody") {
    throw new Error("mode must be replaceBody, appendBody, or prependBody");
  }
  const nextBody = ensureTrailingNewline(readRequiredString(input, "contentMarkdown"));
  const section = findMarkdownSection(content, heading, level);

  if (!section) {
    if (input.createIfMissing !== true) {
      throw new Error("Heading not found");
    }
    const nextLevel = level ?? 2;
    const separator = content.trim().length === 0 ? "" : "\n\n";
    return `${content}${separator}${"#".repeat(nextLevel)} ${heading.trim()}\n${nextBody}`;
  }

  const currentBody = content.slice(section.bodyStart, section.sectionEnd);
  let replacementBody = nextBody;
  if (mode === "appendBody") {
    const separator = currentBody.endsWith("\n") || currentBody.length === 0 ? "" : "\n";
    replacementBody = `${currentBody}${separator}${nextBody}`;
  } else if (mode === "prependBody") {
    const separator = nextBody.endsWith("\n") || currentBody.length === 0 ? "" : "\n";
    replacementBody = `${nextBody}${separator}${currentBody}`;
  }

  return `${content.slice(0, section.bodyStart)}${replacementBody}${content.slice(section.sectionEnd)}`;
}

export async function createLocalArtifactFolder(
  state: DaemonState,
  input: Record<string, unknown>
): Promise<LocalArtifactItem> {
  const rawPath = typeof input.path === "string" && input.path.trim()
    ? input.path.trim()
    : typeof input.title === "string" && input.title.trim()
      ? input.title.trim()
      : "";
  const requestedPath = normalizeArtifactFolderPath(rawPath);
  if (!requestedPath || !resolveSyncRootRelativePath(state.config, requestedPath)) {
    throw new Error("Invalid artifact folder path");
  }

  const relativePath = await uniqueRelativePath(state.config, requestedPath, undefined, "folder");
  const absolutePath = resolveSyncRootRelativePath(state.config, relativePath);
  if (!absolutePath) {
    throw new Error("Invalid artifact folder path");
  }

  await fs.mkdir(absolutePath, { recursive: true });
  const stat = await fs.stat(absolutePath);
  const now = new Date().toISOString();
  const updatedAt = stat.mtime.toISOString();
  supersedeOpenOutboxForPath(
    state,
    relativePath,
    () => true,
    "Local folder was created through daemon facade; stale folder operation was superseded.",
    now
  );
  enqueueManifestOutbox(state.manifestStore, {
    relativePath,
    domain: "artifacts",
    action: "create",
    payload: buildOutboxPayloadForFolder(relativePath)
  });
  upsertManifestResource(state.manifestStore, {
    relativePath,
    domain: "artifacts",
    kind: "folder",
    dirty: true,
    lastSeenAt: now,
    localUpdatedAt: updatedAt
  });
  setMeta(state.manifestStore, "lastScanAt", now);
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  const resource = getResource(state.manifestStore, relativePath);
  return resource ? buildLocalArtifactItem(state, resource) : buildLocalFolderItem(state, relativePath, updatedAt);
}

export async function createLocalArtifactFile(
  state: DaemonState,
  input: Record<string, unknown>
): Promise<LocalArtifactItem> {
  const rawFilename = typeof input.originalFilename === "string" && input.originalFilename.trim()
    ? input.originalFilename.trim()
    : typeof input.filename === "string" && input.filename.trim()
      ? input.filename.trim()
      : "file";
  const filename = sanitizePathSegment(rawFilename, "file");
  let directoryPath: string | undefined;
  if (typeof input.directoryPath === "string" && input.directoryPath.trim()) {
    directoryPath = normalizeArtifactFolderPath(input.directoryPath);
    if (!directoryPath) {
      throw new Error("Invalid artifact file path");
    }
  }
  const requestedPath = directoryPath ? `${directoryPath}/${filename}` : filename;
  const relativePath = await uniqueRelativePath(state.config, requestedPath, undefined, filename);
  const absolutePath = resolveSyncRootRelativePath(state.config, relativePath);
  if (!absolutePath) {
    throw new Error("Invalid artifact file path");
  }
  if (typeof input.contentBase64 !== "string") {
    throw new Error("contentBase64 is required");
  }

  const buffer = decodeContentBase64(input.contentBase64);
  if (buffer.byteLength > state.config.maxSyncFileBytes) {
    throw new Error(`File exceeds max sync size of ${state.config.maxSyncFileBytes} bytes`);
  }

  const now = new Date().toISOString();
  supersedeOpenOutboxForPath(
    state,
    relativePath,
    () => true,
    "Local file was changed through daemon upload facade; stale operation was superseded.",
    now
  );

  await fs.mkdir(dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, buffer);
  const stat = await fs.stat(absolutePath);
  const checksum = createHash("sha256").update(buffer).digest("hex");
  const mimeType = typeof input.mimeType === "string" && input.mimeType.trim()
    ? input.mimeType.trim()
    : mimeTypeForPath(relativePath);

  enqueueManifestOutbox(state.manifestStore, {
    relativePath,
    domain: "artifacts",
    action: "create",
    payload: {
      kind: "file",
      filename: basename(relativePath),
      directoryPath: directoryPathFor(relativePath),
      mimeType,
      contentBase64: buffer.toString("base64"),
      maxSyncFileBytes: state.config.maxSyncFileBytes
    }
  });
  upsertManifestResource(state.manifestStore, {
    relativePath,
    domain: "artifacts",
    kind: "file",
    checksum,
    sizeBytes: stat.size,
    dirty: true,
    lastSeenAt: now,
    localUpdatedAt: stat.mtime.toISOString()
  });
  setMeta(state.manifestStore, "lastScanAt", now);
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);

  const resource = getResource(state.manifestStore, relativePath);
  return resource
    ? buildLocalArtifactItem(state, resource)
    : {
        id: localItemId("file", relativePath),
        projectId: localProjectId(state),
        projectName: localProjectName(state),
        kind: "file",
        title: titleFor(relativePath),
        path: relativePath,
        parentPath: directoryPathFor(relativePath) ?? "",
        scope: "private",
        tags: [],
        mimeType,
        sizeBytes: stat.size,
        version: 1,
        createdAt: now,
        updatedAt: now
      };
}

async function writeLocalNoteAndQueue(
  state: DaemonState,
  options: {
    relativePath: string;
    contentMarkdown: string;
    resourceId?: string;
    action: "create" | "update";
    previousRelativePath?: string;
  }
): Promise<LocalArtifactItem> {
  const now = new Date().toISOString();
  const relativePath = normalizeArtifactRelativePath(options.relativePath);
  const absolutePath = resolveSyncRootRelativePath(state.config, relativePath);
  if (!absolutePath) {
    throw new Error("Invalid artifact note path");
  }

  if (options.previousRelativePath && options.previousRelativePath !== relativePath) {
    supersedeOpenOutboxForPath(
      state,
      options.previousRelativePath,
      () => true,
      "Local note path changed through daemon facade; stale operation was superseded.",
      now
    );
    const previousAbsolutePath = resolveSyncRootRelativePath(state.config, options.previousRelativePath);
    if (previousAbsolutePath) {
      await fs.rm(previousAbsolutePath, { force: true }).catch(() => {
        // Best-effort cleanup after local rename.
      });
    }
    removeResource(state.manifestStore, options.previousRelativePath);
  }

  supersedeOpenOutboxForPath(
    state,
    relativePath,
    () => true,
    "Local note was changed through daemon facade; stale operation was superseded.",
    now
  );

  await fs.mkdir(dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, options.contentMarkdown, "utf8");
  const stat = await fs.stat(absolutePath);
  const checksum = await hashFile(absolutePath);
  const payload = await buildOutboxPayloadForFile(state.config, absolutePath, relativePath, "note");

  enqueueManifestOutbox(state.manifestStore, {
    relativePath,
    domain: "artifacts",
    action: options.action,
    resourceId: options.action === "update" ? options.resourceId : undefined,
    payload
  });
  upsertManifestResource(state.manifestStore, {
    relativePath,
    domain: "artifacts",
    kind: "note",
    resourceId: options.resourceId,
    checksum,
    sizeBytes: stat.size,
    dirty: true,
    lastSeenAt: now,
    localUpdatedAt: stat.mtime.toISOString()
  });
  setMeta(state.manifestStore, "lastScanAt", now);
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);

  const resource = getResource(state.manifestStore, relativePath);
  return resource
    ? buildLocalArtifactItem(state, resource, { includeContent: true })
    : {
        id: localItemId("note", relativePath),
        projectId: localProjectId(state),
        projectName: localProjectName(state),
        kind: "note",
        title: titleFor(relativePath),
        path: relativePath,
        parentPath: directoryPathFor(relativePath) ?? "",
        scope: "private",
        tags: [],
        mimeType: "text/markdown",
        sizeBytes: stat.size,
        version: 1,
        contentMarkdown: options.contentMarkdown,
        createdAt: now,
        updatedAt: now
      };
}

export async function createLocalArtifactNote(
  state: DaemonState,
  input: Record<string, unknown>
): Promise<LocalArtifactItem> {
  const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : "Untitled";
  const requestedPath = typeof input.path === "string" && input.path.trim() ? input.path.trim() : defaultNotePath(title);
  const relativePath = await uniqueRelativePath(state.config, requestedPath);
  if (!relativePath) {
    throw new Error("Invalid artifact note path");
  }
  const contentMarkdown = typeof input.contentMarkdown === "string" ? input.contentMarkdown : "";
  return writeLocalNoteAndQueue(state, {
    relativePath,
    contentMarkdown,
    action: "create"
  });
}

export async function updateLocalArtifactItem(
  state: DaemonState,
  id: string,
  input: Record<string, unknown>
): Promise<LocalArtifactItem | undefined> {
  const resource = getLocalArtifactResourceById(state, id);
  if (!resource) return undefined;
  if (resource.kind !== "note") {
    throw new Error("Only local note items can be updated through the daemon facade in this phase");
  }

  const item = await buildLocalArtifactItem(state, resource, { includeContent: true });
  let nextRelativePath = resource.relativePath;
  if (typeof input.path === "string" && input.path.trim()) {
    nextRelativePath = await uniqueRelativePath(state.config, input.path.trim(), resource.relativePath);
    if (!nextRelativePath) {
      throw new Error("Invalid artifact note path");
    }
  } else if (typeof input.title === "string" && input.title.trim() && input.title.trim() !== item.title) {
    const parent = directoryPathFor(resource.relativePath);
    const requested = parent ? `${parent}/${defaultNotePath(input.title.trim())}` : defaultNotePath(input.title.trim());
    nextRelativePath = await uniqueRelativePath(state.config, requested, resource.relativePath);
    if (!nextRelativePath) {
      throw new Error("Invalid artifact note path");
    }
  }

  const contentMarkdown = typeof input.contentMarkdown === "string"
    ? input.contentMarkdown
    : item.contentMarkdown ?? await readLocalNoteContent(state, resource.relativePath);
  return writeLocalNoteAndQueue(state, {
    relativePath: nextRelativePath,
    previousRelativePath: resource.relativePath,
    contentMarkdown,
    resourceId: resource.resourceId,
    action: resource.resourceId ? "update" : "create"
  });
}

export async function patchLocalArtifactNoteContent(
  state: DaemonState,
  id: string,
  input: Record<string, unknown>
): Promise<LocalArtifactItem | undefined> {
  const resource = getLocalArtifactResourceById(state, id);
  if (!resource) return undefined;
  if (resource.kind !== "note") {
    throw new Error("Only local note items support markdown content patches");
  }

  assertExpectedLocalVersion(input.expectedVersion);
  const currentContent = await readLocalNoteContent(state, resource.relativePath);
  const contentMarkdown = applyLocalNotePatchOperations(currentContent, input.operations);
  return writeLocalNoteAndQueue(state, {
    relativePath: resource.relativePath,
    contentMarkdown,
    resourceId: resource.resourceId,
    action: resource.resourceId ? "update" : "create"
  });
}

export async function updateLocalArtifactNoteSection(
  state: DaemonState,
  id: string,
  input: Record<string, unknown>
): Promise<LocalArtifactItem | undefined> {
  const resource = getLocalArtifactResourceById(state, id);
  if (!resource) return undefined;
  if (resource.kind !== "note") {
    throw new Error("Only local note items support markdown section updates");
  }

  assertExpectedLocalVersion(input.expectedVersion);
  const currentContent = await readLocalNoteContent(state, resource.relativePath);
  const contentMarkdown = applyLocalNoteSectionUpdate(currentContent, input);
  return writeLocalNoteAndQueue(state, {
    relativePath: resource.relativePath,
    contentMarkdown,
    resourceId: resource.resourceId,
    action: resource.resourceId ? "update" : "create"
  });
}

export async function deleteLocalArtifactItem(state: DaemonState, id: string): Promise<boolean> {
  const resource = getLocalArtifactResourceById(state, id);
  if (!resource) return false;
  const now = new Date().toISOString();
  supersedeOpenOutboxForPath(
    state,
    resource.relativePath,
    () => true,
    "Local artifact was deleted through daemon facade; stale operation was superseded.",
    now
  );

  const absolutePath = resolveSyncRootRelativePath(state.config, resource.relativePath);
  if (absolutePath) {
    await fs.rm(absolutePath, { recursive: resource.kind === "folder", force: true }).catch(() => {
      // Best-effort local file deletion.
    });
  }

  if (resource.resourceId) {
    enqueueManifestOutbox(state.manifestStore, {
      relativePath: resource.relativePath,
      domain: "artifacts",
      action: "delete",
      resourceId: resource.resourceId,
      payload: resource.kind === "folder" ? buildOutboxPayloadForFolder(resource.relativePath) : {}
    });
    upsertManifestResource(state.manifestStore, {
      ...resource,
      dirty: true,
      lastSeenAt: now
    });
  } else {
    removeResource(state.manifestStore, resource.relativePath);
  }

  setMeta(state.manifestStore, "lastScanAt", now);
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return true;
}
