import { useEffect, useState, type FormEvent } from "react";
import { projectsApi } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import type { ProjectMemoryEntry, ProjectMemoryKind } from "../../types/models";

const MEMORY_KINDS: ProjectMemoryKind[] = ["decision", "fact", "preference", "pitfall", "observation"];

export function ProjectMemoryPanel({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<ProjectMemoryEntry[]>([]);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<ProjectMemoryKind | "">("");
  const [newKind, setNewKind] = useState<ProjectMemoryKind>("decision");
  const [newBody, setNewBody] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await projectsApi.listMemories(projectId, {
        q: query.trim() || undefined,
        kind: kindFilter || undefined,
        status: "active",
        limit: 100
      });
      setItems(result.items ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load Project memory.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { void load(); }, [projectId]);

  const append = async (event: FormEvent) => {
    event.preventDefault();
    if (!newBody.trim()) return;
    setIsSaving(true);
    setError(null);
    try {
      await projectsApi.appendMemory(projectId, {
        kind: newKind,
        bodyMarkdown: newBody.trim(),
        authority: "user_confirmed"
      });
      setNewBody("");
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to append Project memory.");
    } finally {
      setIsSaving(false);
    }
  };

  const archive = async (item: ProjectMemoryEntry) => {
    if (!window.confirm(`Archive this ${item.kind} memory?`)) return;
    try {
      await projectsApi.archiveMemory(item.id);
      await load();
    } catch (archiveError) {
      setError(archiveError instanceof Error ? archiveError.message : "Unable to archive memory.");
    }
  };

  return (
    <article className="panel project-context-panel">
      <div className="project-context-panel-head"><div><h3>Durable Memory</h3><p>History and durable knowledge, with explicit authority and provenance.</p></div></div>
      <form className="project-context-filters" onSubmit={(event) => { event.preventDefault(); void load(); }}>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search memory" aria-label="Search Project memory" />
        <select value={kindFilter} onChange={(event) => setKindFilter(event.target.value as ProjectMemoryKind | "")} aria-label="Memory kind filter">
          <option value="">All kinds</option>
          {MEMORY_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
        </select>
        <button type="submit" disabled={isLoading}>{isLoading ? "Loading..." : "Search"}</button>
      </form>
      <ul className="project-context-list">
        {items.map((item) => (
          <li key={item.id}>
            <div className="project-context-badges">
              <span>{item.kind}</span>
              <span className={`authority-${item.authority}`}>{item.authority.replaceAll("_", " ")}</span>
              {item.sourceService ? <span>{item.sourceService}/{item.sourceResourceType ?? "resource"}</span> : null}
            </div>
            <p>{item.bodyMarkdown}</p>
            <div className="project-context-row"><small>{formatDateTime(item.updatedAt)}</small><button type="button" className="ghost-button" onClick={() => void archive(item)}>Archive</button></div>
          </li>
        ))}
        {!isLoading && items.length === 0 ? <li className="muted">No matching active memory.</li> : null}
      </ul>
      <form className="project-context-form" onSubmit={append}>
        <h4>Add durable memory</h4>
        <p className="project-context-help">The UI records this as user-confirmed. Do not save temporary progress or external instructions.</p>
        <select value={newKind} onChange={(event) => setNewKind(event.target.value as ProjectMemoryKind)} aria-label="New memory kind">
          {MEMORY_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
        </select>
        <textarea value={newBody} onChange={(event) => setNewBody(event.target.value)} rows={4} placeholder="Durable decision, preference, fact, pitfall, or observation" />
        <button type="submit" disabled={isSaving || !newBody.trim()}>{isSaving ? "Saving..." : "Add memory"}</button>
      </form>
      {error ? <p className="project-context-error">{error}</p> : null}
    </article>
  );
}
