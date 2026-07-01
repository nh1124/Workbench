import { useEffect, useMemo, useState } from "react";
import { IcoDownload, IcoList, IcoPlus, IcoRefresh, IcoTrash } from "../tasks/components/icons";
import { IcoFloppy } from "../artifacts/components/ArtifactsIcons";
import { projectsApi, wbsApi } from "../lib/api";
import type {
  ProjectRecord,
  WbsExportFormat,
  WbsItem,
  WbsItemStatus,
  WbsPlan
} from "../types/models";
import "./WbsPage.css";

type FlatWbsRow = {
  item: WbsItem;
  depth: number;
  childCount: number;
};

const statusLabels: Record<WbsItemStatus, string> = {
  todo: "Todo",
  doing: "Doing",
  blocked: "Blocked",
  done: "Done"
};

function selectedProjectName(projects: ProjectRecord[], projectId: string | undefined): string | undefined {
  if (!projectId) return undefined;
  return projects.find((project) => project.id === projectId)?.name;
}

function flattenWbsItems(items: WbsItem[]): FlatWbsRow[] {
  const byParent = new Map<string, WbsItem[]>();
  for (const item of items) {
    const parentKey = item.parentId ?? "";
    const siblings = byParent.get(parentKey) ?? [];
    siblings.push(item);
    byParent.set(parentKey, siblings);
  }

  for (const siblings of byParent.values()) {
    siblings.sort((left, right) => left.sortOrder - right.sortOrder || left.code.localeCompare(right.code));
  }

  const rows: FlatWbsRow[] = [];
  const visit = (item: WbsItem, depth: number) => {
    const children = byParent.get(item.id) ?? [];
    rows.push({ item, depth, childCount: children.length });
    for (const child of children) visit(child, depth + 1);
  };

  for (const root of byParent.get("") ?? []) visit(root, 0);
  return rows;
}

function numberOrUndefined(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampProgress(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function siblingRows(rows: FlatWbsRow[], item: WbsItem): FlatWbsRow[] {
  return rows.filter((row) => row.item.parentId === item.parentId);
}

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

  const rows = useMemo(() => flattenWbsItems(items), [items]);
  const selectedItem = useMemo(() => items.find((item) => item.id === selectedItemId), [items, selectedItemId]);
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === activePlan?.projectId),
    [activePlan?.projectId, projects]
  );

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

  async function deleteSelectedItem(): Promise<void> {
    if (!selectedItem) return;
    setIsSaving(true);
    setError("");
    try {
      const nextItems = await wbsApi.removeItem(selectedItem.id);
      replaceItems(nextItems);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "WBS item could not be deleted.");
    } finally {
      setIsSaving(false);
    }
  }

  async function moveSelected(direction: "up" | "down" | "indent" | "outdent"): Promise<void> {
    if (!selectedItem) return;
    const siblings = siblingRows(rows, selectedItem);
    const siblingIndex = siblings.findIndex((row) => row.item.id === selectedItem.id);
    const currentRowIndex = rows.findIndex((row) => row.item.id === selectedItem.id);
    let payload: { parentId?: string | null; beforeItemId?: string; afterItemId?: string } | undefined;

    if (direction === "up" && siblingIndex > 0) {
      payload = { beforeItemId: siblings[siblingIndex - 1].item.id };
    } else if (direction === "down" && siblingIndex < siblings.length - 1) {
      payload = { afterItemId: siblings[siblingIndex + 1].item.id };
    } else if (direction === "indent" && currentRowIndex > 0) {
      payload = { parentId: rows[currentRowIndex - 1].item.id };
    } else if (direction === "outdent") {
      const parent = items.find((item) => item.id === selectedItem.parentId);
      payload = { parentId: parent?.parentId ?? null, afterItemId: parent?.id };
    }

    if (!payload) return;
    setError("");
    try {
      const nextItems = await wbsApi.moveItem(selectedItem.id, {
        expectedVersion: selectedItem.version,
        ...payload
      });
      replaceItems(nextItems, selectedItem.id);
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

  return (
    <main className="wbs-page">
      <aside className="wbs-sidebar" aria-label="WBS plans">
        <div className="wbs-sidebar-head">
          <div>
            <p className="eyebrow">WBS</p>
            <strong>{activePlan?.title ?? "Plans"}</strong>
          </div>
          <button type="button" className="wbs-icon-button" onClick={() => void loadPlans()} aria-label="Refresh" title="Refresh">
            <IcoRefresh />
          </button>
        </div>

        <div className="wbs-create">
          <input value={newPlanTitle} onChange={(event) => setNewPlanTitle(event.target.value)} aria-label="New WBS title" />
          <select value={newPlanProjectId} onChange={(event) => setNewPlanProjectId(event.target.value)} aria-label="New WBS project">
            <option value="">No project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <button type="button" className="wbs-primary" onClick={() => void createPlan()} disabled={isSaving}>
            <IcoPlus />
            Create
          </button>
        </div>

        <div className="wbs-filters">
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
              onClick={() => void selectPlan(plan)}
            >
              <span>{plan.title}</span>
              <small>{plan.projectName || "No project"}</small>
            </button>
          ))}
          {!isLoading && filteredPlans.length === 0 ? <div className="wbs-empty">No plans</div> : null}
        </div>
      </aside>

      <section className="wbs-main" aria-label="WBS table">
        <div className="wbs-toolbar">
          <div className="wbs-title-fields">
            <input
              value={activePlan?.title ?? ""}
              onChange={(event) => {
                setActivePlan((current) => current ? { ...current, title: event.target.value } : current);
                setIsDirty(true);
              }}
              disabled={!activePlan}
              aria-label="WBS title"
            />
            <select value={activePlan?.projectId ?? ""} onChange={(event) => updateActivePlanProject(event.target.value)} disabled={!activePlan}>
              <option value="">No project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>

          <div className="wbs-actions">
            <span className={isDirty ? "wbs-save-state dirty" : "wbs-save-state"}>{isDirty ? "Unsaved" : selectedProject?.name ?? "Saved"}</span>
            <button type="button" className="wbs-icon-button" onClick={() => void createItem()} disabled={!activePlan || isSaving} aria-label="Add root item" title="Add root">
              <IcoPlus />
            </button>
            <button type="button" className="wbs-secondary" onClick={() => void createSibling()} disabled={!activePlan || isSaving}>
              Sibling
            </button>
            <button type="button" className="wbs-secondary" onClick={() => void createItem(selectedItem?.id)} disabled={!selectedItem || isSaving}>
              Child
            </button>
            <button type="button" className="wbs-icon-button" onClick={() => void savePlan()} disabled={!activePlan || isSaving} aria-label="Save WBS" title="Save">
              <IcoFloppy />
            </button>
            <button type="button" className="wbs-icon-button danger" onClick={() => void deletePlan()} disabled={!activePlan || isSaving} aria-label="Delete WBS" title="Delete WBS">
              <IcoTrash />
            </button>
          </div>
        </div>

        {error ? <div className="wbs-error">{error}</div> : null}

        <div className="wbs-grid-wrap">
          <table className="wbs-grid">
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
              {rows.map(({ item, depth, childCount }) => (
                <tr key={item.id} className={selectedItemId === item.id ? "selected" : ""} onClick={() => setSelectedItemId(item.id)}>
                  <td className="wbs-code">{item.code}</td>
                  <td className="wbs-work-cell">
                    <div style={{ paddingLeft: `${depth * 1.25}rem` }}>
                      <span className={childCount > 0 ? "wbs-child-dot has-children" : "wbs-child-dot"} aria-hidden="true" />
                      <input
                        value={item.title}
                        onChange={(event) => patchLocalItem(item.id, { title: event.target.value })}
                        onBlur={() => void commitItem(item, { title: item.title })}
                        aria-label="Work item title"
                      />
                    </div>
                  </td>
                  <td>
                    <input
                      value={item.ownerLabel ?? ""}
                      onChange={(event) => patchLocalItem(item.id, { ownerLabel: event.target.value })}
                      onBlur={() => void commitItem(item, { ownerLabel: item.ownerLabel ?? "" })}
                      aria-label="Owner"
                    />
                  </td>
                  <td>
                    <select
                      value={item.status}
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
                      onChange={(event) => patchLocalItem(item.id, { startDate: event.target.value })}
                      onBlur={() => void commitItem(item, { startDate: item.startDate ?? "" })}
                      aria-label="Start date"
                    />
                  </td>
                  <td>
                    <input
                      type="date"
                      value={item.dueDate ?? ""}
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
                      onChange={(event) => patchLocalItem(item.id, { progress: clampProgress(numberOrUndefined(event.target.value)) })}
                      onBlur={() => void commitItem(item, { progress: item.progress })}
                      aria-label="Progress"
                    />
                  </td>
                </tr>
              ))}
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
      </section>

      <aside className="wbs-inspector" aria-label="WBS detail">
        <div className="wbs-inspector-head">
          <div>
            <p className="eyebrow">Item</p>
            <strong>{selectedItem?.title ?? "No selection"}</strong>
          </div>
          <span>{rows.length}</span>
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

        <button type="button" className="wbs-danger-action" onClick={() => void deleteSelectedItem()} disabled={!selectedItem || isSaving}>
          <IcoTrash />
          Delete item
        </button>

        <div className="wbs-export">
          <div className="wbs-export-head">
            <IcoList />
            <strong>Export</strong>
          </div>
          <select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as WbsExportFormat)}>
            <option value="markdown">Markdown</option>
            <option value="csv">CSV</option>
            <option value="json">JSON</option>
          </select>
          <input value={artifactPath} onChange={(event) => setArtifactPath(event.target.value)} aria-label="Artifact path" />
          <div className="wbs-export-actions">
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
      </aside>
    </main>
  );
}
