import { useEffect, useRef, useState, type FormEvent } from "react";
import { projectsApi } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { isProjectIndexEntryStale } from "../projectContextUtils";
import type { ProjectIndexEntry } from "../../types/models";
import { useProjectAsyncGuard } from "../hooks/useProjectAsyncGuard";

export function ProjectIndexPanel({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<ProjectIndexEntry[]>([]);
  const [query, setQuery] = useState("");
  const [resourceType, setResourceType] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { beginRequest, isCurrentRequest, isCurrentProject, invalidateRequests } = useProjectAsyncGuard(projectId);
  const appliedFiltersRef = useRef<{ q?: string; resourceType?: string }>({});
  const searchIntentRef = useRef(0);

  const load = async (
    requestedProjectId = projectId,
    filters = appliedFiltersRef.current
  ) => {
    const request = beginRequest(requestedProjectId);
    setIsLoading(true);
    setError(null);
    try {
      const result = await projectsApi.searchIndex(requestedProjectId, {
        ...filters,
        limit: 100
      });
      if (!isCurrentRequest(request)) return;
      setItems(result.items ?? []);
    } catch (loadError) {
      if (!isCurrentRequest(request)) return;
      setError(loadError instanceof Error ? loadError.message : "Unable to search the Project index.");
    } finally {
      if (isCurrentRequest(request)) setIsLoading(false);
    }
  };

  useEffect(() => {
    invalidateRequests();
    searchIntentRef.current += 1;
    appliedFiltersRef.current = {};
    setItems([]);
    setQuery("");
    setResourceType("");
    setIsRebuilding(false);
    setError(null);
    void load(projectId);
    return invalidateRequests;
  }, [projectId]);

  const search = (event: FormEvent) => {
    event.preventDefault();
    const filters = {
      q: query.trim() || undefined,
      resourceType: resourceType || undefined
    };
    appliedFiltersRef.current = filters;
    searchIntentRef.current += 1;
    void load(projectId, filters);
  };
  const rebuild = async () => {
    if (!window.confirm("Rebuild this Project index to repair observed drift?")) return;
    const operationProjectId = projectId;
    const searchIntentAtStart = searchIntentRef.current;
    setIsRebuilding(true);
    setError(null);
    try {
      await projectsApi.rebuildIndex(projectId);
      if (!isCurrentProject(operationProjectId)) return;
      if (searchIntentRef.current === searchIntentAtStart) {
        await load(operationProjectId, appliedFiltersRef.current);
      }
    } catch (rebuildError) {
      if (!isCurrentProject(operationProjectId)) return;
      setError(rebuildError instanceof Error ? rebuildError.message : "Unable to rebuild the Project index.");
    } finally {
      if (isCurrentProject(operationProjectId)) setIsRebuilding(false);
    }
  };

  return (
    <article className="panel project-context-panel">
      <div className="project-context-panel-head"><div><h3>Resource Index</h3><p>Search summaries before opening full resources. Index entries are derived data.</p></div><button type="button" className="ghost-button" onClick={() => void rebuild()} disabled={isRebuilding}>{isRebuilding ? "Rebuilding..." : "Repair index"}</button></div>
      <form className="project-context-filters" onSubmit={search}>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search path, title, or summary" aria-label="Search Project index" />
        <select value={resourceType} onChange={(event) => setResourceType(event.target.value)} aria-label="Index resource type">
          <option value="">All resource types</option><option value="folder">Folder</option><option value="note">Note</option><option value="file">File</option>
        </select>
        <button type="submit" disabled={isLoading}>{isLoading ? "Loading..." : "Search"}</button>
      </form>
      <ul className="project-context-list">
        {items.map((item) => {
          const stale = isProjectIndexEntryStale(item);
          return <li key={item.id}>
            <div className="project-context-badges"><span>{item.resourceType}</span><span>{item.associationKind}</span><span>{item.summarySource}</span>{stale ? <span className="project-context-stale">stale</span> : null}</div>
            <strong>{item.title}</strong><small>{item.path || item.resourceId}</small><p>{item.summaryText || "No summary."}</p><small>Indexed {formatDateTime(item.indexedAt)}</small>
          </li>;
        })}
        {!isLoading && items.length === 0 ? <li className="muted">No matching index entries.</li> : null}
      </ul>
      {error ? <p className="project-context-error">{error}</p> : null}
    </article>
  );
}
