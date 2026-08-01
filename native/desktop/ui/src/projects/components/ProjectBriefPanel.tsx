import { useEffect, useState } from "react";
import { formatDateTime } from "../../lib/format";
import { projectsApi } from "../../lib/api";
import type { ProjectBriefRecord, ProjectContextSummary } from "../../types/models";
import { useProjectAsyncGuard } from "../hooks/useProjectAsyncGuard";
import { assessGeneratedSummaryFreshness } from "../projectContextUtils";

interface ProjectBriefPanelProps {
  projectId: string;
  brief?: ProjectBriefRecord | null;
  generatedSummary?: ProjectContextSummary | null;
  loadedSectionTimestamps?: Array<string | undefined>;
  onChanged?: () => void;
}

function isConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && (error as { status?: number }).status === 409;
}

export function ProjectBriefPanel({
  projectId,
  brief,
  generatedSummary,
  loadedSectionTimestamps = [],
  onChanged
}: ProjectBriefPanelProps) {
  const [currentBrief, setCurrentBrief] = useState<ProjectBriefRecord | null>(brief ?? null);
  const [currentSummary, setCurrentSummary] = useState<ProjectContextSummary | null>(generatedSummary ?? null);
  const [draft, setDraft] = useState(brief?.contentMarkdown ?? "");
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { beginRequest, isCurrentRequest, isCurrentProject, invalidateRequests } = useProjectAsyncGuard(projectId);
  const summaryFreshness = assessGeneratedSummaryFreshness(
    currentSummary?.updatedAt,
    [...loadedSectionTimestamps, currentBrief?.updatedAt]
  );

  useEffect(() => {
    invalidateRequests();
    setCurrentBrief(brief ?? null);
    setCurrentSummary(generatedSummary ?? null);
    setDraft(brief?.contentMarkdown ?? "");
    setIsEditing(false);
    setIsSaving(false);
    setIsRefreshing(false);
    setConflict(false);
    setError(null);
    return invalidateRequests;
  }, [invalidateRequests, projectId]);

  useEffect(() => {
    setCurrentBrief(brief ?? null);
    if (!isEditing) setDraft(brief?.contentMarkdown ?? "");
  }, [brief]);

  useEffect(() => setCurrentSummary(generatedSummary ?? null), [generatedSummary]);

  const reloadBrief = async () => {
    const request = beginRequest(projectId);
    setError(null);
    try {
      const loaded = await projectsApi.getBrief(projectId);
      if (!isCurrentRequest(request)) return;
      setCurrentBrief(loaded);
      setDraft(loaded.contentMarkdown);
      setConflict(false);
    } catch (loadError) {
      if (!isCurrentRequest(request)) return;
      setError(loadError instanceof Error ? loadError.message : "Unable to reload the brief.");
    }
  };

  const saveBrief = async () => {
    const operationProjectId = projectId;
    setIsSaving(true);
    setError(null);
    setConflict(false);
    try {
      const updated = await projectsApi.updateBrief(projectId, {
        contentMarkdown: draft,
        expectedVersion: currentBrief?.version ?? 0
      });
      if (!isCurrentProject(operationProjectId)) return;
      setCurrentBrief(updated);
      setIsEditing(false);
      onChanged?.();
    } catch (saveError) {
      if (!isCurrentProject(operationProjectId)) return;
      if (isConflict(saveError)) {
        setConflict(true);
      } else {
        setError(saveError instanceof Error ? saveError.message : "Unable to save the brief.");
      }
    } finally {
      if (isCurrentProject(operationProjectId)) setIsSaving(false);
    }
  };

  const refreshSummary = async () => {
    const operationProjectId = projectId;
    setIsRefreshing(true);
    setError(null);
    try {
      const refreshed = await projectsApi.refreshContextSummary(projectId);
      if (!isCurrentProject(operationProjectId)) return;
      setCurrentSummary(refreshed);
      onChanged?.();
    } catch (refreshError) {
      if (!isCurrentProject(operationProjectId)) return;
      setError(refreshError instanceof Error ? refreshError.message : "Unable to refresh the summary.");
    } finally {
      if (isCurrentProject(operationProjectId)) setIsRefreshing(false);
    }
  };

  return (
    <div className="project-context-grid">
      <article className="panel project-context-panel">
        <div className="project-context-panel-head">
          <div>
            <h3>Project Brief</h3>
            <p>Curated, authoritative operating rules for this Project.</p>
          </div>
          {!isEditing ? <button type="button" onClick={() => setIsEditing(true)}>Edit</button> : null}
        </div>
        {isEditing ? (
          <div className="project-context-form">
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={9} aria-label="Project brief" />
            <div className="project-context-actions">
              <button type="button" className="ghost-button" onClick={() => { setIsEditing(false); setDraft(currentBrief?.contentMarkdown ?? ""); }} disabled={isSaving}>Cancel</button>
              <button type="button" onClick={() => void saveBrief()} disabled={isSaving}>{isSaving ? "Saving..." : "Save brief"}</button>
            </div>
          </div>
        ) : (
          <p className="project-context-copy">{currentBrief?.contentMarkdown || "No Project brief yet."}</p>
        )}
        {currentBrief ? <small>Version {currentBrief.version} · Updated {formatDateTime(currentBrief.updatedAt)}</small> : null}
        {conflict ? (
          <div className="project-context-warning" role="alert">
            The brief changed in another session. Reload it before reconciling your edit.
            <button type="button" onClick={() => void reloadBrief()}>Reload latest brief</button>
          </div>
        ) : null}
        {error ? <p className="project-context-error">{error}</p> : null}
      </article>

      <article className="panel project-context-panel">
        <div className="project-context-panel-head">
          <div>
            <h3>Generated Summary</h3>
            <p>Rule-based context digest; it is not an authoritative instruction.</p>
          </div>
          <button type="button" onClick={() => void refreshSummary()} disabled={isRefreshing}>{isRefreshing ? "Refreshing..." : "Refresh"}</button>
        </div>
        <p className="project-context-copy">{currentSummary?.summaryText || "No generated summary yet."}</p>
        {currentSummary ? <small>{currentSummary.source} · Updated {formatDateTime(currentSummary.updatedAt)}</small> : null}
        {currentSummary ? (
          <p className={`project-context-freshness freshness-${summaryFreshness.state}`}>
            {summaryFreshness.message}
          </p>
        ) : null}
      </article>
    </div>
  );
}
