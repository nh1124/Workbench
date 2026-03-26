import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link, useSearchParams } from "react-router-dom";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { TextInputDialog } from "../components/TextInputDialog";
import { artifactsApi, projectsApi } from "../lib/api";
import { formatDateTime, normalizeProjectName } from "../lib/format";
import type { ArtifactItem, ArtifactItemKind, ProjectRecord } from "../types/models";
import "./ArtifactsPage.css";

interface ArtifactEditorDraft {
  id?: string;
  kind: ArtifactItemKind;
  title: string;
  path: string;
  projectId: string;
  projectName: string;
  tags: string[];
  contentMarkdown: string;
  mimeType?: string;
  sizeBytes?: number;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
}

interface ProjectOption {
  projectId: string;
  projectName?: string;
}

interface TreeFolderNode {
  name: string;
  path: string;
  folderItem?: ArtifactItem;
  folders: Map<string, TreeFolderNode>;
  items: ArtifactItem[];
}

type TreeContextTarget =
  | { type: "background"; folderPath: string }
  | { type: "folder"; folderPath: string }
  | { type: "item"; item: ArtifactItem };

interface TreeContextMenuState {
  x: number;
  y: number;
  target: TreeContextTarget;
}

interface DeleteConfirmState {
  ids: string[];
  count: number;
  title?: string;
}

interface CreateFolderState {
  baseFolderPath: string;
}

const defaultDraft: ArtifactEditorDraft = {
  kind: "note",
  title: "",
  path: "",
  projectId: "",
  projectName: "",
  tags: [],
  contentMarkdown: ""
};

function normalizePath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join("/");
}

function parentPath(itemPath: string): string {
  const normalized = normalizePath(itemPath);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : "";
}

function leafPath(itemPath: string): string {
  const normalized = normalizePath(itemPath);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function joinPath(basePath: string, leaf: string): string {
  const base = normalizePath(basePath);
  const cleanLeaf = normalizePath(leaf);
  if (!base) return cleanLeaf;
  if (!cleanLeaf) return base;
  return `${base}/${cleanLeaf}`;
}

function formatSize(value?: number): string {
  if (!value || value <= 0) return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function isPdf(item: ArtifactEditorDraft): boolean {
  const mime = (item.mimeType ?? "").toLowerCase();
  if (mime.includes("pdf")) return true;
  return /\.pdf$/i.test(item.path);
}

function isMarkdownFilePath(itemPath: string): boolean {
  return /\.(md|markdown)$/i.test(itemPath.trim());
}

function itemToDraft(item: ArtifactItem): ArtifactEditorDraft {
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
    sizeBytes: item.sizeBytes,
    version: item.version,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

function buildTree(items: ArtifactItem[]): TreeFolderNode {
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

function sortItems(items: ArtifactItem[]): ArtifactItem[] {
  return [...items].sort((a, b) => {
    if (a.kind !== b.kind) {
      if (a.kind === "note") return -1;
      if (b.kind === "note") return 1;
    }
    return a.path.localeCompare(b.path, undefined, { sensitivity: "base" });
  });
}

function uniqueProjectOptions(records: ProjectRecord[], pinned?: ProjectOption | null): ProjectOption[] {
  const map = new Map<string, ProjectOption>();
  if (pinned?.projectId) {
    map.set(pinned.projectId, pinned);
  }
  for (const record of records) {
    map.set(record.id, { projectId: record.id, projectName: record.name });
  }
  return [...map.values()].sort((a, b) => (a.projectName || a.projectId).localeCompare(b.projectName || b.projectId));
}

function collectVisibleSelectableItemIds(root: TreeFolderNode, collapsedFolders: Record<string, true>): string[] {
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

const IcoHome = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M3 11l9-8 9 8" />
    <path d="M5 10v10h14V10" />
  </svg>
);

const IcoFolder = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);

const IcoFile = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
    <path d="M14 3v6h6" />
  </svg>
);

const IcoUpload = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M12 16V4" />
    <path d="M7 9l5-5 5 5" />
    <path d="M4 20h16" />
  </svg>
);

const IcoDownload = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M12 4v12" />
    <path d="M7 11l5 5 5-5" />
    <path d="M4 20h16" />
  </svg>
);

const IcoTrash = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
    <path d="M9 6V4h6v2" />
  </svg>
);

const IcoClose = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
);

const IcoFloppy = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
    <polyline points="17 21 17 13 7 13 7 21" />
    <polyline points="7 3 7 8 15 8" />
  </svg>
);


export function ArtifactsPage() {
  const ROOT_DROP_PATH = "";
  const [searchParams] = useSearchParams();
  const requestedItemId = searchParams.get("item");
  const [projectOptions, setProjectOptions] = useState<ProjectOption[]>([]);
  const [defaultProject, setDefaultProject] = useState<ProjectOption | null>(null);
  const [projectFilter, setProjectFilter] = useState("");
  const [items, setItems] = useState<ArtifactItem[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, true>>({});
  const [draft, setDraft] = useState<ArtifactEditorDraft>(defaultDraft);
  const [mode, setMode] = useState<"view" | "create-note">("view");
  const [tagInput, setTagInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [notePreviewMode, setNotePreviewMode] = useState<"edit" | "preview">("edit");
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<TreeContextMenuState | null>(null);
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState | null>(null);
  const [createFolderState, setCreateFolderState] = useState<CreateFolderState | null>(null);

  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const draggingItemRef = useRef<ArtifactItem | null>(null);

  const treeRoot = useMemo(() => buildTree(items), [items]);
  const visibleSelectableItemIds = useMemo(
    () => collectVisibleSelectableItemIds(treeRoot, collapsedFolders),
    [treeRoot, collapsedFolders]
  );
  const selectedItemIdSet = useMemo(() => new Set(selectedItemIds), [selectedItemIds]);

  const currentFolderPath = useMemo(() => {
    if (selectedFolderPath !== null) return selectedFolderPath;
    if (mode === "create-note") return parentPath(draft.path);
    if (draft.id) return parentPath(draft.path);
    return "";
  }, [draft.id, draft.path, mode, selectedFolderPath]);

  const currentFolderNode = useMemo(() => {
    let cursor = treeRoot;
    if (currentFolderPath) {
      const segments = currentFolderPath.split("/").filter(Boolean);
      for (const segment of segments) {
        const child = cursor.folders.get(segment);
        if (!child) return cursor;
        cursor = child;
      }
    }
    return cursor;
  }, [treeRoot, currentFolderPath]);

  const selectedItemSummary = useMemo(
    () => items.find((item) => item.id === selectedItemId) ?? null,
    [items, selectedItemId]
  );
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const draggingItem = useMemo(
    () => (draggingItemId ? items.find((item) => item.id === draggingItemId) ?? null : null),
    [draggingItemId, items]
  );

  const markdownEditorVisible = useMemo(() => {
    if (mode === "create-note") return true;
    if (draft.kind === "note") return true;
    return draft.kind === "file" && isMarkdownFilePath(draft.path);
  }, [draft.kind, draft.path, mode]);

  const canSave = useMemo(() => {
    if (!draft.title.trim()) return false;
    if (!draft.path.trim()) return false;
    return true;
  }, [draft.path, draft.title]);

  const contextMenuPosition = useMemo(() => {
    if (!contextMenu) return null;
    const menuWidth = 180;
    const menuHeight = 132;
    const margin = 8;
    const maxX = window.innerWidth - menuWidth - margin;
    const maxY = window.innerHeight - menuHeight - margin;
    return {
      left: Math.max(margin, Math.min(contextMenu.x, maxX)),
      top: Math.max(margin, Math.min(contextMenu.y, maxY))
    };
  }, [contextMenu]);

  const contextDeleteCandidateIds = useMemo(() => {
    if (!contextMenu) {
      return [];
    }
    const target = contextMenu.target;
    if (selectedItemIds.length > 0) {
      return selectedItemIds;
    }
    if (target.type === "item") {
      return [target.item.id];
    }
    if (target.type === "folder") {
      const folder = items.find(
        (item) => item.kind === "folder" && normalizePath(item.path) === normalizePath(target.folderPath)
      );
      return folder ? [folder.id] : [];
    }
    return [];
  }, [contextMenu, items, selectedItemIds]);

  const resolveProjectFromFilter = (): ProjectOption => {
    if (projectFilter.trim()) {
      const found = projectOptions.find((project) => project.projectId === projectFilter.trim());
      return found ?? { projectId: projectFilter.trim() };
    }

    if (defaultProject) {
      return defaultProject;
    }

    if (projectOptions.length > 0) return projectOptions[0];
    return { projectId: "default", projectName: "default" };
  };

  const resolveProjectFromDraft = (): ProjectOption => {
    if (draft.projectId.trim()) {
      const found = projectOptions.find((project) => project.projectId === draft.projectId.trim());
      return found ?? { projectId: draft.projectId.trim(), projectName: draft.projectName.trim() || undefined };
    }

    return resolveProjectFromFilter();
  };

  const loadProjects = async () => {
    const defaultSelection = await projectsApi.getDefault().catch(() => null);
    const resolvedDefault: ProjectOption | null = defaultSelection
      ? { projectId: defaultSelection.project.id, projectName: defaultSelection.project.name }
      : null;
    setDefaultProject(resolvedDefault);

    try {
      const all: ProjectRecord[] = [];
      let cursor: string | undefined;

      for (let page = 0; page < 20; page += 1) {
        const result = await projectsApi.list(undefined, undefined, 100, cursor);
        all.push(...result.items);
        if (!result.nextCursor) {
          break;
        }
        cursor = result.nextCursor;
      }

      setProjectOptions(uniqueProjectOptions(all, resolvedDefault));
    } catch {
      // Fallback only when Projects service is unavailable.
      try {
        const fallback = await artifactsApi.projects();
        const fallbackOptions = fallback
          .map((project) => ({ projectId: project.projectId, projectName: project.projectName }))
          .sort((a, b) => (a.projectName || a.projectId).localeCompare(b.projectName || b.projectId));
        const merged = new Map<string, ProjectOption>();
        if (resolvedDefault?.projectId) {
          merged.set(resolvedDefault.projectId, resolvedDefault);
        }
        for (const option of fallbackOptions) {
          merged.set(option.projectId, option);
        }
        setProjectOptions([...merged.values()]);
      } catch {
        // Notification is handled globally.
      }
    }
  };

  const loadTree = async () => {
    setIsLoading(true);
    try {
      const treeItems = await artifactsApi.tree(projectFilter || undefined);
      setItems(treeItems);

      if (selectedItemId && !treeItems.some((item) => item.id === selectedItemId)) {
        setSelectedItemId(null);
        setSelectedItemIds([]);
        setSelectionAnchorId(null);
        const fallbackProject = resolveProjectFromFilter();
        setDraft({
          ...defaultDraft,
          projectId: fallbackProject.projectId,
          projectName: fallbackProject.projectName ?? ""
        });
        setMode("view");
      }
    } catch {
      // Notification is handled globally.
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadProjects();
  }, []);

  useEffect(() => {
    void loadTree();
  }, [projectFilter]);

  useEffect(() => {
    if (!requestedItemId) {
      return;
    }

    const target = items.find((item) => item.id === requestedItemId);
    if (!target || selectedItemId === requestedItemId) {
      return;
    }

    setSelectedItemId(target.id);
    setSelectedItemIds([target.id]);
    setSelectionAnchorId(target.id);
    setSelectedFolderPath(parentPath(target.path));
  }, [items, requestedItemId, selectedItemId]);

  useEffect(() => {
    if (!selectedItemId) {
      return;
    }

    let cancelled = false;
    void artifactsApi
      .getItem(selectedItemId)
      .then((item) => {
        if (cancelled) return;
        const nextDraft = itemToDraft(item);
        setDraft(nextDraft);
        setMode("view");
      })
      .catch(() => {
        // Notification is handled globally.
      });

    return () => {
      cancelled = true;
    };
  }, [selectedItemId]);

  useEffect(() => {
    if (!draft.id || draft.kind !== "file" || !isPdf(draft)) {
      if (pdfBlobUrl) {
        URL.revokeObjectURL(pdfBlobUrl);
      }
      setPdfBlobUrl(null);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;

    void artifactsApi
      .downloadFile(draft.id, false)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPdfBlobUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) {
          setPdfBlobUrl(null);
        }
      });

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [draft.id, draft.kind, draft.mimeType, draft.path]);

  useEffect(() => {
    if (!contextMenu) return;

    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    };
    const handleClose = () => {
      setContextMenu(null);
    };

    window.addEventListener("keydown", handleEscape);
    window.addEventListener("resize", handleClose);
    window.addEventListener("scroll", handleClose, true);
    return () => {
      window.removeEventListener("keydown", handleEscape);
      window.removeEventListener("resize", handleClose);
      window.removeEventListener("scroll", handleClose, true);
    };
  }, [contextMenu]);

  useEffect(() => {
    const existingIds = new Set(items.map((item) => item.id));
    setSelectedItemIds((prev) => {
      const next = prev.filter((id) => existingIds.has(id));
      return next.length === prev.length ? prev : next;
    });
    setSelectionAnchorId((prev) => (prev && existingIds.has(prev) ? prev : null));
  }, [items]);

  const updateSelection = (itemId: string, shiftKey: boolean) => {
    if (shiftKey && selectionAnchorId) {
      const anchorIndex = visibleSelectableItemIds.indexOf(selectionAnchorId);
      const currentIndex = visibleSelectableItemIds.indexOf(itemId);
      if (anchorIndex >= 0 && currentIndex >= 0) {
        const start = Math.min(anchorIndex, currentIndex);
        const end = Math.max(anchorIndex, currentIndex);
        setSelectedItemIds(visibleSelectableItemIds.slice(start, end + 1));
        return;
      }
    }
    setSelectedItemIds([itemId]);
    setSelectionAnchorId(itemId);
  };

  const selectItem = (item: ArtifactItem, options?: { shiftKey?: boolean }) => {
    const withShift = Boolean(options?.shiftKey);
    setSelectedItemId(item.id);
    updateSelection(item.id, withShift);
    setSelectedFolderPath(parentPath(item.path));
    setError(null);
    setTagInput("");
  };

  const toggleFolder = (folderPath: string) => {
    setCollapsedFolders((prev) => {
      const next = { ...prev };
      if (next[folderPath]) {
        delete next[folderPath];
      } else {
        next[folderPath] = true;
      }
      return next;
    });
  };

  const openContextMenu = (event: MouseEvent<HTMLButtonElement | HTMLElement>, target: TreeContextTarget) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      target
    });
  };

  const handleStartCreateNote = () => {
    const targetProject = resolveProjectFromFilter();

    const newPath = joinPath(currentFolderPath, "new-note.md") || "new-note.md";
    setMode("create-note");
    setSelectedItemId(null);
    setSelectedItemIds([]);
    setSelectionAnchorId(null);
    setDraft({
      ...defaultDraft,
      kind: "note",
      title: "New Note",
      path: newPath,
      projectId: targetProject.projectId,
      projectName: targetProject.projectName ?? "",
      tags: [],
      contentMarkdown: ""
    });
    setError(null);
    setTagInput("");
    setNotePreviewMode("edit");
  };

  const handleCreateFolder = (baseFolderPath = currentFolderPath) => {
    setCreateFolderState({
      baseFolderPath: normalizePath(baseFolderPath)
    });
  };

  const handleCreateFolderConfirm = async (name: string) => {
    if (!createFolderState) {
      return;
    }
    const normalizedName = name.trim();
    if (!normalizedName) return;

    const activeProject = resolveProjectFromFilter();
    const folderPath = joinPath(createFolderState.baseFolderPath, normalizedName);
    setIsSaving(true);
    setError(null);

    try {
      const created = await artifactsApi.createFolder({
        projectId: activeProject.projectId,
        projectName: activeProject.projectName,
        path: folderPath,
        title: normalizedName
      });

      setSelectedFolderPath(created.path);
      await loadTree();
      setCreateFolderState(null);
    } catch (createError) {
      const message = createError instanceof Error ? createError.message : "Unable to create folder.";
      setError(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleUploadClick = () => {
    uploadInputRef.current?.click();
  };

  const handleUploadFiles = async (files: FileList | null, targetPath?: string) => {
    if (!files || files.length === 0) return;

    const activeProject = resolveProjectFromFilter();

    setIsSaving(true);
    setError(null);

    try {
      let lastUploadedId: string | null = null;
      for (const file of Array.from(files)) {
        const uploaded = await artifactsApi.uploadFile({
          projectId: activeProject.projectId,
          projectName: activeProject.projectName,
          directoryPath: targetPath ?? (currentFolderPath || undefined),
          file
        });
        lastUploadedId = uploaded.id;
      }

      await loadTree();
      if (lastUploadedId) {
        setSelectedItemId(lastUploadedId);
        setSelectedItemIds([lastUploadedId]);
        setSelectionAnchorId(lastUploadedId);
      }
    } catch (uploadError) {
      const message = uploadError instanceof Error ? uploadError.message : "Upload failed.";
      setError(message);
    } finally {
      setIsSaving(false);
      if (uploadInputRef.current) {
        uploadInputRef.current.value = "";
      }
    }
  };

  const handleSave = async () => {
    if (!canSave) {
      setError("Title, path は必須です。");
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      if (mode === "create-note" || !draft.id) {
        const activeProject = resolveProjectFromDraft();

        const created = await artifactsApi.createNote({
          projectId: activeProject.projectId,
          projectName: activeProject.projectName,
          path: draft.path.trim(),
          title: draft.title.trim(),
          tags: draft.tags,
          contentMarkdown: draft.contentMarkdown
        });

        await loadTree();
        setSelectedItemId(created.id);
        setSelectedItemIds([created.id]);
        setSelectionAnchorId(created.id);
        setMode("view");
      } else {
        const activeProject = resolveProjectFromDraft();
        const updated = await artifactsApi.updateItem(draft.id, {
          title: draft.title.trim(),
          path: draft.path.trim(),
          tags: draft.tags,
          contentMarkdown: markdownEditorVisible ? draft.contentMarkdown : undefined,
          projectName: activeProject.projectName
        });

        setDraft(itemToDraft(updated));
        await loadTree();
      }
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : "Save failed.";
      setError(message);
    } finally {
      setIsSaving(false);
    }
  };

  const createDeleteConfirmState = (ids: string[]): DeleteConfirmState | null => {
    const normalized = [...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0))];
    if (normalized.length === 0) {
      return null;
    }
    if (normalized.length === 1) {
      const item = itemsById.get(normalized[0]);
      return {
        ids: normalized,
        count: 1,
        title: item?.title || "selected item"
      };
    }
    return {
      ids: normalized,
      count: normalized.length
    };
  };

  const resolveBatchDeleteIds = (ids: string[]): string[] => {
    const selected = ids
      .map((id) => itemsById.get(id))
      .filter((item): item is ArtifactItem => Boolean(item));

    if (selected.length === 0) {
      return [];
    }

    const folderPaths = selected
      .filter((item) => item.kind === "folder")
      .map((item) => normalizePath(item.path));

    const filtered = selected.filter((item) => {
      const itemPath = normalizePath(item.path);
      return !folderPaths.some((folderPath) => folderPath !== itemPath && itemPath.startsWith(`${folderPath}/`));
    });

    return filtered
      .sort((a, b) => normalizePath(b.path).length - normalizePath(a.path).length)
      .map((item) => item.id);
  };

  const deleteItemsByIds = async (itemIds: string[]) => {
    const targets = resolveBatchDeleteIds(itemIds);
    if (targets.length === 0) {
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      let deletedCount = 0;
      for (const id of targets) {
        try {
          await artifactsApi.removeItem(id);
          deletedCount += 1;
        } catch {
          // Continue deleting remaining targets.
        }
      }

      const deletedIdSet = new Set(targets);
      if ((selectedItemId && deletedIdSet.has(selectedItemId)) || (draft.id && deletedIdSet.has(draft.id))) {
        setSelectedItemId(null);
        setDraft({ ...defaultDraft });
      }
      setSelectedItemIds((prev) => prev.filter((id) => !deletedIdSet.has(id)));
      setSelectionAnchorId((prev) => (prev && deletedIdSet.has(prev) ? null : prev));
      await loadTree();
      if (deletedCount < targets.length) {
        setError(`Deleted ${deletedCount}/${targets.length} items. Some items could not be deleted.`);
      }
    } catch (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : "Delete failed.";
      setError(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    const ids = selectedItemIds.length > 0 ? selectedItemIds : draft.id ? [draft.id] : [];
    const nextConfirm = createDeleteConfirmState(ids);
    if (!nextConfirm) {
      return;
    }
    setDeleteConfirm(nextConfirm);
  };

  const handleDownload = async () => {
    if (!draft.id || draft.kind !== "file") return;

    try {
      const blob = await artifactsApi.downloadFile(draft.id, true);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = draft.title || "artifact";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      // Global notification already shown.
    }
  };

  const handleTagInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      const normalized = tagInput.trim();
      if (!normalized) return;
      if (draft.tags.some((tag) => tag.toLowerCase() === normalized.toLowerCase())) {
        setTagInput("");
        return;
      }
      setDraft((prev) => ({ ...prev, tags: [...prev.tags, normalized] }));
      setTagInput("");
    }

    if (event.key === "Backspace" && !tagInput && draft.tags.length > 0) {
      setDraft((prev) => ({ ...prev, tags: prev.tags.slice(0, -1) }));
    }
  };

  const isInvalidFolderMove = (item: ArtifactItem, targetFolderPath: string): boolean => {
    if (item.kind !== "folder") {
      return false;
    }
    const normalizedTarget = normalizePath(targetFolderPath);
    const sourcePath = normalizePath(item.path);
    if (normalizedTarget === sourcePath) {
      return true;
    }
    return normalizedTarget.startsWith(`${sourcePath}/`);
  };

  const moveItemToFolder = async (item: ArtifactItem, destinationFolderPath: string) => {
    const normalizedDestination = normalizePath(destinationFolderPath);
    const nextPath = normalizePath(joinPath(normalizedDestination, leafPath(item.path)));
    if (!nextPath || nextPath === normalizePath(item.path)) {
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      const updated = await artifactsApi.updateItem(item.id, { path: nextPath });
      if (selectedItemId === item.id || draft.id === item.id) {
        setDraft(itemToDraft(updated));
        setSelectedFolderPath(parentPath(updated.path));
      }
      await loadTree();
    } catch (moveError) {
      const message = moveError instanceof Error ? moveError.message : "Move failed.";
      setError(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDragStart = (event: DragEvent<HTMLButtonElement>, item: ArtifactItem) => {
    setContextMenu(null);
    setDraggingItemId(item.id);
    draggingItemRef.current = item;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", item.id);
  };

  const handleDragEnd = () => {
    draggingItemRef.current = null;
    setDraggingItemId(null);
    setDropTargetPath(null);
  };

  const resolveDraggedItemFromEvent = (event: DragEvent<HTMLElement>): ArtifactItem | null => {
    const transferId = event.dataTransfer.getData("text/plain").trim();
    if (transferId) {
      const found = items.find((item) => item.id === transferId);
      if (found) {
        return found;
      }
    }
    if (draggingItemRef.current) {
      return draggingItemRef.current;
    }
    return draggingItem;
  };

  const handleFolderDragOver = (event: DragEvent<HTMLButtonElement>, targetFolderPath: string) => {
    const hasFiles = event.dataTransfer.types.includes("Files");
    const dragItem = resolveDraggedItemFromEvent(event);
    if (!dragItem && !hasFiles) {
      setDropTargetPath(null);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = hasFiles ? "copy" : "move";
    setDropTargetPath(normalizePath(targetFolderPath));
  };

  const handleRootDrop = (event: DragEvent<HTMLElement>) => {
    if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      setDropTargetPath(null);
      void handleUploadFiles(event.dataTransfer.files, ROOT_DROP_PATH);
      return;
    }
    event.preventDefault();
    const dragItem = resolveDraggedItemFromEvent(event);
    if (!dragItem) return;
    if (isInvalidFolderMove(dragItem, ROOT_DROP_PATH)) return;
    setDropTargetPath(null);
    void moveItemToFolder(dragItem, ROOT_DROP_PATH);
  };

  const handleFolderDrop = (event: DragEvent<HTMLButtonElement>, targetFolderPath: string) => {
    if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      setDropTargetPath(null);
      void handleUploadFiles(event.dataTransfer.files, targetFolderPath);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const dragItem = resolveDraggedItemFromEvent(event);
    if (!dragItem) return;
    if (isInvalidFolderMove(dragItem, targetFolderPath)) return;
    setDropTargetPath(null);
    void moveItemToFolder(dragItem, targetFolderPath);
  };

  const handleRootDragOver = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropTargetPath(ROOT_DROP_PATH);
  };

  const executeContextAction = (action: () => Promise<void> | void) => {
    setContextMenu(null);
    void action();
  };

  const renderDirectoryBrowser = (): ReactNode => {
    const sortedFolders = [...currentFolderNode.folders.values()].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    );
    const sortedItems = sortItems(currentFolderNode.items);

    return (
      <ul className="va-tree-list">
        {currentFolderPath !== "" && (
          <li>
            <button
              type="button"
              className="va-tree-row folder"
              onClick={() => setSelectedFolderPath(parentPath(currentFolderPath))}
            >
              <span className="va-tree-icon" aria-hidden="true"><IcoFolder /></span>
              <span className="va-tree-label">..</span>
            </button>
          </li>
        )}
        {sortedFolders.map((childFolder) => {
          const isSelected = selectedFolderPath === childFolder.path;
          const isDropTarget = dropTargetPath === normalizePath(childFolder.path);
          const draggableFolderItem = childFolder.folderItem;
          const isFolderItemSelected = Boolean(draggableFolderItem && selectedItemIdSet.has(draggableFolderItem.id));

          return (
            <li key={`folder-${childFolder.path}`}>
              <button
                type="button"
                className={[
                  "va-tree-row",
                  "folder",
                  isSelected ? "active" : "",
                  isFolderItemSelected ? "multi-selected" : "",
                  isDropTarget ? "drop-target" : "",
                  draggableFolderItem && draggingItemId === draggableFolderItem.id ? "dragging" : ""
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={(event) => {
                  setSelectedFolderPath(childFolder.path);
                  if (childFolder.folderItem) {
                    updateSelection(childFolder.folderItem.id, event.shiftKey);
                  }
                }}
                onDoubleClick={() => setSelectedFolderPath(childFolder.path)}
                onContextMenu={(event) =>
                  openContextMenu(event, {
                    type: "folder",
                    folderPath: childFolder.path
                  })
                }
                draggable={Boolean(draggableFolderItem)}
                onDragStart={(event) => {
                  if (!draggableFolderItem) return;
                  handleDragStart(event, draggableFolderItem);
                }}
                onDragEnd={handleDragEnd}
                onDragEnter={(event) => handleFolderDragOver(event, childFolder.path)}
                onDragOver={(event) => handleFolderDragOver(event, childFolder.path)}
                onDrop={(event) => handleFolderDrop(event, childFolder.path)}
              >
                <span className="va-tree-icon" aria-hidden="true"><IcoFolder /></span>
                <span className="va-tree-label">{childFolder.name}</span>
              </button>
            </li>
          );
        })}

        {sortedItems.map((item) => {
          const isSelected = selectedItemIdSet.has(item.id);
          return (
            <li key={item.id}>
              <button
                type="button"
                className={[
                  "va-tree-row",
                  "item",
                  isSelected ? "active" : "",
                  isSelected ? "multi-selected" : "",
                  draggingItemId === item.id ? "dragging" : ""
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={(event) => selectItem(item, { shiftKey: event.shiftKey })}
                onContextMenu={(event) => openContextMenu(event, { type: "item", item })}
                draggable
                onDragStart={(event) => handleDragStart(event, item)}
                onDragEnd={handleDragEnd}
              >
                <span className="va-tree-icon" aria-hidden="true"><IcoFile /></span>
                <span className="va-tree-label">{item.title}</span>
                <small>v{item.version}</small>
              </button>
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <section className="va-artifacts-page" onClick={() => setContextMenu(null)}>
      <section className="va-shell panel">
        <header className="va-toolbar">
          <div className="va-toolbar-left">
            <button
              type="button"
              className="va-home-icon-btn"
              onClick={() => setSelectedFolderPath("")}
              aria-label="Home"
              title="Root Directory"
            >
              <span className="va-home-icon" aria-hidden="true"><IcoHome /></span>
            </button>
            <strong>{currentFolderPath || "root"}</strong>
          </div>

          <div className="va-toolbar-right">
            <label className="va-project-select-wrap">
              <span>Project</span>
              <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}>
                <option value="">All</option>
                {projectOptions.map((project) => (
                  <option key={project.projectId} value={project.projectId}>
                    {normalizeProjectName(project.projectId, project.projectName)}
                  </option>
                ))}
              </select>
            </label>

            <button type="button" className="va-action-btn" onClick={handleUploadClick} disabled={isSaving}>
              <IcoUpload /> Upload
            </button>
            <button type="button" className="va-action-btn" onClick={() => void handleCreateFolder()} disabled={isSaving}>
              <IcoFolder /> New Folder
            </button>
            <button type="button" className="va-action-btn primary" onClick={handleStartCreateNote} disabled={isSaving}>
              + New Note
            </button>
          </div>
        </header>

        {error ? <p className="va-inline-error">{error}</p> : null}

        <div className={`va-main-grid ${selectedItemId || mode === "create-note" ? "viewer-active" : "browser-active"}`}>
          <aside
            className={[
              "va-tree-pane",
              dropTargetPath === ROOT_DROP_PATH ? "drop-target-root" : ""
            ]
              .filter(Boolean)
              .join(" ")}
            onContextMenu={(event) =>
              openContextMenu(event, {
                type: "background",
                folderPath: ""
              })
            }
            onDragEnter={handleRootDragOver}
            onDragOver={handleRootDragOver}
            onDrop={handleRootDrop}
          >
            {isLoading ? <div className="va-empty">Loading...</div> : renderDirectoryBrowser()}
            <footer className="va-tree-foot">
              <span>{selectedItemIds.length} selected</span>
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  setSelectedItemId(null);
                  setSelectedItemIds([]);
                  setSelectionAnchorId(null);
                }}
              >
                Clear
              </button>
            </footer>
          </aside>

          <main className="va-detail-pane">
            <header className="va-detail-head">
              <div className="va-detail-title-block">
                <span className="va-detail-path">{draft.path || "No item selected"}</span>
                {draft.version ? <small>v{draft.version}</small> : null}
              </div>

              <div className="va-detail-actions">
                <button
                  type="button"
                  className="va-icon-btn va-close-viewer-btn"
                  onClick={() => {
                    setSelectedItemId(null);
                    setSelectedItemIds([]);
                    setSelectionAnchorId(null);
                    setMode("view");
                  }}
                  aria-label="Close viewer"
                  title="Close"
                >
                  <IcoClose />
                </button>

                {draft.kind === "file" && draft.id ? (
                  <button type="button" className="va-action-btn" onClick={() => void handleDownload()}>
                    <IcoDownload /> Download
                  </button>
                ) : null}

                {draft.id ? (
                  <button
                    type="button"
                    className="va-icon-btn"
                    onClick={() => void handleDelete()}
                    disabled={isSaving}
                    aria-label="Delete item"
                    title="Delete"
                  >
                    <IcoTrash />
                  </button>
                ) : null}

                <button type="button" className="va-action-btn primary" onClick={() => void handleSave()} disabled={isSaving || !canSave}>
                  <IcoFloppy />
                </button>
              </div>
            </header>

            <section className="va-form-grid">
              <label className="span-2">
                <span className="va-field-label">Title *</span>
                <input
                  value={draft.title}
                  onChange={(event) => setDraft((prev) => ({ ...prev, title: event.target.value }))}
                  placeholder="Title"
                />
              </label>

              <label className="span-2">
                <span className="va-field-label">Path *</span>
                <input
                  value={draft.path}
                  onChange={(event) => setDraft((prev) => ({ ...prev, path: event.target.value }))}
                  placeholder="asset/notes/idea.md"
                />
              </label>

              {draft.kind === "file" ? (
                <div className="span-2 va-meta-strip">
                  <div>
                    <small>MIME</small>
                    <p>{draft.mimeType || "-"}</p>
                  </div>
                  <div>
                    <small>SIZE</small>
                    <p>{formatSize(draft.sizeBytes)}</p>
                  </div>
                  <div>
                    <small>UPDATED</small>
                    <p>{draft.updatedAt ? formatDateTime(draft.updatedAt) : "-"}</p>
                  </div>
                </div>
              ) : null}

              {markdownEditorVisible ? (
                <div className="span-2 va-content-section">
                  <div className="va-content-head">
                    <span className="va-field-label">Content (Markdown)</span>
                    <div className="va-content-mode">
                      <button
                        type="button"
                        className={notePreviewMode === "edit" ? "active" : undefined}
                        onClick={() => setNotePreviewMode("edit")}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className={notePreviewMode === "preview" ? "active" : undefined}
                        onClick={() => setNotePreviewMode("preview")}
                      >
                        Preview
                      </button>
                    </div>
                  </div>

                  {notePreviewMode === "edit" ? (
                    <textarea
                      rows={14}
                      value={draft.contentMarkdown}
                      onChange={(event) => setDraft((prev) => ({ ...prev, contentMarkdown: event.target.value }))}
                      placeholder="# note"
                    />
                  ) : (
                    <div className="va-markdown-preview">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {draft.contentMarkdown || "_No content_"}
                      </ReactMarkdown>
                    </div>
                  )}
                </div>
              ) : null}

              {draft.kind === "file" && isPdf(draft) ? (
                <div className="span-2 va-preview-section">
                  <span className="va-field-label">Preview</span>
                  {pdfBlobUrl ? (
                    <iframe src={pdfBlobUrl} className="va-pdf-frame" title={draft.title} />
                  ) : (
                    <div className="va-empty">Loading PDF preview...</div>
                  )}
                </div>
              ) : null}

              <div className="span-2">
                <span className="va-field-label">Tags</span>
                <div className="va-tags-wrap" onClick={() => document.getElementById("va-artifact-tag-input")?.focus()}>
                  {draft.tags.map((tag) => (
                    <span key={tag} className="va-tag-chip">
                      {tag}
                      <button
                        type="button"
                        onClick={() => setDraft((prev) => ({ ...prev, tags: prev.tags.filter((value) => value !== tag) }))}
                        aria-label={`Remove ${tag}`}
                      >
                        x
                      </button>
                    </span>
                  ))}
                  <input
                    id="va-artifact-tag-input"
                    value={tagInput}
                    onChange={(event) => setTagInput(event.target.value)}
                    onKeyDown={handleTagInputKeyDown}
                    onBlur={() => {
                      const normalized = tagInput.trim();
                      if (!normalized) return;
                      if (!draft.tags.some((tag) => tag.toLowerCase() === normalized.toLowerCase())) {
                        setDraft((prev) => ({ ...prev, tags: [...prev.tags, normalized] }));
                      }
                      setTagInput("");
                    }}
                    placeholder="Add tag, press Enter"
                  />
                </div>
              </div>

              {(draft.createdAt || selectedItemSummary) ? (
                <div className="span-2 va-detail-meta">
                  {draft.createdAt ? <small>Created {formatDateTime(draft.createdAt)}</small> : null}
                  {draft.updatedAt ? <small>Updated {formatDateTime(draft.updatedAt)}</small> : null}
                  {selectedItemSummary ? (
                    <Link to={`/projects/${draft.projectId || selectedItemSummary.projectId}`}>Open Project View</Link>
                  ) : null}
                </div>
              ) : null}
            </section>
          </main>
        </div>
      </section>

      {contextMenu && contextMenuPosition ? (
        <div
          className="va-context-menu"
          style={{ left: contextMenuPosition.left, top: contextMenuPosition.top }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() =>
              executeContextAction(() => {
                if (contextMenu.target.type === "item") {
                  selectItem(contextMenu.target.item);
                  return;
                }
                if (contextMenu.target.type === "folder") {
                  setSelectedFolderPath(contextMenu.target.folderPath);
                  return;
                }
                setSelectedItemId(null);
                setSelectedItemIds([]);
                setSelectionAnchorId(null);
              })
            }
          >
            Open
          </button>
          <button
            type="button"
            onClick={() =>
              executeContextAction(() => {
                const basePath =
                  contextMenu.target.type === "item"
                    ? parentPath(contextMenu.target.item.path)
                    : contextMenu.target.folderPath;
                handleCreateFolder(basePath);
              })
            }
          >
            New Folder
          </button>
          <button
            type="button"
            onClick={() =>
              executeContextAction(() => {
                const nextConfirm = createDeleteConfirmState(contextDeleteCandidateIds);
                if (!nextConfirm) return;
                setDeleteConfirm(nextConfirm);
              })
            }
            disabled={contextDeleteCandidateIds.length === 0}
          >
            {contextDeleteCandidateIds.length > 1
              ? "Delete Selected"
              : contextMenu.target.type === "item" && selectedItemIds.length === 0
                ? "Delete File"
                : "Delete Selected"}
          </button>
        </div>
      ) : null}

      <ConfirmDialog
        open={Boolean(deleteConfirm)}
        title={deleteConfirm?.count && deleteConfirm.count > 1 ? "Delete Items" : "Delete Item"}
        message={
          deleteConfirm?.count && deleteConfirm.count > 1
            ? `Delete ${deleteConfirm.count} selected items?`
            : `Delete "${deleteConfirm?.title || "selected item"}"?`
        }
        confirmLabel="Delete"
        confirmTone="danger"
        busy={isSaving}
        onCancel={() => setDeleteConfirm(null)}
        onConfirm={() => {
          if (!deleteConfirm) return;
          const target = deleteConfirm;
          setDeleteConfirm(null);
          void deleteItemsByIds(target.ids);
        }}
      />

      <TextInputDialog
        open={Boolean(createFolderState)}
        title="New Folder"
        message={createFolderState?.baseFolderPath ? `Create in "${createFolderState.baseFolderPath}"` : "Create in root"}
        label="Folder name"
        placeholder="New Folder"
        confirmLabel="Create"
        busy={isSaving}
        onCancel={() => setCreateFolderState(null)}
        onConfirm={(value) => {
          void handleCreateFolderConfirm(value);
        }}
      />

      <input
        ref={uploadInputRef}
        type="file"
        multiple
        className="va-hidden-upload"
        onChange={(event) => void handleUploadFiles(event.target.files)}
      />
    </section>
  );
}

