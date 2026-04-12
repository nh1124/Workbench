import type { ArtifactItem, ProjectRecord } from "../../types/models";
import type { ArtifactEditorDraft, ProjectOption, TreeFolderNode } from "../types";
import { normalizePath, parentPath } from "./path";

export function itemToDraft(item: ArtifactItem): ArtifactEditorDraft {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    path: item.path,
    projectId: item.projectId,
    projectName: item.projectName ?? "",
    tags: [...item.tags],
    contentMarkdown: item.contentMarkdown ?? "",
    mimeType: item.mimeType,
    previewPdfStatus: item.previewPdfStatus,
    previewPdfUpdatedAt: item.previewPdfUpdatedAt,
    sizeBytes: item.sizeBytes,
    version: item.version,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

export function buildTree(items: ArtifactItem[]): TreeFolderNode {
  const root: TreeFolderNode = {
    name: "",
    path: "",
    folders: new Map<string, TreeFolderNode>(),
    items: []
  };

  const ensureFolder = (folderPath: string): TreeFolderNode => {
    const normalized = normalizePath(folderPath);
    if (!normalized) return root;

    const segments = normalized.split("/");
    let cursor = root;
    let cursorPath = "";

    for (const segment of segments) {
      cursorPath = cursorPath ? `${cursorPath}/${segment}` : segment;
      let child = cursor.folders.get(segment);
      if (!child) {
        child = {
          name: segment,
          path: cursorPath,
          folders: new Map<string, TreeFolderNode>(),
          items: []
        };
        cursor.folders.set(segment, child);
      }
      cursor = child;
    }

    return cursor;
  };

  for (const item of items) {
    const pathValue = normalizePath(item.path);
    if (!pathValue) continue;

    if (item.kind === "folder") {
      const folderNode = ensureFolder(pathValue);
      folderNode.folderItem = item;
      continue;
    }

    const parent = ensureFolder(parentPath(pathValue));
    parent.items.push(item);
  }

  return root;
}

export function sortItems(items: ArtifactItem[]): ArtifactItem[] {
  return [...items].sort((a, b) => {
    if (a.kind !== b.kind) {
      if (a.kind === "note") return -1;
      if (b.kind === "note") return 1;
    }
    return a.path.localeCompare(b.path, undefined, { sensitivity: "base" });
  });
}

export function uniqueProjectOptions(records: ProjectRecord[], pinned?: ProjectOption | null): ProjectOption[] {
  const map = new Map<string, ProjectOption>();
  if (pinned?.projectId) {
    map.set(pinned.projectId, pinned);
  }
  for (const record of records) {
    map.set(record.id, { projectId: record.id, projectName: record.name });
  }
  return [...map.values()].sort((a, b) => (a.projectName || a.projectId).localeCompare(b.projectName || b.projectId));
}

export function collectVisibleSelectableItemIds(root: TreeFolderNode, collapsedFolders: Record<string, true>): string[] {
  const result: string[] = [];

  const visit = (folder: TreeFolderNode) => {
    const sortedFolders = [...folder.folders.values()].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    );
    const sortedItems = sortItems(folder.items);

    for (const childFolder of sortedFolders) {
      if (childFolder.folderItem) {
        result.push(childFolder.folderItem.id);
      }
      if (!collapsedFolders[childFolder.path]) {
        visit(childFolder);
      }
    }

    for (const item of sortedItems) {
      result.push(item.id);
    }
  };

  visit(root);
  return result;
}
