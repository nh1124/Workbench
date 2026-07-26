import { promises as fs } from "node:fs";
import { basename } from "node:path";
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
  decodeLocalItemId,
  enqueueManifestOutbox,
  itemUpdatedAt,
  localItemId,
  localProjectId,
  localProjectName,
  refreshManifestStats,
  supersedeOpenOutboxForPath
} from "./localStore.js";
import {
  artifactKindForPath,
  directoryPathFor,
  hashFile,
  isIgnoredSyncRelativePath,
  mimeTypeForPath,
  relativeSyncPath,
  resolveSyncRootRelativePath,
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

