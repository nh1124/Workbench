import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import JSZip from "jszip";
import { Link, useSearchParams } from "react-router-dom";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { TextInputDialog } from "../components/TextInputDialog";
import { artifactsApi, projectsApi } from "../lib/api";
import { formatDateTime, normalizeProjectName } from "../lib/format";
import type { ArtifactItem, ProjectRecord } from "../types/models";
import type {
  CreateFolderState,
  DeleteConfirmState,
  EditorContextMenuState,
  InsertLinkState,
  ProjectOption,
  TableSelectionState,
  TableContextMenuState,
  TextSelectionSnapshot,
  TreeContextMenuState,
  TreeContextTarget,
  TreeFolderNode
} from "../artifacts/types";
import { defaultDraft, type ArtifactEditorDraft } from "../artifacts/types";
import {
  isExternalUrl,
  isMarkdownFilePath,
  joinPath,
  leafPath,
  normalizePath,
  parentPath,
  relativeArtifactPath,
  resolveMarkdownRef
} from "../artifacts/utils/path";
import {
  ensureItemExportFilename,
  formatSize,
  isImage,
  isPdf,
  sanitizeExportFilename,
  triggerBlobDownload
} from "../artifacts/utils/file";
import {
  buildTree,
  collectVisibleSelectableItemIds,
  itemToDraft,
  uniqueProjectOptions
} from "../artifacts/utils/tree";
import {
  clampTableSelectionBounds,
  createNotionBlock,
  createNotionTableCell,
  findNotionBlock,
  getNotionTableColumnCount,
  getNotionTableRows,
  hasMeaningfulBlockContent,
  markdownToNotionHtml,
  normalizeNotionBlockElement,
  normalizeTableSelectionBounds,
  notionEditorToMarkdown,
  placeCaretAtBlockStart
} from "../artifacts/utils/notionMarkdown";
import {
  transformBoldAtSelection,
  transformEnterWithLevelContinuation,
  transformSelectedLinesLevel,
  transformStrikeAtSelection,
  type EditorTextTransformResult
} from "../artifacts/utils/editorTransforms";
import {
  IcoClose,
  IcoCompress,
  IcoDownload,
  IcoExpand,
  IcoFile,
  IcoFloppy,
  IcoFolder,
  IcoHome,
  IcoTrash,
  IcoUpload
} from "../artifacts/components/ArtifactsIcons";
import { DirectoryBrowser } from "../artifacts/components/DirectoryBrowser";
import "./ArtifactsPage.css";


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
  const [notePreviewMode, setNotePreviewMode] = useState<"edit" | "live">("edit");
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null);
  const [imageBlobUrl, setImageBlobUrl] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<TreeContextMenuState | null>(null);
  const [tableContextMenu, setTableContextMenu] = useState<TableContextMenuState | null>(null);
  const [editorContextMenu, setEditorContextMenu] = useState<EditorContextMenuState | null>(null);
  const [tableSelection, setTableSelection] = useState<TableSelectionState | null>(null);
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState | null>(null);
  const [createFolderState, setCreateFolderState] = useState<CreateFolderState | null>(null);
  const [insertLinkState, setInsertLinkState] = useState<InsertLinkState | null>(null);
  const [editorExpanded, setEditorExpanded] = useState(false);
  const [mobileTreeVisible, setMobileTreeVisible] = useState(false);

  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const notionEditorRef = useRef<HTMLDivElement | null>(null);
  const draggingItemRef = useRef<ArtifactItem | null>(null);
  const tableSelectionDragRef = useRef<TableSelectionState | null>(null);
  const handleCreateNoteRef = useRef<() => void>(() => {});
  const handleSaveRef = useRef<() => Promise<void>>(async () => {});
  const shortcutStateRef = useRef({ canSave: false, isSaving: false, markdownEditorVisible: false });
  const notionSyncRef = useRef<{ itemId?: string; markdown: string }>({ itemId: undefined, markdown: "" });
  const editSelectionRef = useRef<TextSelectionSnapshot | null>(null);
  const liveSelectionRef = useRef<Range | null>(null);

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

  const hasDetailSelection = Boolean(selectedItemId || mode === "create-note");

  const contextMenuPosition = useMemo(() => {
    if (!contextMenu) return null;
    const menuWidth = 180;
    const menuHeight = 232;
    const margin = 8;
    const maxX = window.innerWidth - menuWidth - margin;
    const maxY = window.innerHeight - menuHeight - margin;
    return {
      left: Math.max(margin, Math.min(contextMenu.x, maxX)),
      top: Math.max(margin, Math.min(contextMenu.y, maxY))
    };
  }, [contextMenu]);

  const tableContextMenuPosition = useMemo(() => {
    if (!tableContextMenu) return null;
    const menuWidth = 220;
    const menuHeight = 220;
    const margin = 8;
    const maxX = window.innerWidth - menuWidth - margin;
    const maxY = window.innerHeight - menuHeight - margin;
    return {
      left: Math.max(margin, Math.min(tableContextMenu.x, maxX)),
      top: Math.max(margin, Math.min(tableContextMenu.y, maxY))
    };
  }, [tableContextMenu]);

  const editorContextMenuPosition = useMemo(() => {
    if (!editorContextMenu) return null;
    const menuWidth = 180;
    const menuHeight = 110;
    const margin = 8;
    const maxX = window.innerWidth - menuWidth - margin;
    const maxY = window.innerHeight - menuHeight - margin;
    return {
      left: Math.max(margin, Math.min(editorContextMenu.x, maxX)),
      top: Math.max(margin, Math.min(editorContextMenu.y, maxY))
    };
  }, [editorContextMenu]);

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
    if (!draft.id || draft.kind !== "file" || !isImage(draft)) {
      if (imageBlobUrl) URL.revokeObjectURL(imageBlobUrl);
      setImageBlobUrl(null);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;

    void artifactsApi
      .downloadFile(draft.id, false)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setImageBlobUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setImageBlobUrl(null);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [draft.id, draft.kind, draft.mimeType, draft.path]);

  useEffect(() => {
    if (notePreviewMode !== "live") {
      return;
    }
    const editor = notionEditorRef.current;
    if (!editor) return;

    const hasItemChanged = notionSyncRef.current.itemId !== draft.id;
    const hasMarkdownChanged = notionSyncRef.current.markdown !== draft.contentMarkdown;
    const isFocused = document.activeElement === editor;
    if (!hasItemChanged && !hasMarkdownChanged && isFocused) {
      return;
    }

    editor.innerHTML = markdownToNotionHtml(draft.contentMarkdown || "");
    if (editor.children.length === 0) {
      editor.appendChild(createNotionBlock("paragraph"));
    }
    notionSyncRef.current = { itemId: draft.id, markdown: draft.contentMarkdown };
  }, [draft.contentMarkdown, draft.id, notePreviewMode]);

  useEffect(() => {
    if (notePreviewMode !== "live") {
      tableSelectionDragRef.current = null;
      setTableSelection(null);
      setTableContextMenu(null);
      applyTableSelectionVisual(null);
      return;
    }
    applyTableSelectionVisual(tableSelection);
  }, [draft.contentMarkdown, draft.id, notePreviewMode, tableSelection]);

  useEffect(() => {
    if (!contextMenu && !tableContextMenu && !editorContextMenu) return;

    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
        setTableContextMenu(null);
        setEditorContextMenu(null);
      }
    };
    const handleClose = () => {
      setContextMenu(null);
      setTableContextMenu(null);
      setEditorContextMenu(null);
    };

    window.addEventListener("keydown", handleEscape);
    window.addEventListener("resize", handleClose);
    window.addEventListener("scroll", handleClose, true);
    return () => {
      window.removeEventListener("keydown", handleEscape);
      window.removeEventListener("resize", handleClose);
      window.removeEventListener("scroll", handleClose, true);
    };
  }, [contextMenu, editorContextMenu, tableContextMenu]);

  useEffect(() => {
    const existingIds = new Set(items.map((item) => item.id));
    setSelectedItemIds((prev) => {
      const next = prev.filter((id) => existingIds.has(id));
      return next.length === prev.length ? prev : next;
    });
    setSelectionAnchorId((prev) => (prev && existingIds.has(prev) ? prev : null));
  }, [items]);

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      const { canSave: cs, isSaving: is, markdownEditorVisible: mev } = shortcutStateRef.current;
      const key = e.key.toLowerCase();
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
      // Ctrl+Shift+竊・ expand editor
      if (e.ctrlKey && e.shiftKey && e.key === "ArrowUp") {
        if (mev) {
          e.preventDefault();
          setEditorExpanded(true);
        }
        return;
      }
      // Ctrl+Shift+竊・ shrink editor
      if (e.ctrlKey && e.shiftKey && e.key === "ArrowDown") {
        if (mev) {
          e.preventDefault();
          setEditorExpanded(false);
        }
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []); // stable: reads via refs, sets via stable setState

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

  const selectItem = (item: ArtifactItem, options?: { shiftKey?: boolean; toggleKey?: boolean }) => {
    const withShift = Boolean(options?.shiftKey);
    const withToggle = Boolean(options?.toggleKey);
    updateSelection(item.id, { shiftKey: withShift, toggleKey: withToggle });

    // Shift/Ctrl multi-select should not force pane transition.
    if (!withShift && !withToggle) {
      setMobileTreeVisible(false);
      setSelectedItemId(item.id);
      setSelectedFolderPath(parentPath(item.path));
      setError(null);
      setTagInput("");
    }
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
    setTableContextMenu(null);
    setEditorContextMenu(null);
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

  const isCellInTableSelection = (selection: TableSelectionState, row: number, col: number): boolean => {
    const bounds = normalizeTableSelectionBounds(selection);
    return row >= bounds.startRow && row <= bounds.endRow && col >= bounds.startCol && col <= bounds.endCol;
  };

  function applyTableSelectionVisual(selection: TableSelectionState | null): void {
    const editor = notionEditorRef.current;
    if (!editor) return;
    editor.querySelectorAll(".va-notion-table-cell.table-selected").forEach((node) => {
      node.classList.remove("table-selected");
    });
    if (!selection) {
      return;
    }
    const tableBlock = editor.querySelector(
      `[data-md-kind="table"][data-table-id="${selection.tableId}"]`
    ) as HTMLElement | null;
    if (!tableBlock) {
      return;
    }
    const table = tableBlock.querySelector("table");
    if (!(table instanceof HTMLTableElement)) {
      return;
    }
    const rows = getNotionTableRows(table);
    const bounds = clampTableSelectionBounds(
      normalizeTableSelectionBounds(selection),
      rows.length,
      getNotionTableColumnCount(table)
    );
    for (let row = bounds.startRow; row <= bounds.endRow; row += 1) {
      const rowElement = rows[row];
      if (!rowElement) continue;
      for (let col = bounds.startCol; col <= bounds.endCol; col += 1) {
        const cell = rowElement.cells[col];
        if (cell instanceof HTMLTableCellElement) {
          cell.classList.add("table-selected");
        }
      }
    }
  }

  const setAndApplyTableSelection = (selection: TableSelectionState | null) => {
    setTableSelection(selection);
    applyTableSelectionVisual(selection);
  };

  const getSelectedTableContext = (selection: TableSelectionState | null) => {
    const editor = notionEditorRef.current;
    if (!editor || !selection) {
      return null;
    }
    const block = editor.querySelector(
      `[data-md-kind="table"][data-table-id="${selection.tableId}"]`
    ) as HTMLElement | null;
    if (!block) {
      return null;
    }
    normalizeNotionBlockElement(block);
    const table = block.querySelector("table");
    if (!(table instanceof HTMLTableElement)) {
      return null;
    }
    const rows = getNotionTableRows(table);
    if (rows.length === 0) {
      return null;
    }
    const colCount = getNotionTableColumnCount(table);
    return {
      block,
      table,
      rows,
      colCount,
      selection: {
        ...selection,
        ...{
          start: selection.start,
          end: selection.end
        }
      },
      bounds: clampTableSelectionBounds(normalizeTableSelectionBounds(selection), rows.length, colCount)
    };
  };

  const applyTableOperation = (
    operation:
      | "insert-row-above"
      | "insert-row-below"
      | "insert-column-left"
      | "insert-column-right"
      | "delete-rows"
      | "delete-columns"
  ) => {
    const activeSelection = tableContextMenu?.selection ?? tableSelection;
    const context = getSelectedTableContext(activeSelection);
    if (!context) {
      return;
    }
    const { table, rows, colCount, bounds } = context;
    const tbody = table.tBodies[0] ?? table.createTBody();
    const headerRow = table.tHead?.rows[0] ?? table.createTHead().insertRow();
    while (headerRow.cells.length < colCount) {
      headerRow.appendChild(createNotionTableCell("th"));
    }

    let nextSelection: TableSelectionState | null = activeSelection;

    if (operation === "insert-row-above" || operation === "insert-row-below") {
      const bodyInsertIndex =
        operation === "insert-row-above"
          ? Math.max(0, bounds.startRow - 1)
          : Math.max(0, bounds.endRow);
      const row = tbody.insertRow(Math.min(bodyInsertIndex, tbody.rows.length));
      for (let col = 0; col < colCount; col += 1) {
        row.appendChild(createNotionTableCell("td"));
      }
      const fullRowIndex =
        operation === "insert-row-above"
          ? Math.max(1, bounds.startRow)
          : Math.max(1, bounds.endRow + 1);
      nextSelection = {
        tableId: activeSelection!.tableId,
        start: { row: fullRowIndex, col: bounds.startCol },
        end: { row: fullRowIndex, col: bounds.endCol }
      };
    }

    if (operation === "delete-rows") {
      const deleteStart = Math.max(1, bounds.startRow);
      const deleteEnd = Math.max(1, bounds.endRow);
      if (deleteStart <= deleteEnd && tbody.rows.length > 0) {
        const bodyStart = Math.max(0, deleteStart - 1);
        const bodyEnd = Math.min(tbody.rows.length - 1, deleteEnd - 1);
        for (let index = bodyEnd; index >= bodyStart; index -= 1) {
          tbody.deleteRow(index);
        }
      }
      if (tbody.rows.length === 0) {
        const fallback = tbody.insertRow();
        for (let col = 0; col < colCount; col += 1) {
          fallback.appendChild(createNotionTableCell("td"));
        }
      }
      nextSelection = {
        tableId: activeSelection!.tableId,
        start: { row: 1, col: bounds.startCol },
        end: { row: 1, col: bounds.endCol }
      };
    }

    if (operation === "insert-column-left" || operation === "insert-column-right") {
      const insertCol = operation === "insert-column-left" ? bounds.startCol : bounds.endCol + 1;
      const tableRows = getNotionTableRows(table);
      for (let row = 0; row < tableRows.length; row += 1) {
        const rowElement = tableRows[row];
        const isHeader = row === 0;
        const nextCell = createNotionTableCell(isHeader ? "th" : "td");
        const reference = rowElement.cells[insertCol];
        if (reference) {
          rowElement.insertBefore(nextCell, reference);
        } else {
          rowElement.appendChild(nextCell);
        }
      }
      nextSelection = {
        tableId: activeSelection!.tableId,
        start: { row: bounds.startRow, col: insertCol },
        end: { row: bounds.endRow, col: insertCol }
      };
    }

    if (operation === "delete-columns") {
      const tableRows = getNotionTableRows(table);
      const currentColCount = getNotionTableColumnCount(table);
      const deleteCount = bounds.endCol - bounds.startCol + 1;
      if (currentColCount > deleteCount) {
        for (const rowElement of tableRows) {
          for (let col = bounds.endCol; col >= bounds.startCol; col -= 1) {
            if (rowElement.cells[col]) {
              rowElement.deleteCell(col);
            }
          }
        }
      }
      const nextCol = Math.max(0, Math.min(bounds.startCol, getNotionTableColumnCount(table) - 1));
      nextSelection = {
        tableId: activeSelection!.tableId,
        start: { row: bounds.startRow, col: nextCol },
        end: { row: bounds.endRow, col: nextCol }
      };
    }

    const normalizedContext = getSelectedTableContext(nextSelection);
    const correctedSelection = normalizedContext
      ? {
          tableId: nextSelection!.tableId,
          start: { row: normalizedContext.bounds.startRow, col: normalizedContext.bounds.startCol },
          end: { row: normalizedContext.bounds.endRow, col: normalizedContext.bounds.endCol }
        }
      : nextSelection;
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
      const nextText = `${text.slice(0, start)}${insertion}${text.slice(end)}`;
      const cursor = start + insertion.length;
      applyEditorTransform({
        nextText,
        nextSelectionStart: cursor,
        nextSelectionEnd: cursor
      });
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

  const handleStartCreateNote = () => {
    const targetProject = resolveProjectFromFilter();

    const newPath = joinPath(currentFolderPath, "new-note.md") || "new-note.md";
    setMobileTreeVisible(false);
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
    const files = Array.from(event.clipboardData.files).filter((f) => /^image\//i.test(f.type));
    if (files.length === 0) return;
    event.preventDefault();

    const insertPos = event.currentTarget.selectionStart ?? draft.contentMarkdown.length;
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

  const applyEditorTransform = (transform: EditorTextTransformResult) => {
    setDraft((prev) => ({
      ...prev,
      contentMarkdown: transform.nextText
    }));
    requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      editor.setSelectionRange(transform.nextSelectionStart, transform.nextSelectionEnd);
    });
  };

  const rememberEditSelection = (textarea: HTMLTextAreaElement) => {
    const text = textarea.value;
    const start = textarea.selectionStart ?? text.length;
    const end = textarea.selectionEnd ?? text.length;
    editSelectionRef.current = {
      start,
      end,
      text: text.slice(start, end)
    };
  };

  const rememberLiveSelection = () => {
    const editor = notionEditorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) {
      liveSelectionRef.current = null;
      return;
    }
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) {
      liveSelectionRef.current = null;
      return;
    }
    liveSelectionRef.current = range.cloneRange();
  };

  const applyDraftInsertion = (insertedText: string) => {
    const text = draft.contentMarkdown;
    const snapshot = editSelectionRef.current;
    const fallbackPos = editorRef.current?.selectionStart ?? text.length;
    const start = snapshot?.start ?? fallbackPos;
    const end = snapshot?.end ?? fallbackPos;
    const nextText = `${text.slice(0, start)}${insertedText}${text.slice(end)}`;
    const cursor = start + insertedText.length;
    applyEditorTransform({
      nextText,
      nextSelectionStart: cursor,
      nextSelectionEnd: cursor
    });
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

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const text = draft.contentMarkdown;
    const selectionStart = event.currentTarget.selectionStart ?? text.length;
    const selectionEnd = event.currentTarget.selectionEnd ?? text.length;
    const withCtrl = event.ctrlKey || event.metaKey;

    if (!withCtrl && !event.altKey && !event.shiftKey && event.key === "Enter") {
      const continued = transformEnterWithLevelContinuation(text, selectionStart, selectionEnd);
      if (continued) {
        event.preventDefault();
        applyEditorTransform(continued);
      }
      return;
    }

    if (!withCtrl) {
      return;
    }

    const lowerKey = event.key.toLowerCase();
    if (lowerKey === "b") {
      event.preventDefault();
      applyEditorTransform(transformBoldAtSelection(text, selectionStart, selectionEnd));
      return;
    }

    const isStrikeToggle = event.key === "-" || event.code === "Minus" || event.code === "NumpadSubtract";
    if (isStrikeToggle) {
      event.preventDefault();
      applyEditorTransform(transformStrikeAtSelection(text, selectionStart, selectionEnd));
      return;
    }

    const isIncrease = event.key === ">" || (event.shiftKey && event.key === ".");
    if (isIncrease) {
      const transformed = transformSelectedLinesLevel(text, selectionStart, selectionEnd, 1);
      if (transformed) {
        event.preventDefault();
        applyEditorTransform(transformed);
      }
      return;
    }

    const isDecrease = event.key === "<" || (event.shiftKey && event.key === ",");
    if (isDecrease) {
      const transformed = transformSelectedLinesLevel(text, selectionStart, selectionEnd, -1);
      if (transformed) {
        event.preventDefault();
        applyEditorTransform(transformed);
      }
    }
  };

  const syncDraftFromNotionEditor = () => {
    const editor = notionEditorRef.current;
    if (!editor) return;
    // Keep only normalized notion blocks so serialization is stable.
    const children = Array.from(editor.children) as HTMLElement[];
    if (children.length === 0) {
      editor.appendChild(createNotionBlock("paragraph"));
    } else {
      for (const child of children) {
        normalizeNotionBlockElement(child);
      }
    }

    const markdown = notionEditorToMarkdown(editor);
    notionSyncRef.current = { itemId: draft.id, markdown };
    setDraft((prev) => (prev.contentMarkdown === markdown ? prev : { ...prev, contentMarkdown: markdown }));
  };

  const handleNotionEditorInput = () => {
    syncDraftFromNotionEditor();
  };

  const handleNotionEditorPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain");
    if (text) {
      document.execCommand("insertText", false, text);
      syncDraftFromNotionEditor();
    }
  };

  const handleNotionEditorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const editor = notionEditorRef.current;
    if (!editor) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const currentBlock = findNotionBlock(editor, range.startContainer);
    if (!currentBlock) return;

    const withCtrl = event.ctrlKey || event.metaKey;
    const isInsideTableCell =
      currentBlock.dataset.mdKind === "table" &&
      event.target instanceof HTMLElement &&
      event.target.closest("th,td") instanceof HTMLTableCellElement;

    if (withCtrl && event.key.toLowerCase() === "b") {
      event.preventDefault();
      document.execCommand("bold");
      syncDraftFromNotionEditor();
      return;
    }

    const isStrikeToggle = event.key === "-" || event.code === "Minus" || event.code === "NumpadSubtract";
    if (withCtrl && isStrikeToggle) {
      event.preventDefault();
      document.execCommand("strikeThrough");
      syncDraftFromNotionEditor();
      return;
    }

    if (isInsideTableCell) {
      return;
    }

    if (withCtrl && (event.key === ">" || (event.shiftKey && event.key === "."))) {
      if (currentBlock.dataset.mdKind === "bullet" || currentBlock.dataset.mdKind === "heading") {
        event.preventDefault();
        const currentLevel = Number(currentBlock.dataset.mdLevel || "1");
        currentBlock.dataset.mdLevel = String(Math.min(3, currentLevel + 1));
        normalizeNotionBlockElement(currentBlock);
        syncDraftFromNotionEditor();
      }
      return;
    }

    if (withCtrl && (event.key === "<" || (event.shiftKey && event.key === ","))) {
      if (currentBlock.dataset.mdKind === "bullet" || currentBlock.dataset.mdKind === "heading") {
        event.preventDefault();
        const currentLevel = Number(currentBlock.dataset.mdLevel || "1");
        if (currentLevel <= 1) {
          currentBlock.dataset.mdKind = "paragraph";
          delete currentBlock.dataset.mdLevel;
        } else {
          currentBlock.dataset.mdLevel = String(currentLevel - 1);
        }
        normalizeNotionBlockElement(currentBlock);
        syncDraftFromNotionEditor();
      }
      return;
    }

    if (event.key === " " && range.collapsed) {
      const beforeRange = document.createRange();
      beforeRange.setStart(currentBlock, 0);
      beforeRange.setEnd(range.startContainer, range.startOffset);
      const prefix = beforeRange.toString().trim();
      const wholeText = (currentBlock.textContent ?? "").trim();
      if (/^-{1,3}$/.test(prefix) && prefix === wholeText) {
        event.preventDefault();
        currentBlock.dataset.mdKind = "bullet";
        currentBlock.dataset.mdLevel = String(Math.min(3, prefix.length));
        currentBlock.innerHTML = "<br>";
        normalizeNotionBlockElement(currentBlock);
        placeCaretAtBlockStart(currentBlock);
        syncDraftFromNotionEditor();
        return;
      }
      if (/^#{1,3}$/.test(prefix) && prefix === wholeText) {
        event.preventDefault();
        currentBlock.dataset.mdKind = "heading";
        currentBlock.dataset.mdLevel = String(Math.min(3, prefix.length));
        currentBlock.innerHTML = "<br>";
        normalizeNotionBlockElement(currentBlock);
        placeCaretAtBlockStart(currentBlock);
        syncDraftFromNotionEditor();
      }
      return;
    }

    if (event.key === "Enter" && range.collapsed) {
      event.preventDefault();
      const kind = currentBlock.dataset.mdKind === "bullet"
        ? "bullet"
        : currentBlock.dataset.mdKind === "heading"
          ? "heading"
          : "paragraph";
      const level = Number(currentBlock.dataset.mdLevel || "1");
      const blockText = (currentBlock.textContent ?? "").trim();

      if (kind === "bullet" && blockText.length === 0) {
        currentBlock.dataset.mdKind = "paragraph";
        delete currentBlock.dataset.mdLevel;
        normalizeNotionBlockElement(currentBlock);
        currentBlock.innerHTML = "<br>";
        placeCaretAtBlockStart(currentBlock);
        syncDraftFromNotionEditor();
        return;
      }

      const nextKind = kind === "bullet" ? "bullet" : "paragraph";
      const trailingRange = range.cloneRange();
      trailingRange.setEnd(currentBlock, currentBlock.childNodes.length);
      const trailingContent = trailingRange.extractContents();

      if (!hasMeaningfulBlockContent(currentBlock)) {
        currentBlock.innerHTML = "<br>";
      }

      const nextBlock = createNotionBlock(nextKind, level);
      nextBlock.innerHTML = "";
      if (trailingContent.childNodes.length > 0) {
        nextBlock.appendChild(trailingContent);
      }
      if (!hasMeaningfulBlockContent(nextBlock)) {
        nextBlock.innerHTML = "<br>";
      }

      if (currentBlock.nextSibling) {
        editor.insertBefore(nextBlock, currentBlock.nextSibling);
      } else {
        editor.appendChild(nextBlock);
      }
      placeCaretAtBlockStart(nextBlock);
      syncDraftFromNotionEditor();
    }
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
  shortcutStateRef.current = { canSave, isSaving, markdownEditorVisible };

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
      triggerBlobDownload(blob, draft.title || "artifact");
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
    setTableContextMenu(null);
    setEditorContextMenu(null);
    void action();
  };

  const executeTableContextAction = (action: () => void) => {
    setTableContextMenu(null);
    setEditorContextMenu(null);
    void action();
  };

  const tableMenuContext = tableContextMenu ? getSelectedTableContext(tableContextMenu.selection) : null;
  const canDeleteTableRows = Boolean(tableMenuContext && tableMenuContext.bounds.endRow >= 1);
  const canDeleteTableColumns = Boolean(
    tableMenuContext &&
      tableMenuContext.colCount > (tableMenuContext.bounds.endCol - tableMenuContext.bounds.startCol + 1)
  );

  return (
    <section
      className="va-artifacts-page"
      onClick={() => {
        setContextMenu(null);
        setTableContextMenu(null);
        setEditorContextMenu(null);
      }}
    >
      <section className="va-shell panel">
        <header className="va-toolbar">
          <div className="va-toolbar-left">
            {hasDetailSelection ? (
              <button
                type="button"
                className="va-mobile-pane-toggle"
                onClick={() => setMobileTreeVisible((prev) => !prev)}
                aria-label={mobileTreeVisible ? "Show editor pane" : "Show tree pane"}
                title={mobileTreeVisible ? "Show Editor" : "Show Tree"}
              >
                {mobileTreeVisible ? <IcoFile /> : <IcoFolder />}
              </button>
            ) : null}
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

        <div className={`va-main-grid ${hasDetailSelection && !mobileTreeVisible ? "viewer-active" : "browser-active"}`}>
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
            {isLoading ? (
              <div className="va-empty">Loading...</div>
            ) : (
              <DirectoryBrowser
                currentFolderNode={currentFolderNode}
                currentFolderPath={currentFolderPath}
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
                    setMobileTreeVisible(true);
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

            <section className={`va-form-grid${editorExpanded ? " editor-expanded" : ""}`}>
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
                    <span className="va-field-label">
                      {editorExpanded ? (draft.title.trim() || leafPath(draft.path) || "Untitled") : "Content (Markdown)"}
                    </span>
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
          <button type="button" onClick={() => executeTableContextAction(() => applyTableOperation("insert-row-above"))}>
            Insert Row Above
          </button>
          <button type="button" onClick={() => executeTableContextAction(() => applyTableOperation("insert-row-below"))}>
            Insert Row Below
          </button>
          <button type="button" onClick={() => executeTableContextAction(() => applyTableOperation("insert-column-left"))}>
            Insert Column Left
          </button>
          <button type="button" onClick={() => executeTableContextAction(() => applyTableOperation("insert-column-right"))}>
            Insert Column Right
          </button>
          <button
            type="button"
            disabled={!canDeleteTableRows}
            onClick={() => executeTableContextAction(() => applyTableOperation("delete-rows"))}
          >
            Delete Selected Rows
          </button>
          <button
            type="button"
            disabled={!canDeleteTableColumns}
            onClick={() => executeTableContextAction(() => applyTableOperation("delete-columns"))}
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
}


