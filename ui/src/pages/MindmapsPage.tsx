import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { IcoDownload, IcoList, IcoPlus, IcoRefresh, IcoTrash, IcoX } from "../tasks/components/icons";
import { IcoFloppy, IcoSettings } from "../artifacts/components/ArtifactsIcons";
import { artifactsApi, mindmapsApi, projectsApi, saveFileWithDialog } from "../lib/api";
import type {
  MindmapDocument,
  MindmapDocumentBody,
  MindmapExportFormat,
  MindmapMode,
  MindmapNode,
  ProjectRecord
} from "../types/models";
import "./MindmapsPage.css";

type PositionedMindmapNode = {
  node: MindmapNode;
  depth: number;
  x: number;
  y: number;
  parentId?: string;
};

type MindmapPanel = "documents" | "create" | "settings" | "export" | null;
type ExportDestination = "download" | "artifact";
type RasterExportFormat = "png" | "jpeg";
type MindmapUiExportFormat = MindmapExportFormat | RasterExportFormat;

type NodeContextMenu = {
  nodeId: string;
  x: number;
  y: number;
} | null;

type CanvasPanState = {
  pointerId: number;
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
  hasMoved: boolean;
};

type FileSavePicker = {
  suggestedName?: string;
  types?: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
};

type WritableFileHandle = {
  createWritable: () => Promise<{
    write: (data: Blob) => Promise<void>;
    close: () => Promise<void>;
  }>;
};

type WindowWithSavePicker = Window & {
  showSaveFilePicker?: (options?: FileSavePicker) => Promise<WritableFileHandle>;
};

const modeLabels: Record<MindmapMode, string> = {
  mindmap: "Mindmap",
  logical_tree: "Logical Tree"
};

const MIN_CANVAS_ZOOM = 0.45;
const MAX_CANVAS_ZOOM = 2.25;
const CANVAS_ZOOM_STEP = 0.1;
const CANVAS_NODE_WIDTH = 218;
const CANVAS_NODE_HEIGHT = 62;

const IcoCenterView = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <circle cx="12" cy="12" r="7" />
    <circle cx="12" cy="12" r="2" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
  </svg>
);

function newNode(title = "New node"): MindmapNode {
  return {
    id: createNodeId(),
    title,
    children: []
  };
}

function createNodeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function findNode(root: MindmapNode, id: string): MindmapNode | undefined {
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return undefined;
}

function updateNode(root: MindmapNode, id: string, updater: (node: MindmapNode) => MindmapNode): MindmapNode {
  if (root.id === id) return updater(root);
  return {
    ...root,
    children: (root.children ?? []).map((child) => updateNode(child, id, updater))
  };
}

function removeNode(root: MindmapNode, id: string): MindmapNode {
  return {
    ...root,
    children: (root.children ?? [])
      .filter((child) => child.id !== id)
      .map((child) => removeNode(child, id))
  };
}

function insertChild(root: MindmapNode, id: string): { root: MindmapNode; childId: string } {
  const child = newNode();
  return {
    childId: child.id,
    root: updateNode(root, id, (node) => ({
      ...node,
      collapsed: false,
      children: [...(node.children ?? []), child]
    }))
  };
}

function countNodes(root: MindmapNode): number {
  return 1 + (root.children ?? []).reduce((sum, child) => sum + countNodes(child), 0);
}

function clampCanvasZoom(value: number): number {
  return Math.min(MAX_CANVAS_ZOOM, Math.max(MIN_CANVAS_ZOOM, Number(value.toFixed(2))));
}

function layoutNodes(root: MindmapNode): { nodes: PositionedMindmapNode[]; width: number; height: number } {
  const nodes: PositionedMindmapNode[] = [];
  let row = 0;

  function walk(node: MindmapNode, depth: number, parentId?: string): void {
    const children = node.collapsed ? [] : (node.children ?? []);
    const startRow = row;
    if (children.length === 0) {
      row += 1;
    } else {
      for (const child of children) {
        walk(child, depth + 1, node.id);
      }
    }
    const endRow = Math.max(row - 1, startRow);
    nodes.push({
      node,
      depth,
      parentId,
      x: 64 + depth * 280,
      y: 70 + ((startRow + endRow) / 2) * 106
    });
  }

  walk(root, 0);
  return {
    nodes,
    width: Math.max(1320, ...nodes.map((item) => item.x + 260)),
    height: Math.max(760, ...nodes.map((item) => item.y + 110))
  };
}

function selectedProjectName(projects: ProjectRecord[], projectId: string | undefined): string | undefined {
  if (!projectId) return undefined;
  return projects.find((project) => project.id === projectId)?.name;
}

function contextMenuPosition(event: ReactMouseEvent): { x: number; y: number } {
  const margin = 8;
  const width = 220;
  const height = 170;
  const x = Math.max(margin, Math.min(event.clientX, window.innerWidth - width - margin));
  const y = Math.max(margin, Math.min(event.clientY, window.innerHeight - height - margin));
  return { x, y };
}

function extensionForFilename(filename: string): string {
  const match = filename.match(/\.[a-z0-9]+$/i);
  return match?.[0] ?? ".txt";
}

function pickerMimeType(mimeType: string): string {
  return mimeType.split(";")[0]?.trim() || "text/plain";
}

function isRasterExportFormat(format: MindmapUiExportFormat): format is RasterExportFormat {
  return format === "png" || format === "jpeg";
}

function extensionForExportFormat(format: MindmapUiExportFormat): string {
  if (format === "markdown") return "md";
  if (format === "jpeg") return "jpeg";
  return format;
}

function withFileExtension(filename: string, extension: string): string {
  const base = filename.trim() || "mindmap-export";
  return `${base.replace(/\.[a-z0-9]+$/i, "")}.${extension}`;
}

function splitArtifactUploadPath(pathValue: string | undefined): { directoryPath?: string; filename?: string } {
  const normalized = pathValue?.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized) return {};
  const parts = normalized.split("/").filter(Boolean);
  const filename = parts.pop();
  return {
    directoryPath: parts.length > 0 ? parts.join("/") : undefined,
    filename
  };
}

function parseSvgLength(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function svgDimensions(svgText: string): { width: number; height: number } {
  const parsed = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const svg = parsed.documentElement;
  const viewBox = svg.getAttribute("viewBox")?.split(/\s+/).map((part) => Number.parseFloat(part));
  const viewBoxWidth = viewBox && viewBox.length === 4 && Number.isFinite(viewBox[2]) ? viewBox[2] : undefined;
  const viewBoxHeight = viewBox && viewBox.length === 4 && Number.isFinite(viewBox[3]) ? viewBox[3] : undefined;
  return {
    width: Math.max(1, Math.ceil(parseSvgLength(svg.getAttribute("width")) ?? viewBoxWidth ?? 1200)),
    height: Math.max(1, Math.ceil(parseSvgLength(svg.getAttribute("height")) ?? viewBoxHeight ?? 800))
  };
}

async function rasterizeSvg(svgText: string, mimeType: "image/png" | "image/jpeg"): Promise<Blob> {
  const { width, height } = svgDimensions(svgText);
  const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is not available.");
  context.scale(scale, scale);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);

  const image = new Image();
  const svgBlob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Mindmap image could not be rendered."));
      image.src = url;
    });
    context.drawImage(image, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Mindmap image could not be encoded."));
      }, mimeType, mimeType === "image/jpeg" ? 0.92 : undefined);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function downloadBlobFile(filename: string, mimeType: string, blob: Blob): Promise<void> {
  if (await saveFileWithDialog(blob, filename).catch(() => false)) return;

  const savePicker = (window as WindowWithSavePicker).showSaveFilePicker;
  if (savePicker) {
    try {
      const acceptMimeType = pickerMimeType(mimeType);
      const handle = await savePicker({
        suggestedName: filename || "mindmap-export.txt",
        types: [{
          description: "Mindmap export",
          accept: { [acceptMimeType]: [extensionForFilename(filename)] }
        }]
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      throw error;
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename || "mindmap-export.txt";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function downloadTextFile(filename: string, mimeType: string, content: string): Promise<void> {
  const blob = new Blob([content], { type: mimeType || "text/plain;charset=utf-8" });
  await downloadBlobFile(filename, mimeType, blob);
}

export function MindmapsPage() {
  const [documents, setDocuments] = useState<MindmapDocument[]>([]);
  const [activeDocument, setActiveDocument] = useState<MindmapDocument | undefined>();
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [query, setQuery] = useState("");
  const [modeFilter, setModeFilter] = useState<"" | MindmapMode>("");
  const [projectFilter, setProjectFilter] = useState("");
  const [newTitle, setNewTitle] = useState("New Mindmap");
  const [newMode, setNewMode] = useState<MindmapMode>("mindmap");
  const [newProjectId, setNewProjectId] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [activePanel, setActivePanel] = useState<MindmapPanel>(null);
  const [nodeMenu, setNodeMenu] = useState<NodeContextMenu>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<MindmapUiExportFormat>("markdown");
  const [exportDestination, setExportDestination] = useState<ExportDestination>("download");
  const [artifactProjectId, setArtifactProjectId] = useState("");
  const [artifactPath, setArtifactPath] = useState("");
  const [editingNodeId, setEditingNodeId] = useState("");
  const [editingNodeTitle, setEditingNodeTitle] = useState("");
  const [canvasZoom, setCanvasZoom] = useState(1);
  const [isCanvasPanning, setIsCanvasPanning] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [error, setError] = useState("");
  const inlineTitleInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const canvasPanRef = useRef<CanvasPanState | null>(null);
  const suppressCanvasClickRef = useRef(false);

  const canvasLayout = useMemo(() => {
    if (!activeDocument) return undefined;
    return layoutNodes(activeDocument.body.root);
  }, [activeDocument]);

  const nodeById = useMemo(() => {
    const map = new Map<string, PositionedMindmapNode>();
    for (const item of canvasLayout?.nodes ?? []) {
      map.set(item.node.id, item);
    }
    return map;
  }, [canvasLayout]);

  const selectedNode = useMemo(() => {
    if (!activeDocument || !selectedNodeId) return undefined;
    return findNode(activeDocument.body.root, selectedNodeId);
  }, [activeDocument, selectedNodeId]);

  const totalNodeCount = useMemo(() => {
    if (!activeDocument) return 0;
    return countNodes(activeDocument.body.root);
  }, [activeDocument]);

  const menuNode = useMemo(() => {
    if (!activeDocument || !nodeMenu) return undefined;
    return findNode(activeDocument.body.root, nodeMenu.nodeId);
  }, [activeDocument, nodeMenu]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === activeDocument?.projectId),
    [activeDocument?.projectId, projects]
  );

  const filteredDocuments = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return documents.filter((document) => {
      if (modeFilter && document.mode !== modeFilter) return false;
      if (projectFilter && document.projectId !== projectFilter) return false;
      if (!normalizedQuery) return true;
      const haystack = [
        document.title,
        document.description ?? "",
        document.projectName ?? "",
        ...document.tags
      ].join(" ").toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [documents, modeFilter, projectFilter, query]);

  useEffect(() => {
    if (!nodeMenu) return;
    const close = () => setNodeMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNodeMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [nodeMenu]);

  useEffect(() => {
    setEditingNodeId("");
    setEditingNodeTitle("");
    setCanvasZoom(1);
    setIsCanvasPanning(false);
    canvasPanRef.current = null;
    suppressCanvasClickRef.current = false;
  }, [activeDocument?.id]);

  useEffect(() => {
    if (!editingNodeId) return;
    inlineTitleInputRef.current?.focus();
    inlineTitleInputRef.current?.select();
  }, [editingNodeId]);

  async function loadDocuments(nextActiveId?: string): Promise<void> {
    setIsLoading(true);
    setError("");
    try {
      const [listResult, projectResult] = await Promise.all([
        mindmapsApi.list({ limit: 100 }),
        projectsApi.list(undefined, "active", 100)
      ]);
      setDocuments(listResult.items);
      setProjects(projectResult.items);
      const nextActive =
        listResult.items.find((document) => document.id === nextActiveId) ??
        listResult.items.find((document) => document.id === activeDocument?.id) ??
        listResult.items[0];
      setActiveDocument(nextActive);
      setSelectedNodeId(nextActive?.body.root.id ?? "");
      setArtifactProjectId(nextActive?.projectId ?? "");
      setInspectorOpen(false);
      setEditingNodeId("");
      setEditingNodeTitle("");
      setIsDirty(false);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Mindmaps could not be loaded.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadDocuments();
  }, []);

  function togglePanel(panel: Exclude<MindmapPanel, null>): void {
    setNodeMenu(null);
    setActivePanel((current) => (current === panel ? null : panel));
  }

  function patchActive(updater: (document: MindmapDocument) => MindmapDocument): void {
    setActiveDocument((current) => {
      if (!current) return current;
      const next = updater(current);
      setDocuments((items) => items.map((item) => (item.id === next.id ? next : item)));
      return next;
    });
    setIsDirty(true);
  }

  async function createDocument(): Promise<void> {
    const title = newTitle.trim();
    if (!title) return;
    setIsSaving(true);
    setError("");
    try {
      const projectName = selectedProjectName(projects, newProjectId);
      const created = await mindmapsApi.create({
        title,
        mode: newMode,
        template: newMode,
        projectId: newProjectId || undefined,
        projectName
      });
      setDocuments((items) => [created, ...items]);
      setActiveDocument(created);
      setSelectedNodeId(created.body.root.id);
      setArtifactProjectId(created.projectId ?? "");
      setInspectorOpen(false);
      setEditingNodeId("");
      setEditingNodeTitle("");
      setActivePanel(null);
      setNewTitle(newMode === "logical_tree" ? "New Logical Tree" : "New Mindmap");
      setIsDirty(false);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Mindmap could not be created.");
    } finally {
      setIsSaving(false);
    }
  }

  async function saveDocument(): Promise<void> {
    if (!activeDocument) return;
    setIsSaving(true);
    setError("");
    try {
      const saved = await mindmapsApi.update(activeDocument.id, {
        title: activeDocument.title,
        description: activeDocument.description,
        mode: activeDocument.mode,
        projectId: activeDocument.projectId ?? null,
        projectName: activeDocument.projectName ?? null,
        body: activeDocument.body,
        tags: activeDocument.tags,
        expectedVersion: activeDocument.version
      });
      setActiveDocument(saved);
      setDocuments((items) => items.map((item) => (item.id === saved.id ? saved : item)));
      setSelectedNodeId((current) => (current && findNode(saved.body.root, current) ? current : saved.body.root.id));
      setArtifactProjectId(saved.projectId ?? artifactProjectId);
      setIsDirty(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Mindmap could not be saved.");
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteDocument(): Promise<void> {
    if (!activeDocument) return;
    setIsSaving(true);
    setError("");
    try {
      await mindmapsApi.remove(activeDocument.id);
      const remaining = documents.filter((document) => document.id !== activeDocument.id);
      setDocuments(remaining);
      setActiveDocument(remaining[0]);
      setSelectedNodeId(remaining[0]?.body.root.id ?? "");
      setArtifactProjectId(remaining[0]?.projectId ?? "");
      setInspectorOpen(false);
      setActivePanel(null);
      setIsDirty(false);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Mindmap could not be deleted.");
    } finally {
      setIsSaving(false);
    }
  }

  async function saveArtifact(): Promise<void> {
    if (!activeDocument) return;
    setIsSaving(true);
    setError("");
    try {
      if (isRasterExportFormat(exportFormat)) {
        const projectId = artifactProjectId || activeDocument.projectId;
        if (!projectId) throw new Error("Project is required for PNG/JPEG artifact export.");
        const exportedSvg = await mindmapsApi.exportContent(activeDocument.id, "svg");
        const mimeType = exportFormat === "png" ? "image/png" : "image/jpeg";
        const blob = await rasterizeSvg(exportedSvg.contentText, mimeType);
        const { directoryPath, filename } = splitArtifactUploadPath(artifactPath);
        const projectName = selectedProjectName(projects, projectId) ?? (projectId === activeDocument.projectId ? activeDocument.projectName : undefined);
        const file = new File([blob], filename || withFileExtension(exportedSvg.filename, extensionForExportFormat(exportFormat)), {
          type: mimeType
        });
        await artifactsApi.uploadFile({
          projectId,
          projectName,
          directoryPath: directoryPath ?? "mindmaps",
          scope: "project",
          tags: ["mindmap-export", activeDocument.mode === "logical_tree" ? "logical-tree" : "mindmap"],
          file
        });
        return;
      }

      const projectName = selectedProjectName(projects, artifactProjectId) ?? activeDocument.projectName;
      await mindmapsApi.saveArtifact(activeDocument.id, {
        format: exportFormat,
        artifactTitle: activeDocument.title,
        artifactPath: artifactPath.trim() || undefined,
        projectId: artifactProjectId || activeDocument.projectId,
        projectName
      });
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Artifact could not be saved.");
    } finally {
      setIsSaving(false);
    }
  }

  async function downloadExport(): Promise<void> {
    if (!activeDocument) return;
    setIsSaving(true);
    setError("");
    try {
      if (isRasterExportFormat(exportFormat)) {
        const exportedSvg = await mindmapsApi.exportContent(activeDocument.id, "svg");
        const mimeType = exportFormat === "png" ? "image/png" : "image/jpeg";
        const blob = await rasterizeSvg(exportedSvg.contentText, mimeType);
        await downloadBlobFile(withFileExtension(exportedSvg.filename, extensionForExportFormat(exportFormat)), mimeType, blob);
        return;
      }

      const exported = await mindmapsApi.exportContent(activeDocument.id, exportFormat);
      await downloadTextFile(exported.filename, exported.mimeType, exported.contentText);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "Mindmap could not be downloaded.");
    } finally {
      setIsSaving(false);
    }
  }

  function patchBody(updater: (body: MindmapDocumentBody) => MindmapDocumentBody): void {
    patchActive((document) => ({
      ...document,
      body: updater(document.body)
    }));
  }

  function selectNode(nodeId: string): void {
    setSelectedNodeId(nodeId);
    setInspectorOpen(true);
    setActivePanel(null);
    setNodeMenu(null);
  }

  function updateSelectedNode(updater: (node: MindmapNode) => MindmapNode): void {
    if (!activeDocument || !selectedNodeId) return;
    patchBody((body) => ({
      ...body,
      root: updateNode(body.root, selectedNodeId, updater)
    }));
  }

  function beginNodeTitleEdit(nodeId: string): void {
    if (!activeDocument) return;
    const node = findNode(activeDocument.body.root, nodeId);
    if (!node) return;
    setSelectedNodeId(nodeId);
    setEditingNodeId(nodeId);
    setEditingNodeTitle(node.title);
    setInspectorOpen(false);
    setActivePanel(null);
    setNodeMenu(null);
  }

  function cancelNodeTitleEdit(): void {
    setEditingNodeId("");
    setEditingNodeTitle("");
  }

  function commitNodeTitleEdit(): void {
    if (!activeDocument || !editingNodeId) {
      cancelNodeTitleEdit();
      return;
    }

    const currentNode = findNode(activeDocument.body.root, editingNodeId);
    const nextTitle = editingNodeTitle.trim();
    if (currentNode && nextTitle && nextTitle !== currentNode.title) {
      patchBody((body) => ({
        ...body,
        root: updateNode(body.root, editingNodeId, (node) => ({ ...node, title: nextTitle }))
      }));
    }

    cancelNodeTitleEdit();
  }

  function toggleNodeCollapsed(nodeId: string): void {
    if (!activeDocument) return;
    patchBody((body) => ({
      ...body,
      root: updateNode(body.root, nodeId, (node) => ({ ...node, collapsed: !node.collapsed }))
    }));
  }

  function addChildToNode(nodeId: string): void {
    if (!activeDocument) return;
    const inserted = insertChild(activeDocument.body.root, nodeId);
    patchBody((body) => ({ ...body, root: inserted.root }));
    setSelectedNodeId(inserted.childId);
    setInspectorOpen(false);
    setActivePanel(null);
    setEditingNodeId(inserted.childId);
    setEditingNodeTitle("New node");
  }

  function addChildToSelected(): void {
    if (!selectedNodeId) return;
    addChildToNode(selectedNodeId);
  }

  function deleteNodeById(nodeId: string): void {
    if (!activeDocument || nodeId === activeDocument.body.root.id) return;
    patchBody((body) => ({
      ...body,
      root: removeNode(body.root, nodeId)
    }));
    setSelectedNodeId(activeDocument.body.root.id);
    setInspectorOpen(true);
    setEditingNodeId("");
    setEditingNodeTitle("");
  }

  function deleteSelectedNode(): void {
    if (!selectedNodeId) return;
    deleteNodeById(selectedNodeId);
  }

  function openNodeMenu(event: ReactMouseEvent, nodeId: string): void {
    event.preventDefault();
    event.stopPropagation();
    setSelectedNodeId(nodeId);
    setInspectorOpen(true);
    setActivePanel(null);
    const { x, y } = contextMenuPosition(event);
    setNodeMenu({ nodeId, x, y });
  }

  function handleCanvasWheel(event: ReactWheelEvent<HTMLDivElement>): void {
    if (!event.shiftKey || !activeDocument) return;
    const target = event.target instanceof HTMLElement ? event.target : undefined;
    if (target?.closest("input, textarea, select")) return;

    event.preventDefault();
    event.stopPropagation();
    setNodeMenu(null);

    const container = event.currentTarget;
    const rect = container.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const contentX = (container.scrollLeft + pointerX) / canvasZoom;
    const contentY = (container.scrollTop + pointerY) / canvasZoom;
    const wheelDelta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (wheelDelta === 0) return;
    const direction = wheelDelta < 0 ? 1 : -1;
    const nextZoom = clampCanvasZoom(canvasZoom + direction * CANVAS_ZOOM_STEP);
    if (nextZoom === canvasZoom) return;

    setCanvasZoom(nextZoom);
    window.requestAnimationFrame(() => {
      container.scrollLeft = Math.max(0, contentX * nextZoom - pointerX);
      container.scrollTop = Math.max(0, contentY * nextZoom - pointerY);
    });
  }

  function centerCanvasView(): void {
    const container = canvasRef.current;
    if (!container || !canvasLayout?.nodes.length) return;
    setNodeMenu(null);

    const minX = Math.min(...canvasLayout.nodes.map((item) => item.x));
    const maxX = Math.max(...canvasLayout.nodes.map((item) => item.x + CANVAS_NODE_WIDTH));
    const minY = Math.min(...canvasLayout.nodes.map((item) => item.y));
    const maxY = Math.max(...canvasLayout.nodes.map((item) => item.y + CANVAS_NODE_HEIGHT));
    const centerX = ((minX + maxX) / 2) * canvasZoom;
    const centerY = ((minY + maxY) / 2) * canvasZoom;
    const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);

    container.scrollTo({
      left: Math.min(maxScrollLeft, Math.max(0, centerX - container.clientWidth / 2)),
      top: Math.min(maxScrollTop, Math.max(0, centerY - container.clientHeight / 2)),
      behavior: "smooth"
    });
  }

  function canStartCanvasPan(event: ReactPointerEvent<HTMLDivElement>): boolean {
    if (!activeDocument || event.button !== 0) return false;
    const target = event.target instanceof HTMLElement ? event.target : undefined;
    return !Boolean(target?.closest(".mindmaps-node, input, textarea, select, button, a"));
  }

  function handleCanvasPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!canStartCanvasPan(event)) return;
    event.preventDefault();
    setNodeMenu(null);
    canvasPanRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: event.currentTarget.scrollLeft,
      scrollTop: event.currentTarget.scrollTop,
      hasMoved: false
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsCanvasPanning(true);
  }

  function handleCanvasPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const pan = canvasPanRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    event.preventDefault();
    const deltaX = event.clientX - pan.startX;
    const deltaY = event.clientY - pan.startY;
    if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
      pan.hasMoved = true;
    }
    event.currentTarget.scrollLeft = pan.scrollLeft - deltaX;
    event.currentTarget.scrollTop = pan.scrollTop - deltaY;
  }

  function finishCanvasPan(container: HTMLDivElement, pointerId: number): void {
    const pan = canvasPanRef.current;
    if (!pan || pan.pointerId !== pointerId) return;
    if (container.hasPointerCapture(pointerId)) {
      container.releasePointerCapture(pointerId);
    }
    if (pan.hasMoved) {
      suppressCanvasClickRef.current = true;
      window.setTimeout(() => {
        suppressCanvasClickRef.current = false;
      }, 0);
    }
    canvasPanRef.current = null;
    setIsCanvasPanning(false);
  }

  function handleCanvasClick(): void {
    if (suppressCanvasClickRef.current) {
      suppressCanvasClickRef.current = false;
      return;
    }
    setNodeMenu(null);
  }

  function renderPanel() {
    if (!activePanel) return null;

    const panelTitles: Record<Exclude<MindmapPanel, null>, string> = {
      documents: "Documents",
      create: "Create",
      settings: "Map settings",
      export: "Export"
    };

    return (
      <aside className="mindmaps-floating-panel" aria-label={panelTitles[activePanel]} onClick={(event) => event.stopPropagation()}>
        <div className="mindmaps-panel-head">
          <strong>{panelTitles[activePanel]}</strong>
          <button type="button" className="mindmaps-tool-button" onClick={() => setActivePanel(null)} aria-label="Close panel" title="Close">
            <IcoX />
          </button>
        </div>

        {activePanel === "documents" ? (
          <>
            <div className="mindmaps-filter-grid">
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" aria-label="Search mindmaps" />
              <select value={modeFilter} onChange={(event) => setModeFilter(event.target.value as "" | MindmapMode)}>
                <option value="">All modes</option>
                <option value="mindmap">Mindmap</option>
                <option value="logical_tree">Logical Tree</option>
              </select>
              <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}>
                <option value="">All projects</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="mindmaps-document-list">
              {filteredDocuments.map((document) => (
                <button
                  key={document.id}
                  type="button"
                  className={activeDocument?.id === document.id ? "active" : ""}
                  onClick={() => {
                    setActiveDocument(document);
                    setSelectedNodeId(document.body.root.id);
                    setArtifactProjectId(document.projectId ?? "");
                    setInspectorOpen(false);
                    setIsDirty(false);
                    setActivePanel(null);
                  }}
                >
                  <span>{document.title}</span>
                  <small>
                    {modeLabels[document.mode]} / {formatDateTime(document.updatedAt)}
                  </small>
                </button>
              ))}
              {!isLoading && filteredDocuments.length === 0 ? <div className="mindmaps-empty">No documents</div> : null}
            </div>
          </>
        ) : null}

        {activePanel === "create" ? (
          <div className="mindmaps-create">
            <input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} aria-label="New mindmap title" />
            <div className="mindmaps-segment">
              {(["mindmap", "logical_tree"] as MindmapMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={newMode === mode ? "active" : ""}
                  onClick={() => {
                    setNewMode(mode);
                    setNewTitle(mode === "logical_tree" ? "New Logical Tree" : "New Mindmap");
                  }}
                >
                  {modeLabels[mode]}
                </button>
              ))}
            </div>
            <select value={newProjectId} onChange={(event) => setNewProjectId(event.target.value)} aria-label="Project for new mindmap">
              <option value="">No project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <button className="mindmaps-primary" type="button" onClick={() => void createDocument()} disabled={isSaving}>
              <IcoPlus />
              Create
            </button>
          </div>
        ) : null}

        {activePanel === "settings" ? (
          <div className="mindmaps-settings-form">
            <label>
              Title
              <input
                value={activeDocument?.title ?? ""}
                onChange={(event) => patchActive((document) => ({ ...document, title: event.target.value }))}
                placeholder="Title"
                disabled={!activeDocument}
                aria-label="Mindmap title"
              />
            </label>
            <label>
              Project
              <select
                value={activeDocument?.projectId ?? ""}
                onChange={(event) => {
                  const projectId = event.target.value;
                  const projectName = selectedProjectName(projects, projectId);
                  patchActive((document) => ({
                    ...document,
                    projectId: projectId || undefined,
                    projectName
                  }));
                  setArtifactProjectId(projectId);
                }}
                disabled={!activeDocument}
                aria-label="Project"
              >
                <option value="">No project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}

        {activePanel === "export" ? (
          <div className="mindmaps-export">
            <div className="mindmaps-segment">
              <button
                type="button"
                className={exportDestination === "download" ? "active" : ""}
                onClick={() => setExportDestination("download")}
              >
                Download
              </button>
              <button
                type="button"
                className={exportDestination === "artifact" ? "active" : ""}
                onClick={() => setExportDestination("artifact")}
              >
                Artifact
              </button>
            </div>
            <select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as MindmapUiExportFormat)}>
              <option value="markdown">Markdown</option>
              <option value="svg">SVG</option>
              <option value="png">PNG</option>
              <option value="jpeg">JPEG</option>
              <option value="json">JSON</option>
            </select>
            {exportDestination === "artifact" ? (
              <>
                <label>
                  Project
                  <select value={artifactProjectId} onChange={(event) => setArtifactProjectId(event.target.value)} aria-label="Artifact project">
                    <option value="">Current or default project</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Path
                  <input
                    value={artifactPath}
                    onChange={(event) => setArtifactPath(event.target.value)}
                    placeholder={`mindmaps/example.${extensionForExportFormat(exportFormat)}`}
                  />
                </label>
                <button type="button" onClick={() => void saveArtifact()} disabled={!activeDocument || isSaving}>
                  <IcoDownload />
                  Save Artifact
                </button>
              </>
            ) : (
              <button type="button" onClick={() => void downloadExport()} disabled={!activeDocument || isSaving}>
                <IcoDownload />
                Download
              </button>
            )}
          </div>
        ) : null}
      </aside>
    );
  }

  return (
    <main className="mindmaps-page">
      <section className="mindmaps-board" aria-label="Mindmap canvas">
        <div className="mindmaps-toolbar">
          <div className="mindmaps-current">
            <strong>{activeDocument?.title ?? "Mindmap"}</strong>
            <span>
              {activeDocument ? modeLabels[activeDocument.mode] : "No document"}
              {selectedProject ? ` / ${selectedProject.name}` : ""}
              {activeDocument ? ` / ${Math.round(canvasZoom * 100)}%` : ""}
            </span>
          </div>

          <div className="mindmaps-actions">
            <button
              type="button"
              className={activePanel === "documents" ? "mindmaps-tool-button active" : "mindmaps-tool-button"}
              onClick={() => togglePanel("documents")}
              aria-label="Open documents"
              title="Documents"
            >
              <IcoList />
            </button>
            <button
              type="button"
              className={activePanel === "create" ? "mindmaps-tool-button active" : "mindmaps-tool-button"}
              onClick={() => togglePanel("create")}
              aria-label="Create mindmap"
              title="Create"
            >
              <IcoPlus />
            </button>
            <button
              type="button"
              className={activePanel === "settings" ? "mindmaps-tool-button active" : "mindmaps-tool-button"}
              onClick={() => togglePanel("settings")}
              aria-label="Map settings"
              title="Map settings"
              disabled={!activeDocument}
            >
              <IcoSettings />
            </button>
            <button
              type="button"
              className={activePanel === "export" ? "mindmaps-tool-button active" : "mindmaps-tool-button"}
              onClick={() => togglePanel("export")}
              aria-label="Export"
              title="Export"
              disabled={!activeDocument}
            >
              <IcoDownload />
            </button>
            <button
              type="button"
              className="mindmaps-tool-button"
              onClick={centerCanvasView}
              aria-label="Center view"
              title="Center view"
              disabled={!activeDocument}
            >
              <IcoCenterView />
            </button>
            <button type="button" className="mindmaps-tool-button" onClick={() => void loadDocuments()} aria-label="Refresh" title="Refresh">
              <IcoRefresh />
            </button>
            <button
              type="button"
              className="mindmaps-tool-button"
              onClick={() => void saveDocument()}
              disabled={!activeDocument || isSaving}
              aria-label="Save"
              title="Save"
            >
              <IcoFloppy />
            </button>
            <button
              type="button"
              className="mindmaps-tool-button danger"
              onClick={() => void deleteDocument()}
              disabled={!activeDocument || isSaving}
              aria-label="Delete map"
              title="Delete map"
            >
              <IcoTrash />
            </button>
          </div>
        </div>

        {renderPanel()}
        {error ? <div className="mindmaps-error">{error}</div> : null}

        <div
          ref={canvasRef}
          className={`mindmaps-canvas ${isCanvasPanning ? "panning" : ""}`}
          onWheel={handleCanvasWheel}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={(event) => finishCanvasPan(event.currentTarget, event.pointerId)}
          onPointerCancel={(event) => finishCanvasPan(event.currentTarget, event.pointerId)}
          onLostPointerCapture={(event) => finishCanvasPan(event.currentTarget, event.pointerId)}
          onClick={handleCanvasClick}
        >
          {activeDocument && canvasLayout ? (
            <>
              <div
                className="mindmaps-canvas-viewport"
                style={{ width: canvasLayout.width * canvasZoom, height: canvasLayout.height * canvasZoom }}
              >
                <div
                  className="mindmaps-canvas-inner"
                  style={{ width: canvasLayout.width, height: canvasLayout.height, transform: `scale(${canvasZoom})` }}
                >
                  <svg className="mindmaps-lines" width={canvasLayout.width} height={canvasLayout.height} aria-hidden="true">
                    {canvasLayout.nodes
                      .filter((item) => item.parentId)
                      .map((item) => {
                        const parent = nodeById.get(item.parentId!);
                        if (!parent) return null;
                        return (
                          <path
                            key={`${item.parentId}-${item.node.id}`}
                            d={`M${parent.x + 218} ${parent.y + 30} C${parent.x + 262} ${parent.y + 30}, ${item.x - 60} ${item.y + 30}, ${item.x} ${item.y + 30}`}
                          />
                        );
                      })}
                  </svg>
                  {canvasLayout.nodes.map((item) => {
                    const isEditing = editingNodeId === item.node.id;
                    return (
                      <div
                        key={item.node.id}
                        role="button"
                        tabIndex={0}
                        className={`mindmaps-node ${item.depth === 0 ? "root" : ""} ${selectedNodeId === item.node.id ? "selected" : ""} ${isEditing ? "editing" : ""}`}
                        style={{ left: item.x, top: item.y }}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (!isEditing) selectNode(item.node.id);
                        }}
                        onDoubleClick={(event) => {
                          event.stopPropagation();
                          beginNodeTitleEdit(item.node.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            beginNodeTitleEdit(item.node.id);
                          }
                          if (event.key === " ") {
                            event.preventDefault();
                            selectNode(item.node.id);
                          }
                        }}
                        onContextMenu={(event) => openNodeMenu(event, item.node.id)}
                      >
                        {isEditing ? (
                          <input
                            ref={inlineTitleInputRef}
                            className="mindmaps-node-title-input"
                            value={editingNodeTitle}
                            onChange={(event) => setEditingNodeTitle(event.target.value)}
                            onClick={(event) => event.stopPropagation()}
                            onDoubleClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => {
                              event.stopPropagation();
                              if (event.key === "Enter") {
                                event.preventDefault();
                                commitNodeTitleEdit();
                              }
                              if (event.key === "Escape") {
                                event.preventDefault();
                                cancelNodeTitleEdit();
                              }
                            }}
                            onBlur={commitNodeTitleEdit}
                            aria-label="Node title"
                          />
                        ) : (
                          <span>{item.node.title}</span>
                        )}
                        {item.node.note && !isEditing ? <small>{item.node.note}</small> : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          ) : (
            <div className="mindmaps-canvas-empty">
              <button type="button" onClick={() => togglePanel("create")}>
                <IcoPlus />
                Create
              </button>
            </div>
          )}
        </div>

        {nodeMenu && menuNode ? (
          <div
            className="mindmaps-context-menu"
            style={{ left: nodeMenu.x, top: nodeMenu.y }}
            role="menu"
            aria-label="Node menu"
            onClick={(event) => event.stopPropagation()}
          >
            <button type="button" role="menuitem" onClick={() => beginNodeTitleEdit(nodeMenu.nodeId)}>
              Rename
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                addChildToNode(nodeMenu.nodeId);
                setNodeMenu(null);
              }}
            >
              Add child
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                toggleNodeCollapsed(nodeMenu.nodeId);
                setNodeMenu(null);
              }}
            >
              {menuNode.collapsed ? "Expand" : "Collapse"}
            </button>
            <button
              type="button"
              role="menuitem"
              className="danger"
              disabled={nodeMenu.nodeId === activeDocument?.body.root.id}
              onClick={() => {
                deleteNodeById(nodeMenu.nodeId);
                setNodeMenu(null);
              }}
            >
              Delete
            </button>
          </div>
        ) : null}
      </section>

      {inspectorOpen && selectedNode ? (
        <aside className="mindmaps-inspector" aria-label="Node settings">
          <div className="mindmaps-panel-head">
            <div>
              <p className="eyebrow">Node</p>
              <strong>{selectedNode.title}</strong>
            </div>
            <button type="button" className="mindmaps-tool-button" onClick={() => setInspectorOpen(false)} aria-label="Close node settings" title="Close">
              <IcoX />
            </button>
          </div>

          <label>
            Note
            <textarea
              value={selectedNode.note ?? ""}
              onChange={(event) => updateSelectedNode((node) => ({ ...node, note: event.target.value }))}
            />
          </label>

          <div className="mindmaps-inspector-actions">
            <button type="button" onClick={addChildToSelected}>
              <IcoPlus />
              Child
            </button>
            <button type="button" onClick={() => toggleNodeCollapsed(selectedNode.id)}>
              {selectedNode.collapsed ? "Expand" : "Collapse"}
            </button>
          </div>

          <div className="mindmaps-inspector-footer">
            <div className="mindmaps-node-stats" aria-label="Node statistics">
              <div className="mindmaps-stat">
                <strong>{totalNodeCount}</strong>
                <span>Total nodes</span>
              </div>
              <div className="mindmaps-stat">
                <strong>{selectedNode.children?.length ?? 0}</strong>
                <span>Children</span>
              </div>
            </div>
            <button
              type="button"
              className="mindmaps-inspector-delete"
              onClick={deleteSelectedNode}
              disabled={selectedNode.id === activeDocument?.body.root.id}
              aria-label="Delete node"
              title="Delete node"
            >
              <IcoTrash />
            </button>
          </div>
        </aside>
      ) : null}
    </main>
  );
}
