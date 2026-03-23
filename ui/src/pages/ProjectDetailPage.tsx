import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { artifactsApi, notesApi, projectsApi, tasksApi } from "../lib/api";
import { formatDateTime, normalizeProjectName } from "../lib/format";
import type {
  Artifact,
  ArtifactItem,
  ArtifactProjectSummary,
  Note,
  NoteProjectSummary,
  ProjectRecord,
  Task,
  TaskProjectSummary
} from "../types/models";
import "./ProjectDetailPage.css";

type DetailTab = "overview" | "tasks" | "notes" | "artifacts" | "config";

interface DeleteLinkedOptions {
  notes: boolean;
  tasks: boolean;
  artifacts: boolean;
}

interface ArtifactEntry {
  id: string;
  title: string;
  type: string;
  description: string;
  updatedAt: string;
  source: "legacy" | "item";
}

function isAuthErrorMessage(message: string): boolean {
  return /(missing bearer token|unauthori[sz]ed|unauthenticated|forbidden|401)/i.test(message);
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: number }).status;
    if (status === 404) {
      return true;
    }
  }
  const message = readErrorMessage(error).toLowerCase();
  return message.includes("not found") || message.includes("request failed: 404");
}

function trimOrUndefined(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeKey(value?: string): string {
  return value?.trim().toLowerCase() ?? "";
}

function previewText(value: string, max = 140): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "No details.";
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function mergeById<T extends { id: string }>(groups: T[][]): T[] {
  const merged = new Map<string, T>();
  for (const group of groups) {
    for (const item of group) {
      merged.set(item.id, item);
    }
  }
  return Array.from(merged.values());
}

function collectProjectKeys(
  projectId: string,
  projectName: string | undefined,
  noteProjects: NoteProjectSummary[],
  taskProjects: TaskProjectSummary[],
  artifactProjects: ArtifactProjectSummary[]
): string[] {
  const keys = new Set<string>([projectId]);
  const normalizedProjectNameInput = projectName?.trim();
  if (normalizedProjectNameInput) {
    keys.add(normalizedProjectNameInput);
  }
  const normalizedProjectId = normalizeKey(projectId);
  const normalizedProjectName = normalizeKey(projectName);

  const shouldInclude = (candidateId: string, candidateName?: string): boolean => {
    const normalizedCandidateId = normalizeKey(candidateId);
    const normalizedCandidateName = normalizeKey(candidateName);
    if (!normalizedCandidateId) {
      return false;
    }
    if (normalizedCandidateId === normalizedProjectId) {
      return true;
    }
    if (!normalizedProjectName) {
      return false;
    }
    return normalizedCandidateId === normalizedProjectName || normalizedCandidateName === normalizedProjectName;
  };

  for (const row of noteProjects) {
    if (shouldInclude(row.projectId, row.projectName)) {
      keys.add(row.projectId);
    }
  }
  for (const row of taskProjects) {
    if (shouldInclude(row.projectId, row.projectName)) {
      keys.add(row.projectId);
    }
  }
  for (const row of artifactProjects) {
    if (shouldInclude(row.projectId, row.projectName)) {
      keys.add(row.projectId);
    }
  }

  return Array.from(keys);
}

function artifactPathDepth(pathValue: string): number {
  const normalized = pathValue.trim();
  if (!normalized) return 0;
  return normalized.split("/").filter(Boolean).length;
}

export function ProjectDetailPage() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();

  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [artifactRecords, setArtifactRecords] = useState<Artifact[]>([]);
  const [artifactItems, setArtifactItems] = useState<ArtifactItem[]>([]);
  const [activeTab, setActiveTab] = useState<DetailTab>("overview");
  const [isLoading, setIsLoading] = useState(true);
  const [authRequired, setAuthRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [isSavingTitle, setIsSavingTitle] = useState(false);
  const [isDeletingProject, setIsDeletingProject] = useState(false);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [deleteLinkedOptions, setDeleteLinkedOptions] = useState<DeleteLinkedOptions>({
    notes: true,
    tasks: true,
    artifacts: true
  });

  const load = async (showLoading = true) => {
    if (!projectId) {
      return;
    }

    if (showLoading) {
      setIsLoading(true);
    }
    setError(null);

    const [projectResult, noteProjectsResult, taskProjectsResult, artifactProjectsResult] = await Promise.allSettled([
      projectsApi.get(projectId),
      notesApi.projects(),
      tasksApi.projects(),
      artifactsApi.projects()
    ]);

    const baseErrors = [projectResult, noteProjectsResult, taskProjectsResult, artifactProjectsResult]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => readErrorMessage(result.reason));

    const loadedProject = projectResult.status === "fulfilled" ? projectResult.value : null;
    const noteProjects = noteProjectsResult.status === "fulfilled" ? noteProjectsResult.value : [];
    const taskProjects = taskProjectsResult.status === "fulfilled" ? taskProjectsResult.value : [];
    const artifactProjects = artifactProjectsResult.status === "fulfilled" ? artifactProjectsResult.value : [];

    const keys = collectProjectKeys(projectId, loadedProject?.name, noteProjects, taskProjects, artifactProjects);

    const [notesFetchResult, tasksFetchResult, artifactLegacyFetchResult, artifactTreeFetchResult] = await Promise.all([
      Promise.allSettled(keys.map((key) => notesApi.list(key, 500))),
      Promise.allSettled(keys.map((key) => tasksApi.list(key, undefined, 500))),
      Promise.allSettled(keys.map((key) => artifactsApi.list(key, 500))),
      Promise.allSettled(keys.map((key) => artifactsApi.tree(key)))
    ]);

    const detailErrors = [
      ...notesFetchResult.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => readErrorMessage(result.reason)),
      ...tasksFetchResult.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => readErrorMessage(result.reason)),
      ...artifactLegacyFetchResult.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => readErrorMessage(result.reason)),
      ...artifactTreeFetchResult.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => readErrorMessage(result.reason))
    ];

    const allErrors = [...baseErrors, ...detailErrors];
    const hasAuthError = allErrors.some((message) => isAuthErrorMessage(message));
    setAuthRequired(hasAuthError);

    setProject(loadedProject);
    setNotes(
      mergeById(
        notesFetchResult
          .filter((result): result is PromiseFulfilledResult<Note[]> => result.status === "fulfilled")
          .map((result) => result.value)
      )
    );
    setTasks(
      mergeById(
        tasksFetchResult
          .filter((result): result is PromiseFulfilledResult<Task[]> => result.status === "fulfilled")
          .map((result) => result.value)
      )
    );
    setArtifactRecords(
      mergeById(
        artifactLegacyFetchResult
          .filter((result): result is PromiseFulfilledResult<Artifact[]> => result.status === "fulfilled")
          .map((result) => result.value)
      )
    );
    setArtifactItems(
      mergeById(
        artifactTreeFetchResult
          .filter((result): result is PromiseFulfilledResult<ArtifactItem[]> => result.status === "fulfilled")
          .map((result) => result.value)
      )
    );

    if (!hasAuthError && projectResult.status === "rejected" && !isNotFoundError(projectResult.reason)) {
      setError("Unable to load project details.");
    } else if (
      !hasAuthError &&
      noteProjectsResult.status === "rejected" &&
      taskProjectsResult.status === "rejected" &&
      artifactProjectsResult.status === "rejected"
    ) {
      setError("Unable to load linked resources.");
    }

    if (showLoading) {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void load(true);
  }, [projectId]);

  const displayTitle = useMemo(() => {
    const candidate = trimOrUndefined(project?.name)
      || trimOrUndefined(notes[0]?.projectName)
      || trimOrUndefined(artifactRecords[0]?.projectName)
      || trimOrUndefined(artifactItems[0]?.projectName)
      || trimOrUndefined(tasks[0]?.contextName);
    return normalizeProjectName(projectId, candidate);
  }, [artifactItems, artifactRecords, notes, project?.name, projectId, tasks]);

  useEffect(() => {
    if (!isEditingTitle) {
      setTitleDraft(displayTitle);
    }
  }, [displayTitle, isEditingTitle]);

  const artifactEntries = useMemo<ArtifactEntry[]>(() => {
    const entries: ArtifactEntry[] = [];
    for (const artifact of artifactRecords) {
      entries.push({
        id: `legacy:${artifact.id}`,
        title: artifact.name,
        type: artifact.type,
        description: artifact.description || "No details.",
        updatedAt: artifact.updatedAt,
        source: "legacy"
      });
    }
    for (const item of artifactItems) {
      entries.push({
        id: `item:${item.id}`,
        title: item.title,
        type: item.kind,
        description: item.path || "No details.",
        updatedAt: item.updatedAt,
        source: "item"
      });
    }
    return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [artifactItems, artifactRecords]);

  const artifactCount = artifactEntries.length;
  const isProjectActive = project?.status === "active";

  const handleSaveTitle = async () => {
    const nextTitle = titleDraft.trim();
    if (!nextTitle) {
      setError("Project title is required.");
      return;
    }

    if (nextTitle === displayTitle) {
      setIsEditingTitle(false);
      return;
    }

    setIsSavingTitle(true);
    setError(null);

    try {
      const updatedProject = await projectsApi.update(projectId, { name: nextTitle });
      setProject(updatedProject);

      const syncRequests: Array<Promise<unknown>> = [];

      for (const note of notes) {
        if ((note.projectName ?? "") !== nextTitle) {
          syncRequests.push(notesApi.update(note.id, { projectName: nextTitle }));
        }
      }

      for (const task of tasks) {
        if ((task.contextName ?? "") !== nextTitle) {
          syncRequests.push(tasksApi.update(task.id, { contextName: nextTitle }));
        }
      }

      for (const artifact of artifactRecords) {
        if ((artifact.projectName ?? "") !== nextTitle) {
          syncRequests.push(artifactsApi.update(artifact.id, { projectName: nextTitle }));
        }
      }

      for (const item of artifactItems) {
        if ((item.projectName ?? "") !== nextTitle) {
          syncRequests.push(artifactsApi.updateItem(item.id, { projectName: nextTitle }));
        }
      }

      const syncResults = await Promise.allSettled(syncRequests);
      const failedCount = syncResults.filter((result) => result.status === "rejected").length;

      setIsEditingTitle(false);
      if (failedCount > 0) {
        setError(`Project title was updated, but ${failedCount} linked records failed to sync.`);
      }

      await load(false);
    } catch (saveError) {
      const message = readErrorMessage(saveError);
      setError(isAuthErrorMessage(message) ? "Sign-in is required to rename this project." : message);
    } finally {
      setIsSavingTitle(false);
    }
  };

  const handleToggleProjectActive = async () => {
    if (!project) {
      setError("Project settings are unavailable.");
      return;
    }

    const nextStatus: ProjectRecord["status"] = isProjectActive ? "archived" : "active";
    setIsSavingConfig(true);
    setError(null);
    try {
      const updated = await projectsApi.update(projectId, { status: nextStatus });
      setProject(updated);
    } catch (updateError) {
      const message = readErrorMessage(updateError);
      setError(isAuthErrorMessage(message) ? "Sign-in is required to update project status." : message);
    } finally {
      setIsSavingConfig(false);
    }
  };

  const handleDeleteProject = async () => {
    if (isDeletingProject) {
      return;
    }

    const linkedDeleteTargets =
      (deleteLinkedOptions.notes ? notes.length : 0) +
      (deleteLinkedOptions.tasks ? tasks.length : 0) +
      (deleteLinkedOptions.artifacts ? artifactCount : 0);
    const confirmed = window.confirm(
      `Delete this project?\n\nProject: ${displayTitle}\nLinked records selected for deletion: ${linkedDeleteTargets}`
    );
    if (!confirmed) {
      return;
    }

    setIsDeletingProject(true);
    setError(null);

    try {
      const linkedDeleteRequests: Array<Promise<unknown>> = [];

      if (deleteLinkedOptions.notes) {
        for (const note of notes) {
          linkedDeleteRequests.push(notesApi.remove(note.id));
        }
      }

      if (deleteLinkedOptions.tasks) {
        for (const task of tasks) {
          linkedDeleteRequests.push(tasksApi.remove(task.id));
        }
      }

      if (deleteLinkedOptions.artifacts) {
        for (const artifact of artifactRecords) {
          linkedDeleteRequests.push(artifactsApi.remove(artifact.id));
        }
      }

      if (linkedDeleteRequests.length > 0) {
        const linkedDeleteResults = await Promise.allSettled(linkedDeleteRequests);
        const linkedDeleteFailed = linkedDeleteResults.filter((result) => result.status === "rejected").length;
        if (linkedDeleteFailed > 0) {
          setError(`Linked records deletion failed for ${linkedDeleteFailed} item(s). Project deletion was canceled.`);
          return;
        }
      }

      if (deleteLinkedOptions.artifacts && artifactItems.length > 0) {
        const sortedItems = [...artifactItems].sort(
          (a, b) => artifactPathDepth(b.path) - artifactPathDepth(a.path)
        );
        let itemDeleteFailures = 0;
        for (const item of sortedItems) {
          try {
            await artifactsApi.removeItem(item.id);
          } catch (itemDeleteError) {
            if (!isNotFoundError(itemDeleteError)) {
              itemDeleteFailures += 1;
            }
          }
        }
        if (itemDeleteFailures > 0) {
          setError(`Linked artifact items deletion failed for ${itemDeleteFailures} item(s). Project deletion was canceled.`);
          return;
        }
      }

      await projectsApi.remove(projectId);
      navigate("/projects", { replace: true });
    } catch (deleteError) {
      const message = readErrorMessage(deleteError);
      setError(isAuthErrorMessage(message) ? "Sign-in is required to delete this project." : message);
    } finally {
      setIsDeletingProject(false);
    }
  };

  if (!projectId) {
    return <p className="error">Project ID is missing.</p>;
  }

  if (isLoading) {
    return <p className="info">Loading project details...</p>;
  }

  if (authRequired) {
    return (
      <section className="project-detail-page">
        <header className="project-detail-top-row">
          <Link to="/projects" className="project-detail-back-link">
            {"< Back to Projects"}
          </Link>
        </header>
        <article className="panel project-detail-auth-panel">
          <h3>Sign in required</h3>
          <p>Please sign in to view this project.</p>
          <Link to="/settings" className="project-detail-settings-link">
            Open Settings
          </Link>
        </article>
      </section>
    );
  }

  return (
    <section className="project-detail-page">
      <header className="project-detail-top-row">
        <Link to="/projects" className="project-detail-back-link">
          {"< Back to Projects"}
        </Link>
      </header>

      <header className="project-detail-header">
        <p className="eyebrow">Project Detail View</p>
        <div className="project-title-row">
          {isEditingTitle ? (
            <>
              <input
                className="project-title-input"
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void handleSaveTitle();
                  } else if (event.key === "Escape") {
                    setIsEditingTitle(false);
                    setTitleDraft(displayTitle);
                  }
                }}
                aria-label="Project title"
                autoFocus
              />
              <div className="project-title-actions">
                <button type="button" className="ghost-button" onClick={() => setIsEditingTitle(false)} disabled={isSavingTitle}>
                  Cancel
                </button>
                <button type="button" onClick={() => void handleSaveTitle()} disabled={isSavingTitle}>
                  {isSavingTitle ? "Saving..." : "Save"}
                </button>
              </div>
            </>
          ) : (
            <button type="button" className="project-title-button" onClick={() => setIsEditingTitle(true)}>
              <h2>{displayTitle}</h2>
            </button>
          )}
        </div>
        <p className="project-detail-id">Project ID: {projectId}</p>
        {error ? <p className="project-detail-error">{error}</p> : null}
      </header>

      <nav className="project-tabs" aria-label="Project sections">
        {[
          { id: "overview" as const, label: "Overview" },
          { id: "tasks" as const, label: `Tasks (${tasks.length})` },
          { id: "notes" as const, label: `Notes (${notes.length})` },
          { id: "artifacts" as const, label: `Artifacts (${artifactCount})` },
          { id: "config" as const, label: "Config" }
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={activeTab === tab.id ? "project-tab active" : "project-tab"}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {activeTab === "overview" ? (
        <div className="project-tab-content stack">
          <div className="project-quick-links-grid">
            <Link to="/tasks" className="project-quick-link-card">
              <h3>Tasks</h3>
              <p>{tasks.length} tasks in this project</p>
            </Link>
            <Link to="/notes" className="project-quick-link-card">
              <h3>Notes</h3>
              <p>{notes.length} notes in this project</p>
            </Link>
            <Link to="/artifacts" className="project-quick-link-card">
              <h3>Artifacts</h3>
              <p>{artifactCount} artifacts in this project</p>
            </Link>
          </div>

          <article className="panel project-overview-panel">
            <h3>Overview</h3>
            <dl className="project-overview-meta">
              <div>
                <dt>Status</dt>
                <dd>{project?.status ?? "active"}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{formatDateTime(project?.createdAt)}</dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{formatDateTime(project?.updatedAt)}</dd>
              </div>
            </dl>
            <p className="project-overview-description">
              {trimOrUndefined(project?.description) ?? "No description yet."}
            </p>
          </article>
        </div>
      ) : null}

      {activeTab === "tasks" ? (
        <article className="panel project-detail-panel">
          <div className="project-detail-panel-head">
            <h3>Related Tasks</h3>
          </div>
          <ul className="project-detail-item-list">
            {tasks.map((task) => (
              <li key={task.id}>
                <strong>{task.title}</strong>
                <span>
                  {task.status} / load: {task.baseLoadScore}
                </span>
                <time>{formatDateTime(task.updatedAt)}</time>
              </li>
            ))}
            {tasks.length === 0 ? <li className="muted">No tasks</li> : null}
          </ul>
        </article>
      ) : null}

      {activeTab === "notes" ? (
        <article className="panel project-detail-panel">
          <div className="project-detail-panel-head">
            <h3>Related Notes</h3>
          </div>
          <ul className="project-detail-item-list">
            {notes.map((note) => (
              <li key={note.id}>
                <strong>{note.title}</strong>
                <span>{note.tags.join(", ") || "no tags"}</span>
                <p>{previewText(note.content)}</p>
                <time>{formatDateTime(note.updatedAt)}</time>
              </li>
            ))}
            {notes.length === 0 ? <li className="muted">No notes</li> : null}
          </ul>
        </article>
      ) : null}

      {activeTab === "artifacts" ? (
        <article className="panel project-detail-panel">
          <div className="project-detail-panel-head">
            <h3>Related Artifacts</h3>
          </div>
          <ul className="project-detail-item-list">
            {artifactEntries.map((artifact) => (
              <li key={artifact.id}>
                <strong>{artifact.title}</strong>
                <span>{artifact.type}</span>
                <p>{previewText(artifact.description)}</p>
                <time>{formatDateTime(artifact.updatedAt)}</time>
              </li>
            ))}
            {artifactEntries.length === 0 ? <li className="muted">No artifacts</li> : null}
          </ul>
        </article>
      ) : null}

      {activeTab === "config" ? (
        <article className="panel project-config-panel">
          <div className="project-config-head">
            <h3>Configuration</h3>
            <p>Manage project status and deletion behavior.</p>
          </div>

          <div className="project-config-options">
            <label className="project-switch-row">
              <div>
                <strong>Active</strong>
                <small>{isProjectActive ? "Project is active." : "Project is archived."}</small>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={isProjectActive}
                className={isProjectActive ? "project-switch active" : "project-switch"}
                onClick={() => void handleToggleProjectActive()}
                disabled={isSavingConfig || !project}
              >
                <span className="project-switch-thumb" />
              </button>
            </label>
          </div>

          <div className="project-config-head">
            <h3>Delete Configuration</h3>
            <p>Choose whether linked resources should be deleted together with this project.</p>
          </div>

          <div className="project-config-options">
            <label className="project-switch-row">
              <div>
                <strong>Delete related Notes</strong>
                <small>{notes.length} notes will be deleted when enabled.</small>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={deleteLinkedOptions.notes}
                className={deleteLinkedOptions.notes ? "project-switch active" : "project-switch"}
                onClick={() =>
                  setDeleteLinkedOptions((prev) => ({
                    ...prev,
                    notes: !prev.notes
                  }))
                }
              >
                <span className="project-switch-thumb" />
              </button>
            </label>

            <label className="project-switch-row">
              <div>
                <strong>Delete related Tasks</strong>
                <small>{tasks.length} tasks will be deleted when enabled.</small>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={deleteLinkedOptions.tasks}
                className={deleteLinkedOptions.tasks ? "project-switch active" : "project-switch"}
                onClick={() =>
                  setDeleteLinkedOptions((prev) => ({
                    ...prev,
                    tasks: !prev.tasks
                  }))
                }
              >
                <span className="project-switch-thumb" />
              </button>
            </label>

            <label className="project-switch-row">
              <div>
                <strong>Delete related Artifacts</strong>
                <small>{artifactCount} artifacts will be deleted when enabled.</small>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={deleteLinkedOptions.artifacts}
                className={deleteLinkedOptions.artifacts ? "project-switch active" : "project-switch"}
                onClick={() =>
                  setDeleteLinkedOptions((prev) => ({
                    ...prev,
                    artifacts: !prev.artifacts
                  }))
                }
              >
                <span className="project-switch-thumb" />
              </button>
            </label>
          </div>

          <div className="project-config-danger">
            <h4>Danger Zone</h4>
            <p>This operation cannot be undone. Deleted data cannot be recovered.</p>
            <button
              type="button"
              className="danger-button project-delete-button"
              onClick={() => void handleDeleteProject()}
              disabled={isDeletingProject}
            >
              {isDeletingProject ? "Deleting..." : "Delete Project"}
            </button>
          </div>
        </article>
      ) : null}
    </section>
  );
}
