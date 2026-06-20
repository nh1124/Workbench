import { useEffect, useState } from "react";
import { projectsApi } from "../../lib/api";
import type { ProjectLinkRecord } from "../../types/models";

export function ProjectLinksPanel({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<ProjectLinkRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await projectsApi.listLinks(projectId, { limit: 100 });
      setItems(result.items ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load Project links.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { void load(); }, [projectId]);

  const remove = async (link: ProjectLinkRecord) => {
    if (link.relationType === "secondary_membership") return;
    if (!window.confirm("Remove this Project link? The linked resource will not be deleted.")) return;
    try {
      await projectsApi.removeLink(link.id);
      await load();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Unable to remove Project link.");
    }
  };

  return (
    <article className="panel project-context-panel">
      <div className="project-context-panel-head"><div><h3>Linked Resources</h3><p>Secondary resources remain single records in their owning service.</p></div></div>
      <ul className="project-context-list">
        {items.map((link) => <li key={link.id}>
          <div className="project-context-badges"><span>{link.targetService}</span><span>{link.targetResourceType}</span><span>{link.relationType}</span></div>
          <strong>{link.titleSnapshot || link.targetResourceId}</strong>
          {link.summarySnapshot ? <p>{link.summarySnapshot}</p> : null}
          {link.relationType === "secondary_membership" ? <small>Manage this membership from the Artifact detail. Unlinking does not delete the Artifact.</small> : <button type="button" className="ghost-button project-context-inline-action" onClick={() => void remove(link)}>Remove link</button>}
        </li>)}
        {!isLoading && items.length === 0 ? <li className="muted">No linked resources.</li> : null}
      </ul>
      {error ? <p className="project-context-error">{error}</p> : null}
    </article>
  );
}
