import { useEffect, useState, type FormEvent } from "react";
import { projectsApi } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { isProjectIndexEntryStale } from "../projectContextUtils";
import type { ProjectIndexEntry } from "../../types/models";

export function ProjectIndexPanel({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<ProjectIndexEntry[]>([]);
  const [query, setQuery] = useState("");
  const [resourceType, setResourceType] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await projectsApi.searchIndex(projectId, {
        q: query.trim() || undefined,
        resourceType: resourceType || undefined,
        limit: 100
      });
      setItems(result.items ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to search the Project index.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { void load(); }, [projectId]);

  const search = (event: FormEvent) => { event.preventDefault(); void load(); };
  const rebuild = async () => {
    if (!window.confirm("Rebuild this Project index to repair observed drift?")) return;
    setIsRebuilding(true);
    setError(null);
    try {
      await projectsApi.rebuildIndex(projectId);
      await load();
    } catch (rebuildError) {
      setError(rebuildError instanceof Error ? rebuildError.message : "Unable to rebuild the Project index.");
    } finally {
      setIsRebuilding(false);
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
