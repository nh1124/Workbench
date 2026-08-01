import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, DragEvent, MouseEvent as ReactMouseEvent } from "react";
import { IcoDownload, IcoList, IcoPlus, IcoRefresh, IcoTrash } from "../tasks/components/icons";
import { IcoClose, IcoFloppy, IcoPanelLeft, IcoSettings } from "../artifacts/components/ArtifactsIcons";
import { projectsApi, wbsApi } from "../lib/api";
import type {
  ProjectRecord,
  WbsExportFormat,
  WbsItem,
  WbsItemStatus,
  WbsPlan
} from "../types/models";
import {
  clampProgress,
  dropPositionForEvent,
  flattenWbsItems,
  isDescendantItem,
  isDirectEditTarget,
  isInsideWbsItem,
  numberOrUndefined,
  selectedProjectName,
  siblingRows,
  type WbsDropPosition
} from "./utils/wbsTree";
import { useWbsGridPan } from "./hooks/useWbsGridPan";
import "./WbsPage.css";

const statusLabels: Record<WbsItemStatus, string> = {
  todo: "Todo",
  doing: "Doing",
  blocked: "Blocked",
  done: "Done"
};

type WbsPanel = "plans" | "create" | "settings" | "item" | "export";

type WbsContextMenu = {
  itemId: string;
  x: number;
  y: number;
};

type WbsCanvasMenu = {
  x: number;
  y: number;
};

type WbsDropIntent = {
  draggedItemId: string;
  targetItemId: string;
  position: WbsDropPosition;
};

const IcoRootItem = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M12 5v14" />
    <path d="M5 12h14" />
    <rect x="4" y="4" width="6" height="6" rx="1.5" />
    <rect x="14" y="14" width="6" height="6" rx="1.5" />
  </svg>
);

const IcoSiblingItem = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M7 12h10" />
    <path d="M12 7v10" />
    <rect x="4" y="4" width="6" height="6" rx="1.5" />
    <rect x="14" y="4" width="6" height="6" rx="1.5" />
    <path d="M12 15h7" />
  </svg>
);

const IcoChildItem = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M8 9v6h8" />
    <path d="M16 11v8" />
    <path d="M12 15h8" />
    <rect x="4" y="4" width="8" height="6" rx="1.5" />
    <rect x="14" y="14" width="6" height="6" rx="1.5" />
  </svg>
);

export function WbsPage() {
  const [plans, setPlans] = useState<WbsPlan[]>([]);
  const [activePlan, setActivePlan] = useState<WbsPlan | undefined>();
  const [items, setItems] = useState<WbsItem[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [selectedItemId, setSelectedItemId] = useState("");
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [newPlanTitle, setNewPlanTitle] = useState("New WBS");
  const [newPlanProjectId, setNewPlanProjectId] = useState("");
  const [exportFormat, setExportFormat] = useState<WbsExportFormat>("markdown");
  const [artifactPath, setArtifactPath] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [error, setError] = useState("");
  const [activePanel, setActivePanel] = useState<WbsPanel | null>(null);
  const [contextMenu, setContextMenu] = useState<WbsContextMenu | null>(null);
  const [canvasMenu, setCanvasMenu] = useState<WbsCanvasMenu | null>(null);
  const [draggedItemId, setDraggedItemId] = useState("");
  const [dropIntent, setDropIntent] = useState<WbsDropIntent | null>(null);
  const {
    wbsZoom,
    isGridPanning,
    handleGridWheel,
    handleGridPointerDown,
    handleGridPointerMove,
    finishGridPan,
    handleGridClick
  } = useWbsGridPan(() => {
    setContextMenu(null);
    setCanvasMenu(null);
  });

  const rows = useMemo(() => flattenWbsItems(items), [items]);
  const selectedItem = useMemo(() => items.find((item) => item.id === selectedItemId), [items, selectedItemId]);
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === activePlan?.projectId),
    [activePlan?.projectId, projects]
  );
  const selectedChildCount = selectedItem ? items.filter((item) => item.parentId === selectedItem.id).length : 0;

  const filteredPlans = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return plans.filter((plan) => {
      if (projectFilter && plan.projectId !== projectFilter) return false;
      if (!normalized) return true;
      return [plan.title, plan.description ?? "", plan.projectName ?? ""].join(" ").toLowerCase().includes(normalized);
    });
  }, [plans, projectFilter, query]);

  async function loadItems(planId: string, nextSelectedId?: string): Promise<void> {
    const loaded = await wbsApi.listItems(planId);
    setItems(loaded);
    const nextSelected = nextSelectedId && loaded.some((item) => item.id === nextSelectedId)
      ? nextSelectedId
      : loaded[0]?.id ?? "";
    setSelectedItemId(nextSelected);
  }

  async function loadPlans(nextActiveId?: string): Promise<void> {
    setIsLoading(true);
    setError("");
    try {
      const [planResult, projectResult] = await Promise.all([
        wbsApi.listPlans({ limit: 100 }),
        projectsApi.list(undefined, "active", 100)
      ]);
      setPlans(planResult.items);
      setProjects(projectResult.items);
      const nextActive =
        planResult.items.find((plan) => plan.id === nextActiveId) ??
        planResult.items.find((plan) => plan.id === activePlan?.id) ??
        planResult.items[0];
      setActivePlan(nextActive);
      setArtifactPath(nextActive ? `wbs/${nextActive.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.md` : "");
      if (nextActive) {
        await loadItems(nextActive.id);
      } else {
        setItems([]);
        setSelectedItemId("");
      }
      setIsDirty(false);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "WBS plans could not be loaded.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadPlans();
  }, []);

  useEffect(() => {
    if (contextMenu && !items.some((item) => item.id === contextMenu.itemId)) {
      setContextMenu(null);
    }
  }, [contextMenu, items]);

  function selectItem(itemId: string, openDetail = true): void {
    setSelectedItemId(itemId);
    setContextMenu(null);
    setCanvasMenu(null);
    if (openDetail) setActivePanel("item");
  }

  function focusItemTitle(itemId: string, shouldSelect = false): void {
    window.requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>(`input[data-wbs-title-input-id="${itemId}"]`);
      input?.focus();
      if (shouldSelect) input?.select();
    });
  }

  function patchLocalItem(itemId: string, patch: Partial<WbsItem>): void {
    setItems((current) => current.map((item) => (item.id === itemId ? { ...item, ...patch } : item)));
    setIsDirty(true);
  }

  function replaceItems(nextItems: WbsItem[], nextSelectedId = selectedItemId): void {
    setItems(nextItems);
    setSelectedItemId(nextItems.some((item) => item.id === nextSelectedId) ? nextSelectedId : nextItems[0]?.id ?? "");
    setIsDirty(false);
  }

  async function createPlan(): Promise<void> {
    const title = newPlanTitle.trim();
    if (!title) return;
    setIsSaving(true);
    setError("");
    try {
      const created = await wbsApi.createPlan({
        title,
        projectId: newPlanProjectId || undefined,
        projectName: selectedProjectName(projects, newPlanProjectId)
      });
      setPlans((current) => [created, ...current]);
      setActivePlan(created);
      setItems([]);
      setSelectedItemId("");
      setNewPlanTitle("New WBS");
      setArtifactPath(`wbs/${created.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.md`);
      setIsDirty(false);
      setActivePanel(null);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "WBS plan could not be created.");
    } finally {
      setIsSaving(false);
    }
  }

  async function selectPlan(plan: WbsPlan): Promise<void> {
    setActivePlan(plan);
    setError("");
    setIsDirty(false);
    setArtifactPath(`wbs/${plan.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.${exportFormat === "markdown" ? "md" : exportFormat}`);
    try {
      await loadItems(plan.id);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "WBS items could not be loaded.");
    }
  }

  async function savePlan(): Promise<void> {
    if (!activePlan) return;
    setIsSaving(true);
    setError("");
    try {
      const saved = await wbsApi.updatePlan(activePlan.id, {
        expectedVersion: activePlan.version,
        title: activePlan.title,
        description: activePlan.description ?? "",
        projectId: activePlan.projectId ?? null,
        projectName: activePlan.projectName ?? null,
        settings: activePlan.settings ?? {}
      });
      setActivePlan(saved);
      setPlans((current) => current.map((plan) => (plan.id === saved.id ? saved : plan)));
      setIsDirty(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "WBS plan could not be saved.");
    } finally {
      setIsSaving(false);
    }
  }

  async function deletePlan(): Promise<void> {
    if (!activePlan) return;
    setIsSaving(true);
    setError("");
    try {
      await wbsApi.removePlan(activePlan.id);
      const remaining = plans.filter((plan) => plan.id !== activePlan.id);
      setPlans(remaining);
      setActivePlan(remaining[0]);
      if (remaining[0]) await loadItems(remaining[0].id);
      else {
        setItems([]);
        setSelectedItemId("");
      }
      setIsDirty(false);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "WBS plan could not be deleted.");
    } finally {
      setIsSaving(false);
    }
  }

  async function createItem(parentId?: string): Promise<void> {
    if (!activePlan) return;
    setIsSaving(true);
    setError("");
    try {
      const nextItems = await wbsApi.createItem(activePlan.id, {
        parentId,
        title: "New work item",
        status: "todo",
        progress: 0
      });
      const created = nextItems.find((item) => !items.some((existing) => existing.id === item.id));
      replaceItems(nextItems, created?.id ?? selectedItemId);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "WBS item could not be created.");
    } finally {
      setIsSaving(false);
    }
  }

  async function createSibling(): Promise<void> {
    if (!selectedItem) {
      await createItem();
      return;
    }
    await createItem(selectedItem.parentId);
  }

  async function createSiblingForItem(itemId: string): Promise<void> {
    const item = items.find((candidate) => candidate.id === itemId);
    setSelectedItemId(itemId);
    await createItem(item?.parentId);
    setContextMenu(null);
    setCanvasMenu(null);
  }

  async function createChildForItem(itemId: string): Promise<void> {
    setSelectedItemId(itemId);
    await createItem(itemId);
    setContextMenu(null);
    setCanvasMenu(null);
  }

  async function commitItem(item: WbsItem, patch: Partial<WbsItem>): Promise<void> {
    setError("");
    try {
      const payload = {
        expectedVersion: item.version
      } as Parameters<typeof wbsApi.updateItem>[1];
      if ("title" in patch) payload.title = patch.title;
      if ("description" in patch) payload.description = patch.description;
      if ("ownerLabel" in patch) payload.ownerLabel = patch.ownerLabel || null;
      if ("startDate" in patch) payload.startDate = patch.startDate || null;
      if ("dueDate" in patch) payload.dueDate = patch.dueDate || null;
      if ("effortHours" in patch) payload.effortHours = patch.effortHours ?? null;
      if ("status" in patch) payload.status = patch.status;
      if ("progress" in patch) payload.progress = patch.progress ?? null;
      const nextItems = await wbsApi.updateItem(item.id, payload);
      replaceItems(nextItems, item.id);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "WBS item could not be saved.");
      if (activePlan) void loadItems(activePlan.id, item.id);
    }
  }

  async function deleteItemById(itemId: string): Promise<void> {
    setIsSaving(true);
    setError("");
    try {
      const nextItems = await wbsApi.removeItem(itemId);
      replaceItems(nextItems);
      setContextMenu(null);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "WBS item could not be deleted.");
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteSelectedItem(): Promise<void> {
    if (!selectedItem) return;
    await deleteItemById(selectedItem.id);
  }

  async function moveItemById(itemId: string, direction: "up" | "down" | "indent" | "outdent"): Promise<void> {
    const item = items.find((candidate) => candidate.id === itemId);
    if (!item) return;
    const siblings = siblingRows(rows, item);
    const siblingIndex = siblings.findIndex((row) => row.item.id === item.id);
    const currentRowIndex = rows.findIndex((row) => row.item.id === item.id);
    let payload: { parentId?: string | null; beforeItemId?: string; afterItemId?: string } | undefined;

    if (direction === "up" && siblingIndex > 0) {
      payload = { beforeItemId: siblings[siblingIndex - 1].item.id };
    } else if (direction === "down" && siblingIndex < siblings.length - 1) {
      payload = { afterItemId: siblings[siblingIndex + 1].item.id };
    } else if (direction === "indent" && currentRowIndex > 0) {
      payload = { parentId: rows[currentRowIndex - 1].item.id };
    } else if (direction === "outdent") {
      const parent = items.find((candidate) => candidate.id === item.parentId);
      payload = { parentId: parent?.parentId ?? null, afterItemId: parent?.id };
    }

    if (!payload) return;
    setError("");
    try {
      const nextItems = await wbsApi.moveItem(item.id, {
        expectedVersion: item.version,
        ...payload
      });
      replaceItems(nextItems, item.id);
      setContextMenu(null);
    } catch (moveError) {
      setError(moveError instanceof Error ? moveError.message : "WBS item could not be moved.");
    }
  }

  async function moveSelected(direction: "up" | "down" | "indent" | "outdent"): Promise<void> {
    if (!selectedItem) return;
    await moveItemById(selectedItem.id, direction);
  }

  async function moveItemByDrop(draggedId: string, targetId: string, position: WbsDropPosition): Promise<void> {
    const dragged = items.find((item) => item.id === draggedId);
    const target = items.find((item) => item.id === targetId);
    if (!dragged || !target || dragged.id === target.id) return;
    if (position === "child" && isDescendantItem(items, target.id, dragged.id)) return;

    const payload: Parameters<typeof wbsApi.moveItem>[1] = { expectedVersion: dragged.version };
    if (position === "child") {
      payload.parentId = target.id;
    } else {
      payload.parentId = target.parentId ?? null;
      if (position === "before") payload.beforeItemId = target.id;
      else payload.afterItemId = target.id;
    }

    setError("");
    try {
      const nextItems = await wbsApi.moveItem(dragged.id, payload);
      replaceItems(nextItems, dragged.id);
    } catch (moveError) {
      setError(moveError instanceof Error ? moveError.message : "WBS item could not be moved.");
    }
  }

  async function saveArtifact(): Promise<void> {
    if (!activePlan) return;
    setIsSaving(true);
    setError("");
    try {
      await wbsApi.saveArtifact(activePlan.id, {
        format: exportFormat,
        artifactTitle: activePlan.title,
        artifactPath: artifactPath.trim() || undefined,
        projectId: activePlan.projectId,
        projectName: activePlan.projectName
      });
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "WBS artifact could not be saved.");
    } finally {
      setIsSaving(false);
    }
  }

  async function downloadExport(): Promise<void> {
    if (!activePlan) return;
    setIsSaving(true);
    setError("");
    try {
      const exported = await wbsApi.exportContent(activePlan.id, exportFormat);
      const blob = new Blob([exported.contentText], { type: exported.mimeType || "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = exported.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "WBS export could not be downloaded.");
    } finally {
      setIsSaving(false);
    }
  }

  const updateActivePlanProject = (projectId: string) => {
    const projectName = selectedProjectName(projects, projectId);
    setActivePlan((current) => current ? { ...current, projectId: projectId || undefined, projectName } : current);
    setIsDirty(true);
  };

  function togglePanel(panel: WbsPanel): void {
    setActivePanel((current) => current === panel ? null : panel);
  }

  function handleItemRowClick(event: ReactMouseEvent<HTMLTableRowElement>, itemId: string): void {
    if (isDirectEditTarget(event.target)) return;
    setSelectedItemId(itemId);
    setContextMenu(null);
    setCanvasMenu(null);
    if (activePanel === "item") setActivePanel(null);
    focusItemTitle(itemId, true);
  }

  function openItemMenu(event: ReactMouseEvent<HTMLTableRowElement>, itemId: string): void {
    event.preventDefault();
    event.stopPropagation();
    setSelectedItemId(itemId);
    setCanvasMenu(null);
    setContextMenu({ itemId, x: event.clientX, y: event.clientY });
  }

  function openCanvasMenu(event: ReactMouseEvent<HTMLDivElement>): void {
    if (isInsideWbsItem(event.target) || isDirectEditTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    setContextMenu(null);
    setCanvasMenu({ x: event.clientX, y: event.clientY });
  }

  async function createRootFromCanvasMenu(): Promise<void> {
    setCanvasMenu(null);
    await createItem();
  }

  function openPanelFromCanvasMenu(panel: WbsPanel): void {
    setCanvasMenu(null);
    setActivePanel(panel);
  }

  function refreshFromCanvasMenu(): void {
    setCanvasMenu(null);
    void loadPlans();
  }

  function saveFromCanvasMenu(): void {
    setCanvasMenu(null);
    void savePlan();
  }

  function handleItemDragStart(event: DragEvent<HTMLElement>, itemId: string): void {
    event.stopPropagation();
    setDraggedItemId(itemId);
    setContextMenu(null);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", itemId);
  }

  function handleItemDragOver(event: DragEvent<HTMLTableRowElement>, item: WbsItem, depth: number): void {
    const currentDraggedId = draggedItemId || event.dataTransfer.getData("text/plain");
    if (!currentDraggedId || currentDraggedId === item.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const position = dropPositionForEvent(event, depth);
    setDropIntent({ draggedItemId: currentDraggedId, targetItemId: item.id, position });
  }

  async function handleItemDrop(event: DragEvent<HTMLTableRowElement>, item: WbsItem, depth: number): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    const currentDraggedId = dropIntent?.draggedItemId || draggedItemId || event.dataTransfer.getData("text/plain");
    const position = dropIntent?.targetItemId === item.id ? dropIntent.position : dropPositionForEvent(event, depth);
    setDropIntent(null);
    setDraggedItemId("");
    if (!currentDraggedId) return;
    await moveItemByDrop(currentDraggedId, item.id, position);
  }

  function handleItemDragEnd(): void {
    setDraggedItemId("");
    setDropIntent(null);
  }

  function renderPanel() {
    if (!activePanel) return null;

    const panelTitles: Record<WbsPanel, string> = {
      plans: "WBS plans",
      create: "Create WBS",
      settings: "Plan settings",
      item: "Item detail",
      export: "Export"
    };

    return (
      <aside
        className={activePanel === "item" ? "wbs-floating-panel wbs-panel-right" : "wbs-floating-panel"}
        aria-label={panelTitles[activePanel]}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="wbs-panel-head">
          <strong>{panelTitles[activePanel]}</strong>
          <button type="button" className="wbs-tool-button" onClick={() => setActivePanel(null)} aria-label="Close panel" title="Close">
            <IcoClose />
          </button>
        </div>

        {activePanel === "plans" ? (
          <>
            <div className="wbs-filter-grid">
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" aria-label="Search WBS plans" />
              <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)} aria-label="Filter WBS project">
                <option value="">All projects</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="wbs-plan-list">
              {filteredPlans.map((plan) => (
                <button
                  key={plan.id}
                  type="button"
                  className={activePlan?.id === plan.id ? "active" : ""}
                  onClick={() => {
                    void selectPlan(plan);
                    setActivePanel(null);
                  }}
                >
                  <span>{plan.title}</span>
                  <small>{plan.projectName || "No project"}</small>
                </button>
              ))}
              {!isLoading && filteredPlans.length === 0 ? <div className="wbs-empty">No plans</div> : null}
            </div>
          </>
        ) : null}

        {activePanel === "create" ? (
          <div className="wbs-create">
            <label>
              Title
              <input value={newPlanTitle} onChange={(event) => setNewPlanTitle(event.target.value)} aria-label="New WBS title" />
            </label>
            <label>
              Project
              <select value={newPlanProjectId} onChange={(event) => setNewPlanProjectId(event.target.value)} aria-label="New WBS project">
                <option value="">No project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="wbs-primary" onClick={() => void createPlan()} disabled={isSaving}>
              <IcoPlus />
              Create
            </button>
          </div>
        ) : null}

        {activePanel === "settings" ? (
          <div className="wbs-settings-form">
            <label>
              Title
              <input
                value={activePlan?.title ?? ""}
                onChange={(event) => {
                  setActivePlan((current) => current ? { ...current, title: event.target.value } : current);
                  setIsDirty(true);
                }}
                disabled={!activePlan}
                aria-label="WBS title"
              />
            </label>
            <label>
              Project
              <select value={activePlan?.projectId ?? ""} onChange={(event) => updateActivePlanProject(event.target.value)} disabled={!activePlan}>
                <option value="">No project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="wbs-panel-actions">
              <button type="button" onClick={() => void savePlan()} disabled={!activePlan || isSaving}>
                <IcoFloppy />
                Save
              </button>
              <button type="button" className="danger" onClick={() => void deletePlan()} disabled={!activePlan || isSaving}>
                <IcoTrash />
                Delete
              </button>
            </div>
          </div>
        ) : null}

        {activePanel === "export" ? (
          <div className="wbs-export">
            <label>
              Format
              <select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as WbsExportFormat)}>
                <option value="markdown">Markdown</option>
                <option value="csv">CSV</option>
                <option value="json">JSON</option>
              </select>
            </label>
            <label>
              Path
              <input value={artifactPath} onChange={(event) => setArtifactPath(event.target.value)} aria-label="Artifact path" />
            </label>
            <div className="wbs-panel-actions">
              <button type="button" onClick={() => void downloadExport()} disabled={!activePlan || isSaving}>
                <IcoDownload />
                Download
              </button>
              <button type="button" onClick={() => void saveArtifact()} disabled={!activePlan || isSaving}>
                <IcoFloppy />
                Artifact
              </button>
            </div>
          </div>
        ) : null}

        {activePanel === "item" ? (
          <div className="wbs-item-panel">
            <div>
              <p className="eyebrow">Item</p>
              <strong>{selectedItem?.title ?? "No selection"}</strong>
            </div>

            <label>
              Description
              <textarea
                value={selectedItem?.description ?? ""}
                onChange={(event) => selectedItem && patchLocalItem(selectedItem.id, { description: event.target.value })}
                onBlur={() => selectedItem && void commitItem(selectedItem, { description: selectedItem.description ?? "" })}
                disabled={!selectedItem}
              />
            </label>

            <div className="wbs-move-grid">
              <button type="button" onClick={() => void moveSelected("up")} disabled={!selectedItem}>Up</button>
              <button type="button" onClick={() => void moveSelected("down")} disabled={!selectedItem}>Down</button>
              <button type="button" onClick={() => void moveSelected("outdent")} disabled={!selectedItem}>Outdent</button>
              <button type="button" onClick={() => void moveSelected("indent")} disabled={!selectedItem}>Indent</button>
            </div>

            <div className="wbs-inspector-footer">
              <div className="wbs-item-stats" aria-label="WBS statistics">
                <div className="wbs-stat">
                  <strong>{rows.length}</strong>
                  <span>Total items</span>
                </div>
                <div className="wbs-stat">
                  <strong>{selectedChildCount}</strong>
                  <span>Children</span>
                </div>
              </div>
              <button
                type="button"
                className="wbs-inspector-delete"
                onClick={() => void deleteSelectedItem()}
                disabled={!selectedItem || isSaving}
                aria-label="Delete item"
                title="Delete item"
              >
                <IcoTrash />
              </button>
            </div>
          </div>
        ) : null}
      </aside>
    );
  }

  const contextMenuItem = contextMenu ? items.find((item) => item.id === contextMenu.itemId) : undefined;
  const gridZoomStyle = { "--wbs-zoom": wbsZoom } as CSSProperties & Record<string, number>;

  return (
    <main className="wbs-page">
      <section className="wbs-board" aria-label="WBS table">
        <div className="wbs-toolbar">
          <div className="wbs-current">
            <strong>{activePlan?.title ?? "WBS"}</strong>
            <span>
              {activePlan
                ? `${selectedProject?.name ?? activePlan.projectName ?? "No project"} / ${rows.length} items${isDirty ? " / Unsaved" : ""}`
                : "No plan"}
            </span>
          </div>

          <div className="wbs-actions">
            <button
              type="button"
              className={activePanel === "plans" ? "wbs-tool-button active" : "wbs-tool-button"}
              onClick={() => togglePanel("plans")}
              aria-label="Open WBS plans"
              title="Plans"
            >
              <IcoList />
            </button>
            <button
              type="button"
              className={activePanel === "create" ? "wbs-tool-button active" : "wbs-tool-button"}
              onClick={() => togglePanel("create")}
              aria-label="Create WBS"
              title="Create WBS"
            >
              <IcoPlus />
            </button>
            <button
              type="button"
              className={activePanel === "settings" ? "wbs-tool-button active" : "wbs-tool-button"}
              onClick={() => togglePanel("settings")}
              disabled={!activePlan}
              aria-label="Plan settings"
              title="Plan settings"
            >
              <IcoSettings />
            </button>
            <button
              type="button"
              className={activePanel === "export" ? "wbs-tool-button active" : "wbs-tool-button"}
              onClick={() => togglePanel("export")}
              disabled={!activePlan}
              aria-label="Export"
              title="Export"
            >
              <IcoDownload />
            </button>
            <button
              type="button"
              className={activePanel === "item" ? "wbs-tool-button active" : "wbs-tool-button"}
              onClick={() => togglePanel("item")}
              aria-label="Item detail"
              title="Item detail"
            >
              <IcoPanelLeft />
            </button>
            <button type="button" className="wbs-tool-button" onClick={() => void loadPlans()} aria-label="Refresh" title="Refresh">
              <IcoRefresh />
            </button>
            <span className="wbs-action-separator" aria-hidden="true" />
            <button type="button" className="wbs-tool-button" onClick={() => void createItem()} disabled={!activePlan || isSaving} aria-label="Add root item" title="Add root item">
              <IcoRootItem />
            </button>
            <button type="button" className="wbs-tool-button" onClick={() => void createSibling()} disabled={!activePlan || isSaving} aria-label="Add sibling item" title="Add sibling item">
              <IcoSiblingItem />
            </button>
            <button type="button" className="wbs-tool-button" onClick={() => void createItem(selectedItem?.id)} disabled={!selectedItem || isSaving} aria-label="Add child item" title="Add child item">
              <IcoChildItem />
            </button>
            <button type="button" className="wbs-tool-button" onClick={() => void savePlan()} disabled={!activePlan || isSaving} aria-label="Save WBS" title="Save">
              <IcoFloppy />
            </button>
            <button type="button" className="wbs-tool-button danger" onClick={() => void deletePlan()} disabled={!activePlan || isSaving} aria-label="Delete WBS" title="Delete WBS">
              <IcoTrash />
            </button>
          </div>
        </div>

        {renderPanel()}
        {error ? <div className="wbs-error">{error}</div> : null}

        <div
          className={isGridPanning ? "wbs-grid-wrap panning" : "wbs-grid-wrap"}
          onWheel={handleGridWheel}
          onPointerDown={handleGridPointerDown}
          onPointerMove={handleGridPointerMove}
          onPointerUp={(event) => finishGridPan(event.currentTarget, event.pointerId)}
          onPointerCancel={(event) => finishGridPan(event.currentTarget, event.pointerId)}
          onLostPointerCapture={(event) => finishGridPan(event.currentTarget, event.pointerId)}
          onClick={handleGridClick}
          onContextMenu={openCanvasMenu}
        >
          <div className="wbs-grid-zoom" style={gridZoomStyle}>
            <table className="wbs-grid">
              <colgroup>
                <col className="wbs-col-code" />
                <col className="wbs-col-work" />
                <col className="wbs-col-owner" />
                <col className="wbs-col-status" />
                <col className="wbs-col-date" />
                <col className="wbs-col-date" />
                <col className="wbs-col-small" />
                <col className="wbs-col-small" />
              </colgroup>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Work item</th>
                  <th>Owner</th>
                  <th>Status</th>
                  <th>Start</th>
                  <th>Due</th>
                  <th>Effort</th>
                  <th>Progress</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ item, depth, childCount }) => {
                  const dropClass = dropIntent?.targetItemId === item.id ? ` drop-${dropIntent.position}` : "";
                  const dragClass = draggedItemId === item.id ? " dragging" : "";
                  const selectedClass = selectedItemId === item.id ? "selected" : "";
                  return (
                    <tr
                      key={item.id}
                      data-wbs-item-id={item.id}
                      className={`${selectedClass}${dropClass}${dragClass}`}
                      draggable
                      onClick={(event) => handleItemRowClick(event, item.id)}
                      onContextMenu={(event) => openItemMenu(event, item.id)}
                      onDragStart={(event) => handleItemDragStart(event, item.id)}
                      onDragOver={(event) => handleItemDragOver(event, item, depth)}
                      onDrop={(event) => void handleItemDrop(event, item, depth)}
                      onDragEnd={handleItemDragEnd}
                    >
                      <td className="wbs-code">{item.code}</td>
                      <td className="wbs-work-cell">
                        <div style={{ paddingLeft: `${depth * 1.25}rem` }}>
                          <span className={childCount > 0 ? "wbs-child-dot has-children" : "wbs-child-dot"} aria-hidden="true" />
                          <input
                            data-wbs-title-input-id={item.id}
                            value={item.title}
                            onClick={(event) => event.stopPropagation()}
                            onFocus={() => selectItem(item.id, false)}
                            onChange={(event) => patchLocalItem(item.id, { title: event.target.value })}
                            onBlur={() => void commitItem(item, { title: item.title })}
                            aria-label="Work item title"
                          />
                        </div>
                      </td>
                      <td>
                        <input
                          value={item.ownerLabel ?? ""}
                          onClick={(event) => event.stopPropagation()}
                          onFocus={() => selectItem(item.id, false)}
                          onChange={(event) => patchLocalItem(item.id, { ownerLabel: event.target.value })}
                          onBlur={() => void commitItem(item, { ownerLabel: item.ownerLabel ?? "" })}
                          aria-label="Owner"
                        />
                      </td>
                      <td>
                        <select
                          value={item.status}
                          onClick={(event) => event.stopPropagation()}
                          onFocus={() => selectItem(item.id, false)}
                          onChange={(event) => {
                            const status = event.target.value as WbsItemStatus;
                            patchLocalItem(item.id, { status });
                            void commitItem(item, { status });
                          }}
                          aria-label="Status"
                        >
                          {Object.entries(statusLabels).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          type="date"
                          value={item.startDate ?? ""}
                          onClick={(event) => event.stopPropagation()}
                          onFocus={() => selectItem(item.id, false)}
                          onChange={(event) => patchLocalItem(item.id, { startDate: event.target.value })}
                          onBlur={() => void commitItem(item, { startDate: item.startDate ?? "" })}
                          aria-label="Start date"
                        />
                      </td>
                      <td>
                        <input
                          type="date"
                          value={item.dueDate ?? ""}
                          onClick={(event) => event.stopPropagation()}
                          onFocus={() => selectItem(item.id, false)}
                          onChange={(event) => patchLocalItem(item.id, { dueDate: event.target.value })}
                          onBlur={() => void commitItem(item, { dueDate: item.dueDate ?? "" })}
                          aria-label="Due date"
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          min="0"
                          step="0.25"
                          value={item.effortHours ?? ""}
                          onClick={(event) => event.stopPropagation()}
                          onFocus={() => selectItem(item.id, false)}
                          onChange={(event) => patchLocalItem(item.id, { effortHours: numberOrUndefined(event.target.value) })}
                          onBlur={() => void commitItem(item, { effortHours: item.effortHours })}
                          aria-label="Effort hours"
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          min="0"
                          max="100"
                          value={item.progress ?? ""}
                          onClick={(event) => event.stopPropagation()}
                          onFocus={() => selectItem(item.id, false)}
                          onChange={(event) => patchLocalItem(item.id, { progress: clampProgress(numberOrUndefined(event.target.value)) })}
                          onBlur={() => void commitItem(item, { progress: item.progress })}
                          aria-label="Progress"
                        />
                      </td>
                    </tr>
                  );
                })}
                {!isLoading && activePlan && rows.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="wbs-grid-empty">
                      <button type="button" onClick={() => void createItem()} disabled={isSaving}>
                        <IcoPlus />
                        Add item
                      </button>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        {contextMenu && contextMenuItem ? (
          <div
            className="wbs-context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            role="menu"
            aria-label="WBS item menu"
            onClick={(event) => event.stopPropagation()}
          >
            <button type="button" role="menuitem" onClick={() => selectItem(contextMenu.itemId)}>
              Details
            </button>
            <button type="button" role="menuitem" onClick={() => void createSiblingForItem(contextMenu.itemId)}>
              Add sibling
            </button>
            <button type="button" role="menuitem" onClick={() => void createChildForItem(contextMenu.itemId)}>
              Add child
            </button>
            <button type="button" role="menuitem" onClick={() => void moveItemById(contextMenu.itemId, "up")}>
              Move up
            </button>
            <button type="button" role="menuitem" onClick={() => void moveItemById(contextMenu.itemId, "down")}>
              Move down
            </button>
            <button type="button" role="menuitem" onClick={() => void moveItemById(contextMenu.itemId, "outdent")}>
              Outdent
            </button>
            <button type="button" role="menuitem" onClick={() => void moveItemById(contextMenu.itemId, "indent")}>
              Indent
            </button>
            <button type="button" role="menuitem" className="danger" onClick={() => void deleteItemById(contextMenu.itemId)}>
              Delete
            </button>
          </div>
        ) : null}

        {canvasMenu ? (
          <div
            className="wbs-context-menu"
            style={{ left: canvasMenu.x, top: canvasMenu.y }}
            role="menu"
            aria-label="WBS canvas menu"
            onClick={(event) => event.stopPropagation()}
          >
            <button type="button" role="menuitem" onClick={() => void createRootFromCanvasMenu()} disabled={!activePlan || isSaving}>
              Add root item
            </button>
            <button type="button" role="menuitem" onClick={() => openPanelFromCanvasMenu("create")}>
              New WBS
            </button>
            <button type="button" role="menuitem" onClick={() => openPanelFromCanvasMenu("plans")}>
              WBS plans
            </button>
            <button type="button" role="menuitem" onClick={() => openPanelFromCanvasMenu("settings")} disabled={!activePlan}>
              Plan settings
            </button>
            <button type="button" role="menuitem" onClick={() => openPanelFromCanvasMenu("export")} disabled={!activePlan}>
              Export
            </button>
            <button type="button" role="menuitem" onClick={refreshFromCanvasMenu}>
              Refresh
            </button>
            <button type="button" role="menuitem" onClick={saveFromCanvasMenu} disabled={!activePlan || isSaving}>
              Save
            </button>
          </div>
        ) : null}
      </section>
    </main>
  );
}
