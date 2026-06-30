import { useEffect, useMemo, useState } from "react";
import { IcoDownload, IcoPlus, IcoRefresh, IcoTrash } from "../tasks/components/icons";
import { IcoFloppy } from "../artifacts/components/ArtifactsIcons";
import { mindmapsApi, projectsApi } from "../lib/api";
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

const modeLabels: Record<MindmapMode, string> = {
  mindmap: "Mindmap",
  logical_tree: "Logical Tree"
};

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
      x: 36 + depth * 240,
      y: 42 + ((startRow + endRow) / 2) * 92
    });
  }

  walk(root, 0);
  return {
    nodes,
    width: Math.max(900, ...nodes.map((item) => item.x + 220)),
    height: Math.max(520, ...nodes.map((item) => item.y + 86))
  };
}

function selectedProjectName(projects: ProjectRecord[], projectId: string | undefined): string | undefined {
  if (!projectId) return undefined;
  return projects.find((project) => project.id === projectId)?.name;
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
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [exportFormat, setExportFormat] = useState<MindmapExportFormat>("markdown");
  const [artifactPath, setArtifactPath] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

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

  function patchActive(updater: (document: MindmapDocument) => MindmapDocument): void {
    setActiveDocument((current) => {
      if (!current) return current;
      const next = updater(current);
      setDocuments((items) => items.map((item) => (item.id === next.id ? next : item)));
      return next;
    });
    setIsDirty(true);
    setStatus("");
  }

  async function createDocument(): Promise<void> {
    const title = newTitle.trim();
    if (!title) return;
    setIsSaving(true);
    setError("");
    try {
      const projectName = selectedProjectName(projects, projectFilter);
      const created = await mindmapsApi.create({
        title,
        mode: newMode,
        template: newMode,
        projectId: projectFilter || undefined,
        projectName
      });
      setDocuments((items) => [created, ...items]);
      setActiveDocument(created);
      setSelectedNodeId(created.body.root.id);
      setNewTitle(newMode === "logical_tree" ? "New Logical Tree" : "New Mindmap");
      setIsDirty(false);
      setStatus("Created");
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
      setIsDirty(false);
      setStatus("Saved");
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
      setIsDirty(false);
      setStatus("Deleted");
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
      await mindmapsApi.saveArtifact(activeDocument.id, {
        format: exportFormat,
        artifactTitle: activeDocument.title,
        artifactPath: artifactPath.trim() || undefined,
        projectId: activeDocument.projectId,
        projectName: activeDocument.projectName
      });
      setStatus("Artifact saved");
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Artifact could not be saved.");
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

  function updateSelectedNode(updater: (node: MindmapNode) => MindmapNode): void {
    if (!activeDocument || !selectedNodeId) return;
    patchBody((body) => ({
      ...body,
      root: updateNode(body.root, selectedNodeId, updater)
    }));
  }

  function addChildToSelected(): void {
    if (!activeDocument || !selectedNodeId) return;
    const inserted = insertChild(activeDocument.body.root, selectedNodeId);
    patchBody((body) => ({ ...body, root: inserted.root }));
    setSelectedNodeId(inserted.childId);
  }

  function deleteSelectedNode(): void {
    if (!activeDocument || !selectedNodeId || selectedNodeId === activeDocument.body.root.id) return;
    patchBody((body) => ({
      ...body,
      root: removeNode(body.root, selectedNodeId)
    }));
    setSelectedNodeId(activeDocument.body.root.id);
  }

  return (
    <main className="mindmaps-page">
      <section className="mindmaps-sidebar" aria-label="Mindmap documents">
        <div className="mindmaps-section-head">
          <div>
            <p className="eyebrow">Tool</p>
            <h1>Mindmap</h1>
          </div>
          <button className="mindmaps-icon-button" type="button" onClick={() => void loadDocuments()} title="Refresh">
            <IcoRefresh />
          </button>
        </div>

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
          <button className="mindmaps-primary" type="button" onClick={() => void createDocument()} disabled={isSaving}>
            <IcoPlus />
            Create
          </button>
        </div>

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
                setIsDirty(false);
                setStatus("");
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
      </section>

      <section className="mindmaps-board" aria-label="Mindmap canvas">
        <div className="mindmaps-toolbar">
          <div className="mindmaps-title-fields">
            <input
              value={activeDocument?.title ?? ""}
              onChange={(event) => patchActive((document) => ({ ...document, title: event.target.value }))}
              placeholder="Title"
              disabled={!activeDocument}
              aria-label="Mindmap title"
            />
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
          </div>

          <div className="mindmaps-actions">
            <span className={isDirty ? "mindmaps-status dirty" : "mindmaps-status"}>{isDirty ? "Unsaved" : status || "Ready"}</span>
            <button type="button" className="mindmaps-secondary" onClick={() => void saveDocument()} disabled={!activeDocument || isSaving}>
              <IcoFloppy />
              Save
            </button>
            <button type="button" className="mindmaps-danger" onClick={() => void deleteDocument()} disabled={!activeDocument || isSaving}>
              <IcoTrash />
            </button>
          </div>
        </div>

        {error ? <div className="mindmaps-error">{error}</div> : null}

        <div className="mindmaps-canvas">
          {activeDocument && canvasLayout ? (
            <div className="mindmaps-canvas-inner" style={{ width: canvasLayout.width, height: canvasLayout.height }}>
              <svg className="mindmaps-lines" width={canvasLayout.width} height={canvasLayout.height} aria-hidden="true">
                {canvasLayout.nodes
                  .filter((item) => item.parentId)
                  .map((item) => {
                    const parent = nodeById.get(item.parentId!);
                    if (!parent) return null;
                    return (
                      <path
                        key={`${item.parentId}-${item.node.id}`}
                        d={`M${parent.x + 180} ${parent.y + 26} C${parent.x + 220} ${parent.y + 26}, ${item.x - 52} ${item.y + 26}, ${item.x} ${item.y + 26}`}
                      />
                    );
                  })}
              </svg>
              {canvasLayout.nodes.map((item) => (
                <button
                  key={item.node.id}
                  type="button"
                  className={`mindmaps-node ${item.depth === 0 ? "root" : ""} ${selectedNodeId === item.node.id ? "selected" : ""}`}
                  style={{ left: item.x, top: item.y }}
                  onClick={() => setSelectedNodeId(item.node.id)}
                >
                  <span>{item.node.title}</span>
                  {item.node.note ? <small>{item.node.note}</small> : null}
                </button>
              ))}
            </div>
          ) : (
            <div className="mindmaps-canvas-empty">
              <button type="button" onClick={() => void createDocument()}>
                <IcoPlus />
                Create
              </button>
            </div>
          )}
        </div>
      </section>

      <aside className="mindmaps-inspector" aria-label="Mindmap inspector">
        <div className="mindmaps-section-head">
          <div>
            <p className="eyebrow">Node</p>
            <h2>{selectedNode?.title ?? "No selection"}</h2>
          </div>
          <span className="mindmaps-count">{activeDocument ? countNodes(activeDocument.body.root) : 0}</span>
        </div>

        <label>
          Title
          <input
            value={selectedNode?.title ?? ""}
            onChange={(event) => updateSelectedNode((node) => ({ ...node, title: event.target.value }))}
            disabled={!selectedNode}
          />
        </label>
        <label>
          Note
          <textarea
            value={selectedNode?.note ?? ""}
            onChange={(event) => updateSelectedNode((node) => ({ ...node, note: event.target.value }))}
            disabled={!selectedNode}
          />
        </label>

        <div className="mindmaps-inspector-actions">
          <button type="button" onClick={addChildToSelected} disabled={!selectedNode}>
            <IcoPlus />
            Child
          </button>
          <button
            type="button"
            onClick={() => updateSelectedNode((node) => ({ ...node, collapsed: !node.collapsed }))}
            disabled={!selectedNode}
          >
            {selectedNode?.collapsed ? "Expand" : "Collapse"}
          </button>
          <button
            type="button"
            className="danger"
            onClick={deleteSelectedNode}
            disabled={!selectedNode || selectedNode.id === activeDocument?.body.root.id}
          >
            <IcoTrash />
          </button>
        </div>

        <div className="mindmaps-export">
          <div className="mindmaps-section-head compact">
            <div>
              <p className="eyebrow">Artifact</p>
              <h2>Export</h2>
            </div>
            {selectedProject ? <span>{selectedProject.name}</span> : null}
          </div>
          <select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as MindmapExportFormat)}>
            <option value="markdown">Markdown note</option>
            <option value="svg">SVG file</option>
            <option value="json">JSON file</option>
          </select>
          <input value={artifactPath} onChange={(event) => setArtifactPath(event.target.value)} placeholder="mindmaps/example.md" />
          <button type="button" onClick={() => void saveArtifact()} disabled={!activeDocument || isSaving}>
            <IcoDownload />
            Save Artifact
          </button>
        </div>
      </aside>
    </main>
  );
}
