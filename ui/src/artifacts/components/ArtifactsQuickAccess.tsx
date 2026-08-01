import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { normalizeProjectName } from "../../lib/format";
import { useArtifactProjects } from "../hooks/useArtifactProjects";
import {
  PINNED_ARTIFACTS_CHANGED_EVENT,
  readPinnedArtifacts,
  type PinnedArtifact
} from "../utils/pins";
import {
  RECENT_ARTIFACTS_CHANGED_EVENT,
  readRecentArtifacts,
  type RecentArtifact
} from "../utils/recents";

const ARTIFACT_PROJECT_ROW_LIMIT = 8;

export function buildArtifactsHref(params: {
  projectId?: string;
  folderPath?: string;
  itemId?: string;
  newNote?: boolean;
}) {
  const query = new URLSearchParams();
  if (params.projectId) query.set("project", params.projectId);
  if (params.folderPath) query.set("folder", params.folderPath);
  if (params.itemId) query.set("item", params.itemId);
  if (params.newNote) query.set("new", "note");
  const queryString = query.toString();
  return queryString ? `/artifacts?${queryString}` : "/artifacts";
}

function ArtifactMenuIcon({ kind }: { kind: "folder" | "file" | "project" }) {
  return (
    <span className="artifacts-menu-icon" aria-hidden="true">
      {kind === "folder" ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M3 7h6l2 2h10v11H3z" />
        </svg>
      ) : kind === "project" ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <rect x="4" y="4" width="16" height="16" rx="2.4" />
          <path d="M8 8h8M8 12h8M8 16h5" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M7 3h8l4 4v14H7z" />
          <path d="M15 3v4h4" />
        </svg>
      )}
    </span>
  );
}

function pinnedArtifactHref(entry: PinnedArtifact) {
  if (entry.kind === "folder") {
    return buildArtifactsHref({ projectId: entry.projectId, folderPath: entry.path });
  }
  return buildArtifactsHref({ itemId: entry.itemId });
}

function recentArtifactHref(entry: RecentArtifact) {
  return buildArtifactsHref({ itemId: entry.itemId });
}

export function ArtifactsQuickAccess() {
  const navigate = useNavigate();
  const location = useLocation();
  const { projectOptions, projectsLoaded } = useArtifactProjects();
  const [pinnedArtifacts, setPinnedArtifacts] = useState<PinnedArtifact[]>(() => readPinnedArtifacts());
  const [recentArtifacts, setRecentArtifacts] = useState<RecentArtifact[]>(() => readRecentArtifacts(5));
  const currentProjectId = useMemo(
    () => new URLSearchParams(location.search).get("project") ?? "",
    [location.search]
  );
  const visibleProjects = projectOptions.slice(0, ARTIFACT_PROJECT_ROW_LIMIT);

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
    const refreshRecentArtifacts = () => setRecentArtifacts(readRecentArtifacts(5));
    window.addEventListener(RECENT_ARTIFACTS_CHANGED_EVENT, refreshRecentArtifacts);
    window.addEventListener("storage", refreshRecentArtifacts);
    return () => {
      window.removeEventListener(RECENT_ARTIFACTS_CHANGED_EVENT, refreshRecentArtifacts);
      window.removeEventListener("storage", refreshRecentArtifacts);
    };
  }, []);

  return (
    <nav className="artifacts-menu" aria-label="Artifacts quick access">
      <div className="artifacts-menu-header">
        <span>Quick access</span>
        <button
          type="button"
          className="artifacts-menu-header-action"
          title="New Note"
          aria-label="New Note"
          onClick={() => navigate(buildArtifactsHref({ projectId: currentProjectId || undefined, newNote: true }))}
        >
          + New Note
        </button>
      </div>

      {pinnedArtifacts.length > 0 ? (
        <div className="artifacts-menu-group">
          <div className="artifacts-menu-group-title">Pinned</div>
          {pinnedArtifacts.map((entry) => (
            <Link key={entry.itemId} className="artifacts-menu-row" to={pinnedArtifactHref(entry)} title={entry.title}>
              <ArtifactMenuIcon kind={entry.kind === "folder" ? "folder" : "file"} />
              <span>{entry.title}</span>
            </Link>
          ))}
        </div>
      ) : null}

      <div className="artifacts-menu-group">
        <div className="artifacts-menu-group-title">Projects</div>
        {projectsLoaded
          ? visibleProjects.map((project) => {
              const projectName = normalizeProjectName(project.projectId, project.projectName);
              const isCurrent = project.projectId === currentProjectId;
              return (
                <div
                  key={project.projectId}
                  className={isCurrent ? "artifacts-menu-project-row active" : "artifacts-menu-project-row"}
                >
                  <Link
                    className="artifacts-menu-row"
                    to={buildArtifactsHref({ projectId: project.projectId })}
                    title={projectName}
                    aria-current={isCurrent ? "page" : undefined}
                  >
                    <ArtifactMenuIcon kind="project" />
                    <span>{projectName}</span>
                  </Link>
                  <button
                    type="button"
                    className="artifacts-menu-new-note"
                    title="New Note"
                    aria-label={`New Note in ${projectName}`}
                    onClick={() => navigate(buildArtifactsHref({ projectId: project.projectId, newNote: true }))}
                  >
                    +
                  </button>
                </div>
              );
            })
          : null}
        {projectOptions.length > ARTIFACT_PROJECT_ROW_LIMIT ? (
          <Link className="artifacts-menu-row artifacts-menu-more" to="/artifacts">
            <span>More…</span>
          </Link>
        ) : null}
      </div>

      {recentArtifacts.length > 0 ? (
        <div className="artifacts-menu-group">
          <div className="artifacts-menu-group-title">Recent</div>
          {recentArtifacts.map((entry) => (
            <Link key={entry.itemId} className="artifacts-menu-row" to={recentArtifactHref(entry)} title={entry.title}>
              <ArtifactMenuIcon kind="file" />
              <span>{entry.title}</span>
            </Link>
          ))}
        </div>
      ) : null}
    </nav>
  );
}
