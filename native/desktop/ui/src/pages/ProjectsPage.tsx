import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { projectsApi } from "../lib/api";
import { formatDateTime } from "../lib/format";
import type { ProjectRecord } from "../types/models";
import "./ProjectsPage.css";

type ProjectStatusFilter = "all" | ProjectRecord["status"];

interface ProjectDraft {
  name: string;
  description: string;
  status: ProjectRecord["status"];
}

const statusLabel: Record<ProjectRecord["status"], string> = {
  draft: "Draft",
  active: "Active",
  archived: "Archived"
};

const emptyDraft: ProjectDraft = {
  name: "",
  description: "",
  status: "active"
};

function isAuthErrorMessage(message: string): boolean {
  return /(missing bearer token|unauthori[sz]ed|unauthenticated|forbidden|401)/i.test(message);
}

const IcoProject = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <rect x="4" y="4" width="16" height="16" rx="2.4" />
    <path d="M8 8h8M8 12h8M8 16h5" />
  </svg>
);

const IcoSearch = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </svg>
);

const IcoClose = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

export function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<ProjectStatusFilter>("all");
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [draft, setDraft] = useState<ProjectDraft>(emptyDraft);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearchQuery(searchInput.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const loadProjects = async (cursor?: string) => {
    return projectsApi.list(searchQuery || undefined, statusFilter === "all" ? undefined : statusFilter, 24, cursor);
  };

  const refresh = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await loadProjects();
      setProjects(result.items);
      setNextCursor(result.nextCursor);
      setAuthRequired(false);
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "Unable to load projects right now.";
      if (isAuthErrorMessage(message)) {
        setAuthRequired(true);
        setError(null);
      } else {
        // API errors are routed to the global notification center.
        setError(null);
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [searchQuery, statusFilter]);

  const openCreateModal = () => {
    setDraft({
      ...emptyDraft,
      status: statusFilter === "all" ? "active" : statusFilter
    });
    setError(null);
    setIsCreateOpen(true);
  };

  const closeCreateModal = () => {
    if (isSaving) {
      return;
    }
    setIsCreateOpen(false);
    setDraft(emptyDraft);
    setError(null);
  };

  const handleCreate = async () => {
    if (!draft.name.trim()) {
      setError("Project name is required.");
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      await projectsApi.create({
        name: draft.name.trim(),
        description: draft.description.trim() || undefined,
        status: draft.status
      });

      closeCreateModal();
      await refresh();
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : "Unable to create project.";
      setError(isAuthErrorMessage(message) ? "Sign-in is required to create projects." : message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleLoadMore = async () => {
    if (!nextCursor || isLoadingMore) {
      return;
    }

    setIsLoadingMore(true);
    setError(null);

    try {
      const result = await loadProjects(nextCursor);
      setProjects((prev) => {
        const map = new Map(prev.map((project) => [project.id, project]));
        for (const project of result.items) {
          map.set(project.id, project);
        }
        return Array.from(map.values());
      });
      setNextCursor(result.nextCursor);
    } catch (loadMoreError) {
      const message = loadMoreError instanceof Error ? loadMoreError.message : "Unable to load more projects.";
      if (isAuthErrorMessage(message)) {
        setAuthRequired(true);
      }
    } finally {
      setIsLoadingMore(false);
    }
  };

  const visibleProjects = useMemo(
    () => [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [projects]
  );
  const hasMore = Boolean(nextCursor);
  const showNoData = !isLoading && !authRequired && visibleProjects.length === 0;
  const hasActiveFilters = searchQuery.length > 0 || statusFilter !== "all";

  return (
    <section className="projects-page">
      <header className="projects-header-row">
        <div className="projects-header-title-wrap">
          <span className="projects-header-icon" aria-hidden="true">
            <IcoProject />
          </span>
          <h2 className="projects-header-title">Project</h2>
        </div>
        <button type="button" className="projects-create-button" onClick={openCreateModal}>
          + New Project
        </button>
      </header>

      <section className="projects-filter-bar panel">
        <label className="projects-search-control" aria-label="Search projects">
          <span className="projects-search-icon" aria-hidden="true">
            <IcoSearch />
          </span>
          <input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search by project name or description"
          />
        </label>

        <label className="projects-status-filter" aria-label="Filter projects by status">
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as ProjectStatusFilter)}
          >
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="draft">Draft</option>
            <option value="archived">Archived</option>
          </select>
        </label>
      </section>

      <section className="projects-cards-surface panel">
        {authRequired ? (
          <div className="projects-state-card">
            <h3>Sign in required</h3>
            <p>Please sign in to view and manage projects in this workspace.</p>
            <div className="projects-state-actions">
              <Link to="/settings" className="projects-inline-link">
                Open Settings
              </Link>
            </div>
          </div>
        ) : null}

        {!authRequired && isLoading ? (
          <div className="projects-loading-state">
            <p>Loading projects...</p>
          </div>
        ) : null}

        {!authRequired && !isLoading && visibleProjects.length > 0 ? (
          <>
            <div className="projects-card-grid">
              {visibleProjects.map((project) => (
                <article key={project.id} className="project-card">
                  <div className="project-card-top-row">
                    <span className={`project-status-chip ${project.status}`}>{statusLabel[project.status]}</span>
                    <time>{formatDateTime(project.updatedAt)}</time>
                  </div>

                  <h3 className="project-card-title">{project.name}</h3>
                  <p className="project-card-description">{project.description?.trim() || "No description yet."}</p>

                  <div className="project-card-meta">
                    <div>
                      <small>Project ID</small>
                      <p>{project.id}</p>
                    </div>
                    <div>
                      <small>Created</small>
                      <p>{formatDateTime(project.createdAt)}</p>
                    </div>
                  </div>

                  <div className="project-card-actions">
                    <Link to={`/projects/${project.id}`} className="project-card-link">
                      Open Project View
                    </Link>
                  </div>
                </article>
              ))}
            </div>

            {hasMore ? (
              <div className="projects-load-more-row">
                <button type="button" className="ghost-button" onClick={() => void handleLoadMore()} disabled={isLoadingMore}>
                  {isLoadingMore ? "Loading..." : "Load More"}
                </button>
              </div>
            ) : null}
          </>
        ) : null}

        {showNoData ? (
          <div className="projects-state-card">
            {hasActiveFilters ? (
              <>
                <h3>No matching projects</h3>
                <p>Try a broader keyword or switch status.</p>
              </>
            ) : (
              <>
                <h3>No projects yet</h3>
                <p>Create your first project to start linking tasks, notes, and artifacts.</p>
              </>
            )}
            <div className="projects-state-actions">
              <button type="button" className="projects-create-empty" onClick={openCreateModal}>
                + Create Project
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {isCreateOpen ? (
        <div className="modal-backdrop" role="presentation" onClick={closeCreateModal}>
          <section
            className="projects-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Create project"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="projects-modal-head">
              <div>
                <h3>Create Project</h3>
                <p>Set name, status, and description for your new project.</p>
              </div>
              <button type="button" className="projects-modal-close" onClick={closeCreateModal} aria-label="Close">
                <IcoClose />
              </button>
            </header>

            <div className="projects-modal-body">
              {error ? <p className="projects-modal-error">{error}</p> : null}

              <label>
                Project Name
                <input
                  value={draft.name}
                  onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder="e.g. Workbench Revamp"
                />
              </label>

              <label>
                Status
                <select
                  value={draft.status}
                  onChange={(event) =>
                    setDraft((prev) => ({ ...prev, status: event.target.value as ProjectRecord["status"] }))
                  }
                >
                  <option value="active">Active</option>
                  <option value="draft">Draft</option>
                  <option value="archived">Archived</option>
                </select>
              </label>

              <label>
                Description
                <textarea
                  rows={6}
                  value={draft.description}
                  onChange={(event) => setDraft((prev) => ({ ...prev, description: event.target.value }))}
                  placeholder="Describe the project goals, constraints, or context."
                />
              </label>
            </div>

            <footer className="projects-modal-foot">
              <button type="button" className="ghost-button" onClick={closeCreateModal} disabled={isSaving}>
                Cancel
              </button>
              <button type="button" onClick={() => void handleCreate()} disabled={isSaving}>
                {isSaving ? "Creating..." : "Create Project"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </section>
  );
}
