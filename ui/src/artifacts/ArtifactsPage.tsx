import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import JSZip from "jszip";
import { Link, useSearchParams } from "react-router-dom";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { TextInputDialog } from "../components/TextInputDialog";
import { TitleBarPortal, useHasTitleBarSlot } from "../components/VariantChrome";
import { artifactsApi, isTauriNativeRuntime, openFileWithDefaultApp, saveFileWithDialog } from "../lib/api";
import { formatDateTime, normalizeProjectName } from "../lib/format";
import { isTextEditingTarget } from "../lib/keyboardShortcuts";
import type { ArtifactItem } from "../types/models";
import type {
  CreateFolderState,
  DeleteConfirmState,
  EditorContextMenuState,
  InsertLinkState,
  ProjectOption,
  TableSelectionState,
  TableContextMenuState,
  TreeContextMenuState,
  TreeContextTarget,
  TreeFolderNode
} from "./types";
import { defaultDraft, type ArtifactEditorDraft } from "./types";
import {
  isExternalUrl,
  isMarkdownFilePath,
  joinPath,
  leafPath,
  normalizePath,
  parentPath,
  relativeArtifactPath,
  resolveMarkdownRef
} from "./utils/path";
import {
  ensureItemExportFilename,
  formatSize,
  isImage,
  isPdf,
  isWordDocument,
  sanitizeExportFilename,
  triggerBlobDownload
} from "./utils/file";
import {
  buildTree,
  collectVisibleSelectableItemIds,
  itemToDraft
} from "./utils/tree";
import {
  createNotionBlock,
  findNotionBlock,
  getNotionTableRows,
  normalizeNotionBlockElement,
} from "./utils/notionMarkdown";
import {
  applyTableOperation,
  applyTableSelectionVisual,
  getSelectedTableContext,
  isCellInTableSelection
} from "./utils/notionTableOps";
import { parseMarkdownOutline, type MarkdownOutlineItem } from "./utils/markdownOutline";
import { insertBelowOutlineEntry, moveOutlineSection } from "./utils/markdownOutlineOps";
import { recordRecentArtifact } from "./utils/recents";
import { writeArtifactsLastLocation } from "./utils/lastLocation";
import {
  PINNED_ARTIFACTS_CHANGED_EVENT,
  readPinnedArtifacts,
  togglePinnedArtifact,
  type PinnedArtifact
} from "./utils/pins";
import { useArtifactProjects } from "./hooks/useArtifactProjects";
import { useArtifactsMarkdownEditor } from "./hooks/useArtifactsMarkdownEditor";
import { useArtifactPreview } from "./hooks/useArtifactPreview";
import { useArtifactContextMenus } from "./hooks/useArtifactContextMenus";
import {
  IcoClose,
  IcoChevronLeft,
  IcoCompress,
  IcoDownload,
  IcoExpand,
  IcoFile,
  IcoFloppy,
  IcoFolder,
  IcoHome,
  IcoListView,
  IcoPanelLeft,
  IcoSearch,
  IcoSettings,
  IcoTileView,
  IcoTrash,
  IcoUpload
} from "./components/ArtifactsIcons";
import { DirectoryBrowser } from "./components/DirectoryBrowser";
import type { DirectoryViewMode } from "./components/DirectoryBrowser";
import { ArtifactsQuickAccess } from "./components/ArtifactsQuickAccess";
import { ProjectCardGrid } from "./components/ProjectCardGrid";
import { ArtifactProjectMemberships } from "./components/ArtifactProjectMemberships";
import { MarkdownOutlinePanel } from "./components/MarkdownOutlinePanel";
import { PdfViewer } from "./components/PdfViewer";
import "./ArtifactsPage.css";


type RenameFolderState = {
  itemId: string;
  currentPath: string;
  currentName: string;
};

type MoveFolderProjectState = {
  itemId: string;
  currentPath: string;
  currentProjectId: string;
  targetProjectId: string;
};

const ARTIFACTS_RAIL_VISIBLE_STORAGE_KEY = "workbench-artifacts-rail-visible";
type ArtifactsSearchShortcutAction = "ignore" | "focus" | "expand";

export function readArtifactsRailVisible(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(ARTIFACTS_RAIL_VISIBLE_STORAGE_KEY) !== "0";
}

export function writeArtifactsRailVisible(visible: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ARTIFACTS_RAIL_VISIBLE_STORAGE_KEY, visible ? "1" : "0");
}

export function getArtifactsSearchShortcutAction(params: {
  isDedicatedApp: boolean;
  hasDetailSelection: boolean;
}): ArtifactsSearchShortcutAction {
  if (params.hasDetailSelection) return "ignore";
  return params.isDedicatedApp ? "focus" : "expand";
}

export function ArtifactsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const isDedicatedApp = useHasTitleBarSlot();
  const searchParamsKey = searchParams.toString();
  const requestedProjectId = searchParams.get("project")?.trim() ?? "";
  const requestedFolderPath = searchParams.get("folder")
    ? normalizePath(searchParams.get("folder") ?? "")
    : null;
  const requestedItemId = searchParams.get("item") || null;
  const requestedCreateMode = searchParams.get("new");
  const { projectOptions, defaultProject, projectsLoaded } = useArtifactProjects();
  const [projectFilter, setProjectFilter] = useState(requestedProjectId);
  const [items, setItems] = useState<ArtifactItem[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(requestedItemId);
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>(requestedItemId ? [requestedItemId] : []);
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(requestedItemId);
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(requestedFolderPath);
  const [directoryViewMode, setDirectoryViewMode] = useState<DirectoryViewMode>("tile");
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, true>>({});
  const [draft, setDraft] = useState<ArtifactEditorDraft>(defaultDraft);
  const [mode, setMode] = useState<"view" | "create-note">("view");
  const [tagInput, setTagInput] = useState("");
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [pinnedArtifacts, setPinnedArtifacts] = useState<PinnedArtifact[]>(() => readPinnedArtifacts());
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [notePreviewMode, setNotePreviewMode] = useState<"edit" | "live">("edit");
  const { pdfBlobUrl, imageBlobUrl, pdfExpanded, setPdfExpanded } = useArtifactPreview(draft, setDraft);
  const {
    contextMenu,
    setContextMenu,
    contextMenuPosition,
    tableContextMenu,
    setTableContextMenu,
    tableContextMenuPosition,
    editorContextMenu,
    setEditorContextMenu,
    editorContextMenuPosition,
    outlineContextMenu,
    setOutlineContextMenu,
    outlineContextMenuPosition
  } = useArtifactContextMenus();
  const [tableSelection, setTableSelection] = useState<TableSelectionState | null>(null);
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState | null>(null);
  const [createFolderState, setCreateFolderState] = useState<CreateFolderState | null>(null);
  const [renameFolderState, setRenameFolderState] = useState<RenameFolderState | null>(null);
  const [moveFolderProjectState, setMoveFolderProjectState] = useState<MoveFolderProjectState | null>(null);
  const [insertLinkState, setInsertLinkState] = useState<InsertLinkState | null>(null);
  const [editorExpanded, setEditorExpanded] = useState(false);
  const [artifactSettingsOpen, setArtifactSettingsOpen] = useState(false);
  const [editSidebarCollapsed, setEditSidebarCollapsed] = useState(false);
  const [mobileTreeVisible, setMobileTreeVisible] = useState(false);
  const [outlineCollapsed, setOutlineCollapsed] = useState(false);
  const [outlineBodyHeight, setOutlineBodyHeight] = useState(170);
  const [railVisible, setRailVisible] = useState(() => readArtifactsRailVisible());

  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const draggingItemRef = useRef<ArtifactItem | null>(null);
  const tableSelectionDragRef = useRef<TableSelectionState | null>(null);
  const loadTreeRef = useRef<() => Promise<void>>(async () => {});
  // Monotonic token so a slow tree response cannot overwrite a newer one.
  const loadTreeSeqRef = useRef(0);
  const handleCreateNoteRef = useRef<() => void>(() => {});
  const handleSaveRef = useRef<() => Promise<void>>(async () => {});
  const handleArtifactHistoryNavRef = useRef<(direction: -1 | 1) => void>(() => {});
  const shortcutStateRef = useRef({ canSave: false, isSaving: false, markdownEditorVisible: false, pdfViewerVisible: false });
  const searchShortcutStateRef = useRef<{
    action: ArtifactsSearchShortcutAction;
    searchExpanded: boolean;
  }>({ action: "expand", searchExpanded: false });
  const artifactNavHistoryRef = useRef<{ ids: string[]; index: number }>({ ids: [], index: -1 });
  const suppressArtifactNavPushRef = useRef(false);
  const lastSearchParamsKeyRef = useRef(searchParamsKey);
  const syncingStateFromUrlRef = useRef(false);
  const lastValidatedProjectOptionsRef = useRef(projectOptions);

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
  const outlineEntries = useMemo(
    () => (markdownEditorVisible ? parseMarkdownOutline(draft.contentMarkdown || "") : []),
    [draft.contentMarkdown, markdownEditorVisible]
  );

  const {
    editorRef,
    notionEditorRef,
    editSelectionRef,
    liveSelectionRef,
    rememberEditSelection,
    rememberLiveSelection,
    applyDraftInsertion,
    handleEditorKeyDown,
    syncDraftFromNotionEditor,
    handleNotionEditorInput,
    handleNotionEditorPaste,
    handleNotionEditorDrop,
    handleNotionEditorKeyDown
  } = useArtifactsMarkdownEditor({
    draft,
    setDraft,
    notePreviewMode,
    items,
    onImageUploaded: () => loadTreeRef.current(),
  });

  const canSave = useMemo(() => {
    if (!draft.title.trim()) return false;
    if (!draft.path.trim()) return false;
    return true;
  }, [draft.path, draft.title]);

  const isWordFileSelected = useMemo(
    () => draft.kind === "file" && isWordDocument(draft),
    [draft.kind, draft.mimeType, draft.path]
  );
  const canShowWordPreviewPdf = isWordFileSelected && draft.previewPdfStatus === "ready";

  const hasDetailSelection = Boolean(selectedItemId || mode === "create-note");
  const isProjectCardView =
    !hasDetailSelection &&
    !searchParams.has("project") &&
    !searchParams.has("folder") &&
    !searchParams.has("item") &&
    mode !== "create-note" &&
    searchParams.get("view") !== "all";
  const searchTerms = useMemo(
    () => searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [searchQuery]
  );
  const matchingSearchItems = useMemo(() => {
    if (searchTerms.length === 0) return [] as ArtifactItem[];
    return items.filter((item) => {
      if (item.kind === "folder") return false;
      const searchable = `${item.title}\n${item.path}\n${item.tags.join(" ")}`.toLowerCase();
      return searchTerms.every((term) => searchable.includes(term));
    });
  }, [items, searchTerms]);
  const visibleSearchItems = matchingSearchItems.slice(0, 100);
  const hasActiveSearchQuery = searchTerms.length > 0;
  searchShortcutStateRef.current = {
    action: getArtifactsSearchShortcutAction({ isDedicatedApp, hasDetailSelection }),
    searchExpanded
  };

  useEffect(() => {
    document.body.classList.toggle("workbench-artifacts-edit-mode", hasDetailSelection);
    return () => {
      document.body.classList.remove("workbench-artifacts-edit-mode");
    };
  }, [hasDetailSelection]);

  useEffect(() => {
    if (searchExpanded && !hasDetailSelection) {
      searchInputRef.current?.focus();
    }
  }, [hasDetailSelection, searchExpanded]);

  useEffect(() => {
    setArtifactSettingsOpen(false);
  }, [draft.id, mode]);

  const detailProjectOptions = useMemo(() => {
    const map = new Map<string, ProjectOption>();
    for (const option of projectOptions) {
      map.set(option.projectId, option);
    }
    const currentProjectId = draft.projectId.trim();
    if (currentProjectId && !map.has(currentProjectId)) {
      map.set(currentProjectId, {
        projectId: currentProjectId,
        projectName: draft.projectName.trim() || currentProjectId
      });
    }
    return [...map.values()].sort((a, b) =>
      (a.projectName || a.projectId).localeCompare(b.projectName || b.projectId)
    );
  }, [draft.projectId, draft.projectName, projectOptions]);





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

  const contextExportCandidates = useMemo(() => {
    if (!contextMenu) {
      return [] as ArtifactItem[];
    }
    if (selectedItemIds.length > 0) {
      return selectedItemIds
        .map((id) => itemsById.get(id))
        .filter((item): item is ArtifactItem => Boolean(item));
    }
    if (contextMenu.target.type === "item") {
      return [contextMenu.target.item];
    }
    const folderPath = normalizePath(contextMenu.target.folderPath);
    if (!folderPath) {
      return items.filter((item) => item.kind !== "folder");
    }
    return items.filter((item) => item.kind !== "folder" && normalizePath(item.path).startsWith(`${folderPath}/`));
  }, [contextMenu, items, itemsById, selectedItemIds]);

  const contextRenameFolderCandidate = useMemo(() => {
    if (!contextMenu) {
      return null as ArtifactItem | null;
    }
    if (contextMenu.target.type === "item") {
      return contextMenu.target.item.kind === "folder" ? contextMenu.target.item : null;
    }
    if (contextMenu.target.type === "folder") {
      const folderPath = normalizePath(contextMenu.target.folderPath);
      return (
        items.find((item) => item.kind === "folder" && normalizePath(item.path) === folderPath) ?? null
      );
    }
    return null;
  }, [contextMenu, items]);

  const contextPinCandidate = useMemo(() => {
    if (!contextMenu) {
      return null as ArtifactItem | null;
    }
    if (contextMenu.target.type === "item") {
      return contextMenu.target.item;
    }
    if (contextMenu.target.type === "folder") {
      const folderPath = normalizePath(contextMenu.target.folderPath);
      return items.find((item) => item.kind === "folder" && normalizePath(item.path) === folderPath) ?? null;
    }
    return null;
  }, [contextMenu, items]);
  const contextPinCandidateIsPinned = Boolean(
    contextPinCandidate && pinnedArtifacts.some((entry) => entry.itemId === contextPinCandidate.id)
  );

  const contextMoveFolderProjectOptions = useMemo(() => {
    if (!contextRenameFolderCandidate) {
      return [] as ProjectOption[];
    }
    return projectOptions.filter((project) => project.projectId !== contextRenameFolderCandidate.projectId);
  }, [contextRenameFolderCandidate, projectOptions]);

  const moveFolderProjectOptions = useMemo(() => {
    if (!moveFolderProjectState) {
      return [] as ProjectOption[];
    }
    return projectOptions.filter((project) => project.projectId !== moveFolderProjectState.currentProjectId);
  }, [moveFolderProjectState, projectOptions]);

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

  const loadTree = async () => {
    if (!projectsLoaded) {
      return;
    }
    const seq = ++loadTreeSeqRef.current;
    setIsLoading(true);
    try {
      const treeItems = await artifactsApi.tree(projectFilter || undefined);
      if (seq !== loadTreeSeqRef.current) return;
      const visibleItems = treeItems;
      setItems(visibleItems);

      if (selectedItemId && !visibleItems.some((item) => item.id === selectedItemId)) {
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
      if (seq === loadTreeSeqRef.current) setIsLoading(false);
    }
  };
  loadTreeRef.current = loadTree;

  useEffect(() => {
    if (!projectsLoaded || projectOptions === lastValidatedProjectOptionsRef.current) {
      return;
    }
    lastValidatedProjectOptionsRef.current = projectOptions;
    setProjectFilter((prev) =>
      prev && !projectOptions.some((project) => project.projectId === prev) ? "" : prev
    );
  }, [projectOptions, projectsLoaded]);

  useEffect(() => {
    const refreshPinnedArtifacts = () => setPinnedArtifacts(readPinnedArtifacts());
    window.addEventListener(PINNED_ARTIFACTS_CHANGED_EVENT, refreshPinnedArtifacts);
    window.addEventListener("storage", refreshPinnedArtifacts);
    return () => {
      window.removeEventListener(PINNED_ARTIFACTS_CHANGED_EVENT, refreshPinnedArtifacts);
      window.removeEventListener("storage", refreshPinnedArtifacts);
    };
  }, []);

  useEffect(() => {
    const storedSearchParams = new URLSearchParams(searchParams);
    storedSearchParams.delete("new");
    const storedSearchParamsKey = storedSearchParams.toString();
    writeArtifactsLastLocation(`/artifacts${storedSearchParamsKey ? `?${storedSearchParamsKey}` : ""}`);
  }, [searchParams, searchParamsKey]);

  useEffect(() => {
    if (searchParamsKey === lastSearchParamsKeyRef.current) {
      return;
    }

    lastSearchParamsKeyRef.current = searchParamsKey;
    let stateChanged = false;

    if (projectFilter !== requestedProjectId) {
      stateChanged = true;
      setProjectFilter(requestedProjectId);
    }
    if (selectedFolderPath !== requestedFolderPath) {
      stateChanged = true;
      setSelectedFolderPath(requestedFolderPath);
    }
    if (selectedItemId !== requestedItemId) {
      stateChanged = true;
      setSelectedItemId(requestedItemId);
      setSelectedItemIds(requestedItemId ? [requestedItemId] : []);
      setSelectionAnchorId(requestedItemId);
      if (!requestedItemId) {
        setDraft({ ...defaultDraft });
        setMode("view");
      }
    }
    if (requestedItemId && mode !== "view") {
      stateChanged = true;
      setMode("view");
    }

    syncingStateFromUrlRef.current = stateChanged;
  }, [mode, projectFilter, requestedFolderPath, requestedItemId, searchParamsKey, selectedFolderPath, selectedItemId]);

  useEffect(() => {
    if (syncingStateFromUrlRef.current) {
      syncingStateFromUrlRef.current = false;
      return;
    }

    const nextSearchParams = new URLSearchParams(searchParams);
    if (projectFilter) {
      nextSearchParams.set("project", projectFilter);
    } else {
      nextSearchParams.delete("project");
    }

    const normalizedFolderPath = selectedFolderPath ? normalizePath(selectedFolderPath) : "";
    if (normalizedFolderPath) {
      nextSearchParams.set("folder", normalizedFolderPath);
    } else {
      nextSearchParams.delete("folder");
    }

    if (mode !== "create-note" && selectedItemId) {
      nextSearchParams.set("item", selectedItemId);
    } else {
      nextSearchParams.delete("item");
    }

    const nextSearchParamsKey = nextSearchParams.toString();
    if (nextSearchParamsKey === searchParamsKey) {
      lastSearchParamsKeyRef.current = searchParamsKey;
      return;
    }

    lastSearchParamsKeyRef.current = nextSearchParamsKey;
    setSearchParams(nextSearchParams, { replace: true });
  }, [mode, projectFilter, searchParams, searchParamsKey, selectedFolderPath, selectedItemId, setSearchParams]);

  useEffect(() => {
    void loadTree();
  }, [projectFilter, projectsLoaded]);

  useEffect(() => {
    if (!requestedItemId) {
      return;
    }

    const target = items.find((item) => item.id === requestedItemId);
    if (!target) {
      return;
    }

    if (selectedItemId !== requestedItemId) {
      setSelectedItemId(target.id);
      setSelectedItemIds([target.id]);
      setSelectionAnchorId(target.id);
    }
    if (requestedFolderPath === null) {
      const targetFolderPath = parentPath(target.path);
      if (selectedFolderPath !== targetFolderPath) {
        setSelectedFolderPath(targetFolderPath);
      }
    }
  }, [items, requestedFolderPath, requestedItemId, selectedFolderPath, selectedItemId]);

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
        recordRecentArtifact(item);
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
    if (notePreviewMode !== "live") {
      tableSelectionDragRef.current = null;
      setTableSelection(null);
      setTableContextMenu(null);
      applyTableSelectionVisual(notionEditorRef.current, null);
      return;
    }
    applyTableSelectionVisual(notionEditorRef.current, tableSelection);
  }, [draft.contentMarkdown, draft.id, notePreviewMode, tableSelection]);


  useEffect(() => {
    const existingIds = new Set(items.map((item) => item.id));
    setSelectedItemIds((prev) => {
      const next = prev.filter((id) => existingIds.has(id));
      return next.length === prev.length ? prev : next;
    });
    setSelectionAnchorId((prev) => (prev && existingIds.has(prev) ? prev : null));
  }, [items]);

  useEffect(() => {
    if (!selectedItemId) {
      return;
    }

    if (suppressArtifactNavPushRef.current) {
      suppressArtifactNavPushRef.current = false;
      return;
    }

    const history = artifactNavHistoryRef.current;
    const currentId = history.index >= 0 ? history.ids[history.index] : null;
    if (currentId === selectedItemId) {
      return;
    }

    const nextIds = history.ids.slice(0, history.index + 1);
    nextIds.push(selectedItemId);
    artifactNavHistoryRef.current = { ids: nextIds, index: nextIds.length - 1 };
  }, [selectedItemId]);

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      const { canSave: cs, isSaving: is, markdownEditorVisible: mev } = shortcutStateRef.current;
      const key = e.key.toLowerCase();

      if (e.key === "Escape" && searchShortcutStateRef.current.searchExpanded) {
        e.preventDefault();
        setSearchExpanded(false);
        setSearchQuery("");
        return;
      }

      const searchShortcutAction = searchShortcutStateRef.current.action;
      if (
        e.key === "/" &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        searchShortcutAction !== "ignore" &&
        !isTextEditingTarget(e.target)
      ) {
        e.preventDefault();
        if (searchShortcutAction === "focus") {
          searchInputRef.current?.focus();
        } else {
          setSearchExpanded(true);
        }
        return;
      }

      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const isBack = e.key === "ArrowLeft" || e.key === "<" || (e.shiftKey && e.key === ",");
        const isForward = e.key === "ArrowRight" || e.key === ">" || (e.shiftKey && e.key === ".");
        if (isBack || isForward) {
          e.preventDefault();
          e.stopPropagation();
          handleArtifactHistoryNavRef.current(isBack ? -1 : 1);
          return;
        }
      }

      // Ctrl+N: new note
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && key === "n") {
        e.preventDefault();
        if (!is) {
          handleCreateNoteRef.current();
        }
        return;
      }
      // Ctrl+S: save
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && key === "s") {
        e.preventDefault();
        if (cs && !is) void handleSaveRef.current();
        return;
      }
      // Ctrl+Shift+V: toggle edit/live
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && key === "v") {
        if (mev) {
          e.preventDefault();
          setNotePreviewMode((prev) => (prev === "edit" ? "live" : "edit"));
        }
        return;
      }
      // Ctrl+Shift+↑: expand editor or PDF viewer
      if (e.ctrlKey && e.shiftKey && e.key === "ArrowUp") {
        if (mev) {
          e.preventDefault();
          setEditorExpanded(true);
        } else if (shortcutStateRef.current.pdfViewerVisible) {
          e.preventDefault();
          setPdfExpanded(true);
        }
        return;
      }
      // Ctrl+Shift+↓: collapse editor or PDF viewer
      if (e.ctrlKey && e.shiftKey && e.key === "ArrowDown") {
        if (mev) {
          e.preventDefault();
          setEditorExpanded(false);
        } else if (shortcutStateRef.current.pdfViewerVisible) {
          e.preventDefault();
          setPdfExpanded(false);
        }
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []); // stable: reads via refs, sets via stable setState

  useEffect(() => {
    const handlePointerNav = (event: globalThis.MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      handleArtifactHistoryNavRef.current(event.button === 3 ? -1 : 1);
    };

    window.addEventListener("mousedown", handlePointerNav, true);
    window.addEventListener("auxclick", handlePointerNav, true);
    return () => {
      window.removeEventListener("mousedown", handlePointerNav, true);
      window.removeEventListener("auxclick", handlePointerNav, true);
    };
  }, []);

  const updateSelection = (itemId: string, options?: { shiftKey?: boolean; toggleKey?: boolean }) => {
    const shiftKey = Boolean(options?.shiftKey);
    const toggleKey = Boolean(options?.toggleKey);
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
    if (toggleKey) {
      setSelectedItemIds((prev) =>
        prev.includes(itemId)
          ? prev.filter((id) => id !== itemId)
          : [...prev, itemId]
      );
      setSelectionAnchorId(itemId);
      return;
    }
    setSelectedItemIds([itemId]);
    setSelectionAnchorId(itemId);
  };

  const activateItem = (item: ArtifactItem, options?: { suppressHistoryPush?: boolean; preserveSelection?: boolean }) => {
    if (options?.suppressHistoryPush) {
      suppressArtifactNavPushRef.current = true;
    }
    if (!options?.preserveSelection) {
      setSelectedItemIds([item.id]);
      setSelectionAnchorId(item.id);
    }
    setMobileTreeVisible(false);
    setSelectedItemId(item.id);
    setSelectedFolderPath(parentPath(item.path));
    setError(null);
    setTagInput("");
    setMode("view");
  };

  const selectItem = (item: ArtifactItem, options?: { shiftKey?: boolean; toggleKey?: boolean }) => {
    const withShift = Boolean(options?.shiftKey);
    const withToggle = Boolean(options?.toggleKey);
    updateSelection(item.id, { shiftKey: withShift, toggleKey: withToggle });

    // Shift/Ctrl multi-select should not force pane transition.
    if (!withShift && !withToggle) {
      activateItem(item, { preserveSelection: true });
    }
  };

  const navigateArtifactHistory = (direction: -1 | 1) => {
    const history = artifactNavHistoryRef.current;
    if (history.ids.length === 0) {
      return;
    }

    let nextIndex = history.index + direction;
    while (nextIndex >= 0 && nextIndex < history.ids.length) {
      const targetId = history.ids[nextIndex];
      const target = itemsById.get(targetId);
      if (target) {
        artifactNavHistoryRef.current = { ids: history.ids, index: nextIndex };
        activateItem(target, { suppressHistoryPush: true });
        return;
      }
      nextIndex += direction;
    }
  };
  handleArtifactHistoryNavRef.current = navigateArtifactHistory;

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
    setTableContextMenu(null);
    setEditorContextMenu(null);
    setOutlineContextMenu(null);
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      target
    });
  };

  const resolveContextTargetPath = (target: TreeContextTarget): string => {
    if (target.type === "item") {
      return normalizePath(target.item.path);
    }
    return normalizePath(target.folderPath);
  };

  const artifactItemUrl = (itemId: string) => `/artifacts?item=${encodeURIComponent(itemId)}`;

  const openArtifactItemInNewWindow = async (item: ArtifactItem) => {
    const url = artifactItemUrl(item.id);
    if (isTauriNativeRuntime()) {
      try {
        await window.__TAURI_INTERNALS__?.invoke("open_app_window", { url });
        return;
      } catch {
        // The native command lands in the next wave; browser fallback keeps the action useful.
      }
    }
    window.open(url, "_blank", "noopener");
  };

  const copyTextToClipboard = async (value: string) => {
    const text = value || "/";
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
    } catch (copyError) {
      const message = copyError instanceof Error ? copyError.message : "Failed to copy path.";
      setError(message);
    }
  };

  const resolveTableCellFromTarget = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) {
      return null;
    }
    const cell = target.closest("th,td");
    if (!(cell instanceof HTMLTableCellElement)) {
      return null;
    }
    const table = cell.closest("table");
    if (!(table instanceof HTMLTableElement)) {
      return null;
    }
    const block = table.closest("[data-md-kind='table']");
    if (!(block instanceof HTMLElement)) {
      return null;
    }
    normalizeNotionBlockElement(block);
    const tableId = block.dataset.tableId;
    if (!tableId) {
      return null;
    }
    const rowElement = cell.parentElement;
    if (!(rowElement instanceof HTMLTableRowElement)) {
      return null;
    }
    const rows = getNotionTableRows(table);
    const rowIndex = rows.indexOf(rowElement);
    if (rowIndex < 0) {
      return null;
    }
    const colIndex = Array.from(rowElement.cells).indexOf(cell);
    if (colIndex < 0) {
      return null;
    }
    return {
      block,
      table,
      tableId,
      rowIndex,
      colIndex
    };
  };

  const setAndApplyTableSelection = (selection: TableSelectionState | null) => {
    setTableSelection(selection);
    applyTableSelectionVisual(notionEditorRef.current, selection);
  };

  const applySelectedTableOperation = (
    operation:
      | "insert-row-above"
      | "insert-row-below"
      | "insert-column-left"
      | "insert-column-right"
      | "delete-rows"
      | "delete-columns"
  ) => {
    const activeSelection = tableContextMenu?.selection ?? tableSelection;
    const correctedSelection = applyTableOperation(notionEditorRef.current, activeSelection, operation);
    if (!correctedSelection) {
      return;
    }
    setAndApplyTableSelection(correctedSelection);
    syncDraftFromNotionEditor();
  };

  const handleNotionEditorMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    const resolved = resolveTableCellFromTarget(event.target);
    if (!resolved) {
      tableSelectionDragRef.current = null;
      setAndApplyTableSelection(null);
      setTableContextMenu(null);
      return;
    }
    const selection: TableSelectionState = {
      tableId: resolved.tableId,
      start: { row: resolved.rowIndex, col: resolved.colIndex },
      end: { row: resolved.rowIndex, col: resolved.colIndex }
    };
    tableSelectionDragRef.current = selection;
    setAndApplyTableSelection(selection);
    setTableContextMenu(null);
  };

  const handleNotionEditorMouseOver = (event: MouseEvent<HTMLDivElement>) => {
    if (!tableSelectionDragRef.current || (event.buttons & 1) !== 1) {
      return;
    }
    const resolved = resolveTableCellFromTarget(event.target);
    if (!resolved || resolved.tableId !== tableSelectionDragRef.current.tableId) {
      return;
    }
    const nextSelection: TableSelectionState = {
      ...tableSelectionDragRef.current,
      end: { row: resolved.rowIndex, col: resolved.colIndex }
    };
    tableSelectionDragRef.current = nextSelection;
    setAndApplyTableSelection(nextSelection);
  };

  const handleNotionEditorMouseUp = () => {
    tableSelectionDragRef.current = null;
  };

  const handleNotionEditorContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const resolved = resolveTableCellFromTarget(event.target);
    if (!resolved) {
      rememberLiveSelection();
      setAndApplyTableSelection(null);
      openEditorContextMenu(event, "live");
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const clicked = {
      tableId: resolved.tableId,
      start: { row: resolved.rowIndex, col: resolved.colIndex },
      end: { row: resolved.rowIndex, col: resolved.colIndex }
    };
    const activeSelection =
      tableSelection && tableSelection.tableId === resolved.tableId &&
        isCellInTableSelection(tableSelection, resolved.rowIndex, resolved.colIndex)
        ? tableSelection
        : clicked;
    setAndApplyTableSelection(activeSelection);
    setEditorContextMenu(null);
    setContextMenu(null);
    setTableContextMenu({
      x: event.clientX,
      y: event.clientY,
      selection: activeSelection
    });
  };

  const handleInsertTableFromEditorContext = () => {
    if (!editorContextMenu) {
      return;
    }

    const template = "| Column 1 | Column 2 |\n| --- | --- |\n|  |  |";
    if (editorContextMenu.mode === "edit") {
      const text = draft.contentMarkdown;
      const fallbackPos = editorRef.current?.selectionStart ?? text.length;
      const start = editSelectionRef.current?.start ?? fallbackPos;
      const end = editSelectionRef.current?.end ?? fallbackPos;
      const prefix = start > 0 && text[start - 1] !== "\n" ? "\n" : "";
      const suffix = end < text.length && text[end] !== "\n" ? "\n" : "";
      const insertion = `${prefix}${template}${suffix}`;
      applyDraftInsertion(insertion);
      setEditorContextMenu(null);
      return;
    }

    const editor = notionEditorRef.current;
    if (!editor) {
      setEditorContextMenu(null);
      return;
    }

    const block = document.createElement("div");
    block.dataset.mdKind = "table";
    block.dataset.tableId = `table-${Math.floor(Math.random() * 1_000_000_000)}`;
    normalizeNotionBlockElement(block);

    const table = block.querySelector("table");
    if (table instanceof HTMLTableElement) {
      const headerRow = table.tHead?.rows[0];
      if (headerRow) {
        if (headerRow.cells[0]) headerRow.cells[0].textContent = "Column 1";
        if (headerRow.cells[1]) headerRow.cells[1].textContent = "Column 2";
      }
    }

    let anchorBlock: HTMLElement | null = null;
    if (liveSelectionRef.current) {
      anchorBlock = findNotionBlock(editor, liveSelectionRef.current.startContainer);
    }
    if (!anchorBlock) {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        anchorBlock = findNotionBlock(editor, selection.getRangeAt(0).startContainer);
      }
    }

    if (anchorBlock && anchorBlock.parentElement === editor) {
      if (anchorBlock.nextSibling) {
        editor.insertBefore(block, anchorBlock.nextSibling);
      } else {
        editor.appendChild(block);
      }
    } else {
      editor.appendChild(block);
    }

    const firstCell = block.querySelector("tbody td, thead th");
    if (firstCell instanceof HTMLTableCellElement) {
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(firstCell);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }

    if (block.dataset.tableId) {
      setAndApplyTableSelection({
        tableId: block.dataset.tableId,
        start: { row: 1, col: 0 },
        end: { row: 1, col: 0 }
      });
    }
    syncDraftFromNotionEditor();
    setEditorContextMenu(null);
  };

  const handleOpenInsertLinkDialog = () => {
    if (!editorContextMenu) {
      return;
    }
    if (editorContextMenu.mode === "edit") {
      const textarea = editorRef.current;
      if (textarea) {
        rememberEditSelection(textarea);
      }
    } else {
      rememberLiveSelection();
    }
    setInsertLinkState({ mode: editorContextMenu.mode });
    setEditorContextMenu(null);
  };

  const handleInsertLinkConfirm = (rawUrl: string) => {
    const href = rawUrl.trim();
    if (!href || !insertLinkState) {
      return;
    }

    if (insertLinkState.mode === "edit") {
      const text = draft.contentMarkdown;
      const fallbackPos = editorRef.current?.selectionStart ?? text.length;
      const start = editSelectionRef.current?.start ?? fallbackPos;
      const end = editSelectionRef.current?.end ?? fallbackPos;
      const selectedText = (editSelectionRef.current?.text ?? text.slice(start, end)).trim();
      const label = selectedText || href;
      const insertion = `[${label}](${href})`;
      applyDraftInsertion(insertion);
      setInsertLinkState(null);
      return;
    }

    const editor = notionEditorRef.current;
    if (!editor) {
      setInsertLinkState(null);
      return;
    }

    editor.focus();
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      if (liveSelectionRef.current) {
        selection.addRange(liveSelectionRef.current.cloneRange());
      }
    }

    const activeSelection = window.getSelection();
    if (!activeSelection || activeSelection.rangeCount === 0) {
      const block = (editor.lastElementChild as HTMLElement | null) ?? createNotionBlock("paragraph");
      if (!editor.lastElementChild) {
        editor.appendChild(block);
      }
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.textContent = href;
      block.appendChild(anchor);
      syncDraftFromNotionEditor();
      setInsertLinkState(null);
      return;
    }

    const range = activeSelection.getRangeAt(0);
    const selectedText = activeSelection.toString().trim();
    const label = selectedText || href;
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.textContent = label;
    range.deleteContents();
    range.insertNode(anchor);

    const caret = document.createRange();
    caret.setStartAfter(anchor);
    caret.collapse(true);
    activeSelection.removeAllRanges();
    activeSelection.addRange(caret);

    syncDraftFromNotionEditor();
    setInsertLinkState(null);
  };

  const handleNotionEditorClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey)) {
      return;
    }
    if (!(event.target instanceof HTMLElement)) {
      return;
    }
    const anchor = event.target.closest("a");
    if (!(anchor instanceof HTMLAnchorElement)) {
      return;
    }

    const rawHref = anchor.getAttribute("href")?.trim() ?? "";
    if (!rawHref) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (isExternalUrl(rawHref)) {
      window.open(rawHref, "_blank", "noopener,noreferrer");
      return;
    }

    const href = rawHref.split("#")[0].trim();
    if (!href) {
      return;
    }

    const resolvedPath = normalizePath(resolveMarkdownRef(draft.path, href));
    const target = items.find((item) => normalizePath(item.path) === resolvedPath);
    if (target) {
      selectItem(target);
      return;
    }

    setError(`Link target not found: ${rawHref}`);
  };

  const handleDraftProjectChange = (nextProjectId: string) => {
    const normalizedProjectId = nextProjectId.trim();
    if (!normalizedProjectId) {
      return;
    }
    const selected = detailProjectOptions.find((option) => option.projectId === normalizedProjectId);
    setDraft((prev) => ({
      ...prev,
      projectId: normalizedProjectId,
      projectName: selected?.projectName ?? normalizedProjectId
    }));
  };

  const returnToDirectoryView = () => {
    setMobileTreeVisible(true);
    setSelectedItemId(null);
    setSelectedItemIds([]);
    setSelectionAnchorId(null);
    setMode("view");
    setEditorExpanded(false);
    setPdfExpanded(false);
  };

  const closeSearch = () => {
    setSearchExpanded(false);
    setSearchQuery("");
  };

  const handleDirectoryHome = () => {
    setSelectedFolderPath("");
    if (projectFilter) {
      return;
    }

    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete("folder");
    nextSearchParams.delete("view");
    const nextSearchParamsKey = nextSearchParams.toString();
    if (nextSearchParamsKey === searchParamsKey) {
      return;
    }
    lastSearchParamsKeyRef.current = nextSearchParamsKey;
    setSearchParams(nextSearchParams, { replace: true });
  };

  const showAllProjectsDirectory = () => {
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.set("view", "all");
    const nextSearchParamsKey = nextSearchParams.toString();
    lastSearchParamsKeyRef.current = nextSearchParamsKey;
    setSearchParams(nextSearchParams, { replace: true });
  };

  const startCreateNote = (targetProject: ProjectOption, targetFolderPath: string) => {
    const newPath = joinPath(targetFolderPath, "new-note.md") || "new-note.md";
    setMobileTreeVisible(false);
    setMode("create-note");
    setSelectedItemId(null);
    setSelectedItemIds([]);
    setSelectionAnchorId(null);
    setSelectedFolderPath(targetFolderPath);
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

  const handleStartCreateNote = () => {
    startCreateNote(resolveProjectFromFilter(), currentFolderPath);
  };

  useEffect(() => {
    if (requestedCreateMode !== "note" || !projectsLoaded) {
      return;
    }

    const targetProject = requestedProjectId
      ? projectOptions.find((project) => project.projectId === requestedProjectId) ?? { projectId: requestedProjectId }
      : defaultProject ?? projectOptions[0] ?? { projectId: "default", projectName: "default" };
    startCreateNote(targetProject, "");

    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete("new");
    nextSearchParams.delete("folder");
    nextSearchParams.delete("item");
    lastSearchParamsKeyRef.current = nextSearchParams.toString();
    setSearchParams(nextSearchParams, { replace: true });
  }, [defaultProject, projectOptions, projectsLoaded, requestedCreateMode, requestedProjectId, searchParams, setSearchParams]);

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

  const handleUploadFiles = async (
    files: FileList | null,
    targetPath?: string,
    explicitProject?: ProjectOption
  ) => {
    if (!files || files.length === 0) return;

    const activeProject = explicitProject ?? resolveProjectFromFilter();
    const uploadDirectoryPath = normalizePath(targetPath ?? currentFolderPath);
    const projectFilterChanged = projectFilter !== activeProject.projectId;

    setIsSaving(true);
    setError(null);

    try {
      let lastUploadedId: string | null = null;
      for (const file of Array.from(files)) {
        const uploaded = await artifactsApi.uploadFile({
          projectId: activeProject.projectId,
          projectName: activeProject.projectName,
          directoryPath: uploadDirectoryPath || undefined,
          file
        });
        lastUploadedId = uploaded.id;
      }

      setProjectFilter(activeProject.projectId);
      setSelectedFolderPath(uploadDirectoryPath);
      if (!projectFilterChanged) {
        await loadTree();
      }
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

  const handleEditorDrop = async (event: DragEvent<HTMLTextAreaElement>) => {
    const files = event.dataTransfer.files;
    if (!files || files.length === 0) return;
    event.preventDefault();

    const insertPos = event.currentTarget.selectionStart ?? draft.contentMarkdown.length;
    const uploadDir = parentPath(draft.path) || undefined;

    setIsSaving(true);
    setError(null);
    let insertedText = "";

    try {
      for (const file of Array.from(files)) {
        const uploaded = await artifactsApi.uploadFile({
          projectId: draft.projectId,
          projectName: draft.projectName || undefined,
          directoryPath: uploadDir,
          file
        });
        const rel = relativeArtifactPath(draft.path, uploaded.path);
        const isImage = /^image\//i.test(file.type) || /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(file.name);
        insertedText += isImage ? `![${file.name}](${rel})\n` : `[${file.name}](${rel})\n`;
      }
      await loadTree();
      setDraft((prev) => ({
        ...prev,
        contentMarkdown:
          prev.contentMarkdown.slice(0, insertPos) + insertedText + prev.contentMarkdown.slice(insertPos)
      }));
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Upload failed.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleEditorPaste = async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    // In WebView2 (Windows/Tauri), clipboardData.files and .items are often empty for screenshots.
    // navigator.clipboard.read() is the reliable path for WebView2 image paste.
    // Capture cursor position now before any async suspension.
    const insertPos = event.currentTarget.selectionStart ?? draft.contentMarkdown.length;

    // 1. Try synchronous DataTransfer sources (works in standard browsers).
    let files: File[] = Array.from(event.clipboardData.files).filter((f) => /^image\//i.test(f.type));
    if (files.length === 0) {
      files = Array.from(event.clipboardData.items)
        .filter((item) => item.kind === "file" && /^image\//i.test(item.type))
        .map((item) => item.getAsFile())
        .filter((f): f is File => f !== null);
    }

    // 2. Fallback: Clipboard API (needed in WebView2 where DataTransfer images are absent).
    //    Called inside the paste handler (user gesture) so permission is granted automatically.
    if (files.length === 0 && typeof navigator.clipboard?.read === "function") {
      try {
        const clipItems = await navigator.clipboard.read();
        for (const clipItem of clipItems) {
          for (const type of clipItem.types) {
            if (/^image\//i.test(type)) {
              const blob = await clipItem.getType(type);
              const ext = type.split("/")[1] ?? "png";
              files.push(new File([blob], `paste-${Date.now()}.${ext}`, { type }));
            }
          }
        }
      } catch {
        // Permission denied or Clipboard API unavailable — fall through.
      }
    }

    if (files.length === 0) return;
    event.preventDefault();

    const uploadDir = parentPath(draft.path) || undefined;

    setIsSaving(true);
    setError(null);
    let insertedText = "";

    try {
      for (const file of files) {
        // Give pasted images a timestamped filename if they lack one
        const name = file.name && file.name !== "image.png" ? file.name
          : `paste-${Date.now()}.${file.type.split("/")[1] ?? "png"}`;
        const namedFile = new File([file], name, { type: file.type });
        const uploaded = await artifactsApi.uploadFile({
          projectId: draft.projectId,
          projectName: draft.projectName || undefined,
          directoryPath: uploadDir,
          file: namedFile
        });
        const rel = relativeArtifactPath(draft.path, uploaded.path);
        insertedText += `![${name}](${rel})\n`;
      }
      await loadTree();
      setDraft((prev) => ({
        ...prev,
        contentMarkdown:
          prev.contentMarkdown.slice(0, insertPos) + insertedText + prev.contentMarkdown.slice(insertPos)
      }));
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Upload failed.");
    } finally {
      setIsSaving(false);
    }
  };

  const openEditorContextMenu = (event: MouseEvent<HTMLElement>, mode: "edit" | "live") => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu(null);
    setTableContextMenu(null);
    setEditorContextMenu({
      x: event.clientX,
      y: event.clientY,
      mode
    });
  };

  const handleEditEditorContextMenu = (event: MouseEvent<HTMLTextAreaElement>) => {
    rememberEditSelection(event.currentTarget);
    openEditorContextMenu(event, "edit");
  };

  const handleSave = async () => {
    if (!canSave) {
      setError("Title and path are required.");
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
          projectId: activeProject.projectId,
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

  // Keep refs in sync for stable keyboard shortcut handler
  handleCreateNoteRef.current = handleStartCreateNote;
  handleSaveRef.current = handleSave;
  const pdfViewerVisible = draft.kind === "file" && (isPdf(draft) || canShowWordPreviewPdf);
  shortcutStateRef.current = { canSave, isSaving, markdownEditorVisible, pdfViewerVisible };

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
      const blob = await artifactsApi.downloadFile(draft.id, false);
      const filename = draft.title || "artifact";
      if (isTauriNativeRuntime()) {
        await saveFileWithDialog(blob, filename);
      } else {
        triggerBlobDownload(blob, filename);
      }
    } catch {
      // Global notification already shown.
    }
  };

  const startRenameFolder = (folderItem: ArtifactItem) => {
    setRenameFolderState({
      itemId: folderItem.id,
      currentPath: normalizePath(folderItem.path),
      currentName: leafPath(folderItem.path) || folderItem.title || "folder"
    });
  };

  const startMoveFolderToProject = (folderItem: ArtifactItem) => {
    const targetProject = projectOptions.find((project) => project.projectId !== folderItem.projectId);
    if (!targetProject) {
      setError("No available project to move this folder to.");
      return;
    }
    setMoveFolderProjectState({
      itemId: folderItem.id,
      currentPath: normalizePath(folderItem.path),
      currentProjectId: folderItem.projectId,
      targetProjectId: targetProject.projectId
    });
  };

  const handleMoveFolderProjectConfirm = async () => {
    if (!moveFolderProjectState) {
      return;
    }

    const targetProject = projectOptions.find(
      (project) => project.projectId === moveFolderProjectState.targetProjectId
    );
    if (!targetProject) {
      setError("Move target project is not available.");
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      const updated = await artifactsApi.updateItem(moveFolderProjectState.itemId, {
        projectId: targetProject.projectId,
        projectName: targetProject.projectName
      });

      setMoveFolderProjectState(null);
      setSelectedFolderPath(updated.path);
      if (projectFilter && projectFilter !== targetProject.projectId) {
        setProjectFilter(targetProject.projectId);
      } else {
        await loadTree();
      }
      if (draft.id) {
        try {
          const refreshed = await artifactsApi.getItem(draft.id);
          setDraft(itemToDraft(refreshed));
        } catch {
          // ignore: global error notification already handled
        }
      }
    } catch (moveError) {
      const message = moveError instanceof Error ? moveError.message : "Unable to move folder.";
      setError(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleRenameFolderConfirm = async (nextNameRaw: string) => {
    if (!renameFolderState) {
      return;
    }

    const nextName = nextNameRaw.trim();
    if (!nextName) {
      return;
    }

    const currentPath = normalizePath(renameFolderState.currentPath);
    const nextPath = normalizePath(joinPath(parentPath(currentPath), nextName));
    if (!nextPath || nextPath === currentPath) {
      setRenameFolderState(null);
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      await artifactsApi.updateItem(renameFolderState.itemId, {
        path: nextPath,
        title: nextName
      });

      const oldPrefix = currentPath ? `${currentPath}/` : "";
      setSelectedFolderPath((prev) => {
        if (prev === null) return prev;
        const normalizedPrev = normalizePath(prev);
        if (normalizedPrev === currentPath) {
          return nextPath;
        }
        if (oldPrefix && normalizedPrev.startsWith(oldPrefix)) {
          const suffix = normalizedPrev.slice(oldPrefix.length);
          return normalizePath(joinPath(nextPath, suffix));
        }
        return prev;
      });

      setRenameFolderState(null);
      await loadTree();
      if (draft.id) {
        try {
          const refreshed = await artifactsApi.getItem(draft.id);
          setDraft(itemToDraft(refreshed));
        } catch {
          // ignore: global error notification already handled
        }
      }
    } catch (renameError) {
      const message = renameError instanceof Error ? renameError.message : "Unable to rename folder.";
      setError(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleOpenInWord = async () => {
    if (!draft.id || draft.kind !== "file" || !isWordDocument(draft)) return;

    try {
      const blob = await artifactsApi.downloadFile(draft.id, false);
      const filename = leafPath(draft.path) || draft.title || "document.docx";
      await openFileWithDefaultApp(blob, filename);
    } catch {
      // Global notification already shown.
    }
  };

  const downloadExportBlobForItem = async (item: ArtifactItem): Promise<Blob> => {
    try {
      return await artifactsApi.downloadFile(item.id, true);
    } catch {
      if (item.kind === "note") {
        const fresh = await artifactsApi.getItem(item.id);
        const content = fresh.contentMarkdown ?? item.contentMarkdown ?? "";
        return new Blob([content], { type: "text/markdown;charset=utf-8" });
      }
      throw new Error(`Failed to export "${item.title}".`);
    }
  };

  const buildContextExportPlan = () => {
    if (!contextMenu) {
      return null;
    }

    const roots =
      selectedItemIds.length > 0
        ? selectedItemIds.map((id) => itemsById.get(id)).filter((item): item is ArtifactItem => Boolean(item))
        : contextMenu.target.type === "item"
          ? [contextMenu.target.item]
          : [];

    if (roots.length > 0) {
      const folderRoots = roots.filter((item) => item.kind === "folder");
      const directFiles = roots.filter((item) => item.kind !== "folder");
      const expandedFiles = folderRoots.flatMap((folder) => {
        const normalizedFolderPath = normalizePath(folder.path);
        return items.filter(
          (item) => item.kind !== "folder" && normalizePath(item.path).startsWith(`${normalizedFolderPath}/`)
        );
      });
      const fileMap = new Map<string, ArtifactItem>();
      [...directFiles, ...expandedFiles].forEach((item) => {
        fileMap.set(item.id, item);
      });
      const files = [...fileMap.values()];
      const forceZip = roots.length > 1 || folderRoots.length > 0;
      const zipName =
        roots.length === 1 && roots[0].kind === "folder"
          ? `${sanitizeExportFilename(leafPath(roots[0].path) || "root")}.zip`
          : `artifacts-export-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
      return {
        files,
        forceZip,
        zipName,
        baseFolderPath: roots.length === 1 && roots[0].kind === "folder" ? normalizePath(roots[0].path) : ""
      };
    }

    if (contextMenu.target.type === "item") {
      return {
        files: [contextMenu.target.item],
        forceZip: false,
        zipName: `${sanitizeExportFilename(ensureItemExportFilename(contextMenu.target.item))}.zip`,
        baseFolderPath: ""
      };
    }

    const targetFolderPath = normalizePath(contextMenu.target.folderPath);
    const files = !targetFolderPath
      ? items.filter((item) => item.kind !== "folder")
      : items.filter((item) => item.kind !== "folder" && normalizePath(item.path).startsWith(`${targetFolderPath}/`));
    return {
      files,
      forceZip: true,
      zipName: `${sanitizeExportFilename(leafPath(targetFolderPath) || "root")}.zip`,
      baseFolderPath: targetFolderPath
    };
  };

  const handleContextExport = async () => {
    const plan = buildContextExportPlan();
    if (!plan || plan.files.length === 0) {
      setError("No exportable files found.");
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      if (!plan.forceZip && plan.files.length === 1) {
        const item = plan.files[0];
        const blob = await downloadExportBlobForItem(item);
        triggerBlobDownload(blob, ensureItemExportFilename(item));
        return;
      }

      const zip = new JSZip();
      for (const item of plan.files) {
        const blob = await downloadExportBlobForItem(item);
        const normalizedPath = normalizePath(item.path);
        const relativePath =
          plan.baseFolderPath && normalizedPath.startsWith(`${plan.baseFolderPath}/`)
            ? normalizedPath.slice(plan.baseFolderPath.length + 1)
            : normalizedPath || ensureItemExportFilename(item);
        zip.file(relativePath || ensureItemExportFilename(item), blob);
      }
      const zipBlob = await zip.generateAsync({ type: "blob" });
      triggerBlobDownload(zipBlob, plan.zipName);
    } catch (exportError) {
      const message = exportError instanceof Error ? exportError.message : "Export failed.";
      setError(message);
    } finally {
      setIsSaving(false);
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
    const targetFolderPath = normalizePath(currentFolderPath);
    if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      setDropTargetPath(null);
      void handleUploadFiles(event.dataTransfer.files, targetFolderPath);
      return;
    }
    event.preventDefault();
    const dragItem = resolveDraggedItemFromEvent(event);
    if (!dragItem) return;
    if (isInvalidFolderMove(dragItem, targetFolderPath)) return;
    setDropTargetPath(null);
    void moveItemToFolder(dragItem, targetFolderPath);
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
    const hasFiles = event.dataTransfer.types.includes("Files");
    event.dataTransfer.dropEffect = hasFiles ? "copy" : "move";
    setDropTargetPath(normalizePath(currentFolderPath));
  };

  const handleProjectCardDropFiles = (projectId: string, files: FileList) => {
    const targetProject = projectOptions.find((project) => project.projectId === projectId) ?? { projectId };
    void handleUploadFiles(files, "", targetProject);
  };

  const executeContextAction = (action: () => Promise<void> | void) => {
    setContextMenu(null);
    setTableContextMenu(null);
    setEditorContextMenu(null);
    setOutlineContextMenu(null);
    void action();
  };

  const executeTableContextAction = (action: () => void) => {
    setTableContextMenu(null);
    setEditorContextMenu(null);
    setOutlineContextMenu(null);
    void action();
  };

  const executeOutlineContextAction = (action: () => void) => {
    setOutlineContextMenu(null);
    void action();
  };

  const tableMenuContext = tableContextMenu ? getSelectedTableContext(notionEditorRef.current, tableContextMenu.selection) : null;
  const canDeleteTableRows = Boolean(tableMenuContext && tableMenuContext.bounds.endRow >= 1);
  const canDeleteTableColumns = Boolean(
    tableMenuContext &&
      tableMenuContext.colCount > (tableMenuContext.bounds.endCol - tableMenuContext.bounds.startCol + 1)
  );

  const handleOutlineSelect = (entry: MarkdownOutlineItem) => {
    setMobileTreeVisible(false);
    if (notePreviewMode === "live" && notionEditorRef.current) {
      const headings = notionEditorRef.current.querySelectorAll<HTMLElement>(".va-notion-heading");
      const target = headings.item(entry.headingIndex);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.focus({ preventScroll: true });
        return;
      }
    }

    const textarea = editorRef.current;
    if (!textarea) {
      return;
    }
    const nextPos = Math.max(0, Math.min(entry.startOffset, textarea.value.length));
    textarea.focus();
    textarea.setSelectionRange(nextPos, nextPos);
  };

  const handleOutlineMove = (draggedId: string, targetId: string, targetLevel: number) => {
    if (!markdownEditorVisible) {
      return;
    }

    const nextMarkdown = moveOutlineSection({
      markdown: draft.contentMarkdown,
      entries: outlineEntries,
      draggedId,
      targetId,
      targetLevel
    });
    if (nextMarkdown === draft.contentMarkdown) {
      return;
    }
    setDraft((prev) => ({ ...prev, contentMarkdown: nextMarkdown }));
  };

  const handleOpenOutlineContextMenu = (event: MouseEvent<HTMLButtonElement>, entry: MarkdownOutlineItem) => {
    setContextMenu(null);
    setTableContextMenu(null);
    setEditorContextMenu(null);
    setOutlineContextMenu({
      x: event.clientX,
      y: event.clientY,
      entry
    });
  };

  const insertFromOutlineContext = (kind: "text" | "heading" | "bullet") => {
    if (!outlineContextMenu) {
      return;
    }

    const result = insertBelowOutlineEntry({
      markdown: draft.contentMarkdown,
      entries: outlineEntries,
      entryId: outlineContextMenu.entry.id,
      kind
    });

    if (result.markdown === draft.contentMarkdown) {
      return;
    }

    setDraft((prev) => ({ ...prev, contentMarkdown: result.markdown }));
    if (notePreviewMode === "edit") {
      window.requestAnimationFrame(() => {
        const textarea = editorRef.current;
        if (!textarea) return;
        const cursor = Math.max(0, Math.min(result.cursorOffset, textarea.value.length));
        textarea.focus();
        textarea.setSelectionRange(cursor, cursor);
      });
    }
  };

  const artifactsSection = (
    <section
      className="va-artifacts-page"
      onClick={() => {
        setContextMenu(null);
        setTableContextMenu(null);
        setEditorContextMenu(null);
        setOutlineContextMenu(null);
      }}
    >
      <section
        className={[
          "va-shell",
          hasDetailSelection ? "edit-mode" : "directory-mode",
          editSidebarCollapsed ? "edit-sidebar-collapsed" : ""
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {!hasDetailSelection ? (
          <header className="va-toolbar">
            <div className="va-toolbar-left">
              <button
                type="button"
                className="va-home-icon-btn"
                onClick={handleDirectoryHome}
                aria-label="Home"
                title="Root Directory"
              >
                <span className="va-home-icon" aria-hidden="true"><IcoHome /></span>
              </button>
              <strong>{currentFolderPath || (isProjectCardView ? "Projects" : "root")}</strong>
            </div>

            <div className="va-toolbar-right">
              {!isDedicatedApp ? (
                <>
                  {searchExpanded ? (
                    <div className="va-search-box">
                      <span className="va-search-box-icon" aria-hidden="true"><IcoSearch /></span>
                      <input
                        ref={searchInputRef}
                        type="search"
                        value={searchQuery}
                        onChange={(event) => setSearchQuery(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.preventDefault();
                            event.stopPropagation();
                            closeSearch();
                          }
                        }}
                        aria-label="Search artifacts"
                        placeholder="Search artifacts"
                        autoFocus
                      />
                      <button type="button" onClick={closeSearch} aria-label="Close search" title="Close Search">
                        <IcoClose />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="va-toolbar-icon-btn"
                      onClick={() => setSearchExpanded(true)}
                      aria-label="Search artifacts"
                      title="Search (/)"
                    >
                      <IcoSearch />
                    </button>
                  )}
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
                </>
              ) : null}

              {!isProjectCardView ? (
                <>
                  <button type="button" className="va-action-btn" onClick={handleUploadClick} disabled={isSaving}>
                    <IcoUpload /> Upload
                  </button>
                  <button type="button" className="va-action-btn" onClick={() => void handleCreateFolder()} disabled={isSaving}>
                    <IcoFolder /> New Folder
                  </button>
                </>
              ) : null}
              <button type="button" className="va-action-btn primary" onClick={handleStartCreateNote} disabled={isSaving}>
                + New Note
              </button>
              {!isProjectCardView ? (
                <div className="va-view-toggle" aria-label="Directory view mode">
                  <button
                    type="button"
                    className={directoryViewMode === "list" ? "active" : undefined}
                    onClick={() => setDirectoryViewMode("list")}
                    aria-label="List view"
                    title="List view"
                  >
                    <IcoListView />
                  </button>
                  <button
                    type="button"
                    className={directoryViewMode === "tile" ? "active" : undefined}
                    onClick={() => setDirectoryViewMode("tile")}
                    aria-label="Tile view"
                    title="Tile view"
                  >
                    <IcoTileView />
                  </button>
                </div>
              ) : null}
            </div>
          </header>
        ) : null}

        <div className="va-shell-content">
          {error ? <p className="va-inline-error">{error}</p> : null}

          {!hasDetailSelection ? (
            <main
            className={[
              "va-directory-pane",
              !isProjectCardView &&
              !hasActiveSearchQuery &&
              dropTargetPath === normalizePath(currentFolderPath)
                ? "drop-target-root"
                : ""
            ]
              .filter(Boolean)
              .join(" ")}
            onDragEnter={!isProjectCardView && !hasActiveSearchQuery ? handleRootDragOver : undefined}
            onDragOver={!isProjectCardView && !hasActiveSearchQuery ? handleRootDragOver : undefined}
            onDrop={!isProjectCardView && !hasActiveSearchQuery ? handleRootDrop : undefined}
          >
            {isLoading ? (
              <div className="va-empty">Loading...</div>
            ) : hasActiveSearchQuery ? (
              <div className="va-search-results">
                <div className="va-search-results-header">
                  <strong>Search results</strong>
                  <span>{matchingSearchItems.length} matches</span>
                </div>
                {visibleSearchItems.length > 0 ? (
                  <ul>
                    {visibleSearchItems.map((item) => (
                      <li key={item.id}>
                        <button type="button" className="va-search-result" onClick={() => selectItem(item)}>
                          <span className="va-search-result-icon" aria-hidden="true"><IcoFile /></span>
                          <span className="va-search-result-main">
                            <strong>{item.title}</strong>
                            <small>{item.path}</small>
                          </span>
                          <span className="va-search-result-project">
                            {normalizeProjectName(item.projectId, item.projectName)}
                          </span>
                          <span className="va-search-result-updated">{formatDateTime(item.updatedAt)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="va-empty">No matching artifacts.</div>
                )}
                {matchingSearchItems.length > visibleSearchItems.length ? (
                  <p className="va-search-results-more">
                    {matchingSearchItems.length - visibleSearchItems.length} more matches
                  </p>
                ) : null}
              </div>
            ) : isProjectCardView ? (
              <ProjectCardGrid
                projectOptions={projectOptions}
                items={items}
                onSelectAll={showAllProjectsDirectory}
                onSelectProject={(projectId) => setProjectFilter(projectId)}
                onDropFiles={handleProjectCardDropFiles}
              />
            ) : (
              <DirectoryBrowser
                currentFolderNode={currentFolderNode}
                currentFolderPath={currentFolderPath}
                viewMode={directoryViewMode}
                selectedFolderPath={selectedFolderPath}
                selectedItemIdSet={selectedItemIdSet}
                dropTargetPath={dropTargetPath}
                draggingItemId={draggingItemId}
                setSelectedFolderPath={(path) => setSelectedFolderPath(path)}
                updateSelection={updateSelection}
                openContextMenu={openContextMenu}
                handleDragStart={handleDragStart}
                handleDragEnd={handleDragEnd}
                handleFolderDragOver={handleFolderDragOver}
                handleFolderDrop={handleFolderDrop}
                selectItem={selectItem}
              />
            )}
            {!isProjectCardView && !hasActiveSearchQuery ? <footer className="va-tree-foot">
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
            </footer> : null}
            </main>
          ) : (
            <div className="va-edit-layout">
            {!editSidebarCollapsed ? (
              <aside className="va-edit-sidebar">
                <button
                  type="button"
                  className="va-edit-sidebar-close"
                  onClick={() => setEditSidebarCollapsed(true)}
                  aria-label="Collapse sidebar"
                  title="Collapse Sidebar"
                >
                  <IcoChevronLeft />
                </button>
                <MarkdownOutlinePanel
                  collapsed={outlineCollapsed}
                  markdownVisible={markdownEditorVisible}
                  entries={outlineEntries}
                  bodyHeight={outlineBodyHeight}
                  onToggleCollapsed={() => setOutlineCollapsed((prev) => !prev)}
                  onBodyHeightChange={setOutlineBodyHeight}
                  onSelectEntry={handleOutlineSelect}
                  onMoveEntry={handleOutlineMove}
                  onOpenContextMenu={handleOpenOutlineContextMenu}
                />
              </aside>
            ) : null}

            <main className="va-detail-pane">
              <header className="va-edit-head">
                <div className="va-edit-title-bar">
                  <div className="va-edit-title-row">
                    <input
                      className="va-edit-title-input"
                      value={draft.title}
                      onChange={(event) => setDraft((prev) => ({ ...prev, title: event.target.value }))}
                      placeholder="Untitled"
                      aria-label="Artifact title"
                    />
                    {draft.version ? <small>v{draft.version}</small> : null}
                    <span className="va-detail-path" title={draft.path || "No item selected"}>
                      {draft.path || "No item selected"}
                    </span>
                  </div>

                  <div className="va-detail-actions va-title-icon-row">
                    {editSidebarCollapsed ? (
                      <button
                        type="button"
                        className="va-icon-btn va-outline-open-btn"
                        onClick={() => setEditSidebarCollapsed(false)}
                        aria-label="Open outline"
                        title="Open Outline"
                      >
                        <IcoPanelLeft />
                      </button>
                    ) : null}

                    <button
                      type="button"
                      className={artifactSettingsOpen ? "va-icon-btn active" : "va-icon-btn"}
                      onClick={() => setArtifactSettingsOpen((open) => !open)}
                      aria-expanded={artifactSettingsOpen}
                      aria-controls="va-artifact-settings-panel"
                      aria-label="Artifact settings"
                      title="Artifact Settings"
                    >
                      <IcoSettings />
                    </button>

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

                    {draft.kind === "file" && draft.id ? (
                      <button
                        type="button"
                        className="va-icon-btn"
                        onClick={() => void handleDownload()}
                        aria-label="Download file"
                        title="Download"
                      >
                        <IcoDownload />
                      </button>
                    ) : null}

                    {draft.kind === "file" && draft.id && isWordFileSelected ? (
                      <button
                        type="button"
                        className="va-action-btn"
                        onClick={() => void handleOpenInWord()}
                        aria-label="Edit in Word"
                        title="Open in default Word app"
                      >
                        Edit
                      </button>
                    ) : null}

                    <button type="button" className="va-icon-btn primary" onClick={() => void handleSave()} disabled={isSaving || !canSave} aria-label="Save item" title="Save">
                      <IcoFloppy />
                    </button>
                    <button
                      type="button"
                      className="va-icon-btn va-home-action-btn"
                      onClick={returnToDirectoryView}
                      aria-label="Back to directory"
                      title="Back to Directory"
                    >
                      <IcoHome />
                    </button>
                  </div>
                </div>

                {artifactSettingsOpen ? (
                  <div id="va-artifact-settings-panel" className="va-artifact-settings-panel">
                    <div className="va-artifact-settings-head">
                      <span className="va-field-label">File settings</span>
                      <button type="button" className="va-icon-btn" onClick={() => setArtifactSettingsOpen(false)} aria-label="Close artifact settings">
                        <IcoClose />
                      </button>
                    </div>

                    <div className="va-artifact-settings-section">
                      <div className="va-edit-tags-wrap" onClick={() => document.getElementById("va-artifact-tag-input")?.focus()}>
                        {draft.tags.map((tag) => (
                          <span key={tag} className="va-tag-chip">
                            {tag}
                            <button
                              type="button"
                              onClick={() => setDraft((prev) => ({ ...prev, tags: prev.tags.filter((value) => value !== tag) }))}
                              aria-label={`Remove ${tag}`}
                            >
                              <IcoClose />
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
                          placeholder="Add tag"
                        />
                      </div>
                    </div>

                    <label className="va-detail-project-picker">
                      <span>Primary Project</span>
                      <select value={draft.projectId} onChange={(event) => handleDraftProjectChange(event.target.value)}>
                        {detailProjectOptions.map((project) => (
                          <option key={project.projectId} value={project.projectId}>
                            {normalizeProjectName(project.projectId, project.projectName)}
                          </option>
                        ))}
                      </select>
                    </label>

                    {selectedItemSummary ? (
                      <ArtifactProjectMemberships
                        key={selectedItemSummary.id}
                        item={selectedItemSummary}
                        projects={detailProjectOptions.map((project) => ({
                          id: project.projectId,
                          name: normalizeProjectName(project.projectId, project.projectName)
                        }))}
                      />
                    ) : null}
                  </div>
                ) : null}
            </header>

            <section className={`va-form-grid${editorExpanded ? " editor-expanded" : ""}${pdfExpanded ? " pdf-expanded" : ""}`}>
              {draft.kind === "file" ? (
                <div className="span-2 va-meta-strip">
                  <div>
                    <small>MIME</small>
                    <p className="va-truncate-1" title={draft.mimeType || "-"}>
                      {draft.mimeType || "-"}
                    </p>
                  </div>
                  <div>
                    <small>SIZE</small>
                    <p className="va-truncate-1" title={formatSize(draft.sizeBytes)}>
                      {formatSize(draft.sizeBytes)}
                    </p>
                  </div>
                  <div>
                    <small>UPDATED</small>
                    <p className="va-truncate-1" title={draft.updatedAt ? formatDateTime(draft.updatedAt) : "-"}>
                      {draft.updatedAt ? formatDateTime(draft.updatedAt) : "-"}
                    </p>
                  </div>
                </div>
              ) : null}

              {markdownEditorVisible ? (
                <div className="span-2 va-content-section">
                  <div className="va-content-head">
                    <div className="va-content-head-right">
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
                          className={notePreviewMode === "live" ? "active" : undefined}
                          onClick={() => setNotePreviewMode("live")}
                        >
                          Live
                        </button>
                      </div>
                      <button
                        type="button"
                        className="va-icon-btn va-expand-btn"
                        onClick={() => setEditorExpanded((v) => !v)}
                        title={editorExpanded ? "Collapse (Ctrl+Shift+竊・" : "Expand (Ctrl+Shift+竊・"}
                        aria-label={editorExpanded ? "Collapse editor" : "Expand editor"}
                      >
                        {editorExpanded ? <IcoCompress /> : <IcoExpand />}
                      </button>
                    </div>
                  </div>

                  {notePreviewMode === "edit" ? (
                    <textarea
                      ref={editorRef}
                      rows={14}
                      value={draft.contentMarkdown}
                      onChange={(event) => setDraft((prev) => ({ ...prev, contentMarkdown: event.target.value }))}
                      onKeyDown={handleEditorKeyDown}
                      onContextMenu={handleEditEditorContextMenu}
                      onDragOver={(event) => { event.preventDefault(); }}
                      onDrop={(event) => { void handleEditorDrop(event); }}
                      onPaste={(event) => { void handleEditorPaste(event); }}
                      placeholder="# note"
                    />
                  ) : (
                    <div
                      ref={notionEditorRef}
                      className="va-notion-editor"
                      contentEditable
                      suppressContentEditableWarning
                      onInput={handleNotionEditorInput}
                      onKeyDown={handleNotionEditorKeyDown}
                      onMouseDown={handleNotionEditorMouseDown}
                      onMouseOver={handleNotionEditorMouseOver}
                      onMouseUp={handleNotionEditorMouseUp}
                      onClick={handleNotionEditorClick}
                      onContextMenu={handleNotionEditorContextMenu}
                      onPaste={handleNotionEditorPaste}
                      onDragOver={(event) => { event.preventDefault(); }}
                      onDrop={handleNotionEditorDrop}
                      onBlur={syncDraftFromNotionEditor}
                      data-placeholder="Type markdown-like text. Use '- ' for bullet."
                    />
                  )}
                </div>
              ) : null}

              {draft.kind === "file" && isImage(draft) ? (
                <div className="span-2 va-preview-section">
                  <span className="va-field-label">Preview</span>
                  {imageBlobUrl ? (
                    <img src={imageBlobUrl} alt={draft.title} className="va-image-preview" />
                  ) : (
                    <div className="va-empty">Loading image preview...</div>
                  )}
                </div>
              ) : null}

              {draft.kind === "file" && (isPdf(draft) || canShowWordPreviewPdf) ? (
                <div className="span-2 va-preview-section va-pdf-section">
                  {pdfBlobUrl ? (
                    <PdfViewer
                      blobUrl={pdfBlobUrl}
                      title={draft.title}
                      artifactId={draft.id!}
                      expanded={pdfExpanded}
                      onToggleExpand={() => setPdfExpanded((v) => !v)}
                    />
                  ) : (
                    <div className="va-empty">Loading PDF preview...</div>
                  )}
                </div>
              ) : null}

              {isWordFileSelected && draft.previewPdfStatus === "pending" ? (
                <div className="span-2 va-preview-section">
                  <span className="va-field-label">Preview</span>
                  <div className="va-empty">Word preview is being generated in background...</div>
                </div>
              ) : null}

              {isWordFileSelected && draft.previewPdfStatus === "error" ? (
                <div className="span-2 va-preview-section">
                  <span className="va-field-label">Preview</span>
                  <div className="va-empty">Word preview generation failed. Please re-upload or open via Edit.</div>
                </div>
              ) : null}

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
          )}
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
          {contextMenu.target.type === "item" ? (
            <button
              type="button"
              onClick={() =>
                executeContextAction(async () => {
                  if (contextMenu.target.type !== "item") {
                    return;
                  }
                  await openArtifactItemInNewWindow(contextMenu.target.item);
                })
              }
            >
              Open in New Window
            </button>
          ) : null}
          {contextPinCandidate ? (
            <button
              type="button"
              onClick={() =>
                executeContextAction(() => {
                  togglePinnedArtifact(contextPinCandidate);
                })
              }
            >
              {contextPinCandidateIsPinned ? "Unpin" : "Pin"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() =>
              executeContextAction(async () => {
                await copyTextToClipboard(resolveContextTargetPath(contextMenu.target));
              })
            }
          >
            Copy Path
          </button>
          <button
            type="button"
            onClick={() =>
              executeContextAction(async () => {
                await handleContextExport();
              })
            }
            disabled={contextExportCandidates.length === 0}
          >
            {selectedItemIds.length > 1 || contextExportCandidates.length > 1
              ? "Export Selected"
              : contextMenu.target.type === "item"
                ? contextMenu.target.item.kind === "folder"
                  ? "Export Folder"
                  : "Export File"
                : "Export Folder"}
          </button>
          <button
            type="button"
            onClick={() =>
              executeContextAction(() => {
                const basePath =
                  contextMenu.target.type === "item"
                    ? contextMenu.target.item.kind === "folder"
                      ? contextMenu.target.item.path
                      : parentPath(contextMenu.target.item.path)
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
                if (!contextRenameFolderCandidate) {
                  return;
                }
                startRenameFolder(contextRenameFolderCandidate);
              })
            }
            disabled={!contextRenameFolderCandidate}
          >
            Rename Folder
          </button>
          <button
            type="button"
            onClick={() =>
              executeContextAction(() => {
                if (!contextRenameFolderCandidate) {
                  return;
                }
                startMoveFolderToProject(contextRenameFolderCandidate);
              })
            }
            disabled={!contextRenameFolderCandidate || contextMoveFolderProjectOptions.length === 0}
          >
            Move Folder to Project
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

      {tableContextMenu && tableContextMenuPosition ? (
        <div
          className="va-context-menu va-table-context-menu"
          style={{ left: tableContextMenuPosition.left, top: tableContextMenuPosition.top }}
          onClick={(event) => event.stopPropagation()}
        >
          <button type="button" onClick={() => executeTableContextAction(() => applySelectedTableOperation("insert-row-above"))}>
            Insert Row Above
          </button>
          <button type="button" onClick={() => executeTableContextAction(() => applySelectedTableOperation("insert-row-below"))}>
            Insert Row Below
          </button>
          <button type="button" onClick={() => executeTableContextAction(() => applySelectedTableOperation("insert-column-left"))}>
            Insert Column Left
          </button>
          <button type="button" onClick={() => executeTableContextAction(() => applySelectedTableOperation("insert-column-right"))}>
            Insert Column Right
          </button>
          <button
            type="button"
            disabled={!canDeleteTableRows}
            onClick={() => executeTableContextAction(() => applySelectedTableOperation("delete-rows"))}
          >
            Delete Selected Rows
          </button>
          <button
            type="button"
            disabled={!canDeleteTableColumns}
            onClick={() => executeTableContextAction(() => applySelectedTableOperation("delete-columns"))}
          >
            Delete Selected Columns
          </button>
        </div>
      ) : null}

      {editorContextMenu && editorContextMenuPosition ? (
        <div
          className="va-context-menu"
          style={{ left: editorContextMenuPosition.left, top: editorContextMenuPosition.top }}
          onClick={(event) => event.stopPropagation()}
        >
          <button type="button" onClick={() => handleInsertTableFromEditorContext()}>
            Insert Table
          </button>
          <button type="button" onClick={() => handleOpenInsertLinkDialog()}>
            Insert Link
          </button>
        </div>
      ) : null}

      {outlineContextMenu && outlineContextMenuPosition ? (
        <div
          className="va-context-menu va-outline-context-menu"
          style={{ left: outlineContextMenuPosition.left, top: outlineContextMenuPosition.top }}
          onClick={(event) => event.stopPropagation()}
        >
          <button type="button" onClick={() => executeOutlineContextAction(() => handleOutlineSelect(outlineContextMenu.entry))}>
            Jump To Heading
          </button>
          <button type="button" onClick={() => executeOutlineContextAction(() => insertFromOutlineContext("text"))}>
            Add Text Below
          </button>
          <button type="button" onClick={() => executeOutlineContextAction(() => insertFromOutlineContext("heading"))}>
            Add Heading Below
          </button>
          <button type="button" onClick={() => executeOutlineContextAction(() => insertFromOutlineContext("bullet"))}>
            Add Bullet Below
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

      <TextInputDialog
        open={Boolean(renameFolderState)}
        title="Rename Folder"
        message={renameFolderState ? `Current: "${renameFolderState.currentPath}"` : undefined}
        label="Folder name"
        placeholder={renameFolderState?.currentName || "Folder name"}
        initialValue={renameFolderState?.currentName || ""}
        confirmLabel="Rename"
        busy={isSaving}
        onCancel={() => setRenameFolderState(null)}
        onConfirm={(value) => {
          void handleRenameFolderConfirm(value);
        }}
      />

      {moveFolderProjectState ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={isSaving ? undefined : () => setMoveFolderProjectState(null)}
        >
          <section
            className="va-project-move-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Move folder to project"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="va-project-move-dialog-head">
              <h3>Move Folder to Project</h3>
            </header>
            <div className="va-project-move-dialog-body">
              <p>Move "{moveFolderProjectState.currentPath}" and its contents.</p>
              <label>
                <span>Project</span>
                <select
                  value={moveFolderProjectState.targetProjectId}
                  onChange={(event) =>
                    setMoveFolderProjectState((prev) =>
                      prev ? { ...prev, targetProjectId: event.target.value } : prev
                    )
                  }
                  disabled={isSaving || moveFolderProjectOptions.length === 0}
                >
                  {moveFolderProjectOptions.map((project) => (
                    <option key={project.projectId} value={project.projectId}>
                      {normalizeProjectName(project.projectId, project.projectName)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <footer className="va-project-move-dialog-actions">
              <button type="button" className="ghost-button" onClick={() => setMoveFolderProjectState(null)} disabled={isSaving}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleMoveFolderProjectConfirm()}
                disabled={isSaving || moveFolderProjectOptions.length === 0}
              >
                Move
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      <TextInputDialog
        open={Boolean(insertLinkState)}
        title="Insert Link"
        message={insertLinkState?.mode === "live" ? "Insert link into live editor selection." : "Insert markdown link."}
        label="URL"
        placeholder="https://example.com or relative/path.md"
        confirmLabel="Insert"
        busy={isSaving}
        onCancel={() => setInsertLinkState(null)}
        onConfirm={(value) => {
          handleInsertLinkConfirm(value);
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

  if (!isDedicatedApp) {
    return artifactsSection;
  }

  const railToggleLabel = railVisible ? "Hide the quick access rail" : "Show the quick access rail";

  return (
    <>
      <TitleBarPortal>
        {/* Search results can only render in the directory pane, so these controls would be inert in detail view. */}
        {!hasDetailSelection ? (
          <>
            <input
              ref={searchInputRef}
              className="chrome-search"
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setSearchQuery("");
                }
              }}
              placeholder="Search artifacts"
              aria-label="Search artifacts"
            />
            <select
              className="chrome-select"
              value={projectFilter}
              onChange={(event) => setProjectFilter(event.target.value)}
              aria-label="Filter by project"
            >
              <option value="">All</option>
              {projectOptions.map((project) => (
                <option key={project.projectId} value={project.projectId}>
                  {normalizeProjectName(project.projectId, project.projectName)}
                </option>
              ))}
            </select>
          </>
        ) : null}
        <button
          type="button"
          className={railVisible ? "chrome-icon-button active" : "chrome-icon-button"}
          aria-pressed={railVisible}
          aria-label={railToggleLabel}
          title={railToggleLabel}
          onClick={() => {
            const nextVisible = !railVisible;
            setRailVisible(nextVisible);
            writeArtifactsRailVisible(nextVisible);
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect x="2" y="3" width="12" height="10" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M6 3v10" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
      </TitleBarPortal>
      <div className={railVisible ? "va-app-layout" : "va-app-layout rail-hidden"}>
        {railVisible ? (
          <aside className="va-app-rail">
            <ArtifactsQuickAccess />
          </aside>
        ) : null}
        {artifactsSection}
      </div>
    </>
  );
}
