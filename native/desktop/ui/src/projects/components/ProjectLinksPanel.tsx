import { useEffect, useState } from "react";
import { projectsApi } from "../../lib/api";
import type { ProjectLinkRecord } from "../../types/models";
import { useProjectAsyncGuard } from "../hooks/useProjectAsyncGuard";

export function ProjectLinksPanel({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<ProjectLinkRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { beginRequest, isCurrentRequest, isCurrentProject, invalidateRequests } = useProjectAsyncGuard(projectId);

  const load = async (requestedProjectId = projectId) => {
    const request = beginRequest(requestedProjectId);
    setIsLoading(true);
    setError(null);
    try {
      const result = await projectsApi.listLinks(requestedProjectId, { limit: 100 });
      if (!isCurrentRequest(request)) return;
      setItems(result.items ?? []);
    } catch (loadError) {
      if (!isCurrentRequest(request)) return;
      setError(loadError instanceof Error ? loadError.message : "Unable to load Project links.");
    } finally {
      if (isCurrentRequest(request)) setIsLoading(false);
    }
  };

  useEffect(() => {
    invalidateRequests();
    setItems([]);
    setError(null);
    void load(projectId);
    return invalidateRequests;
  }, [projectId]);

  const remove = async (link: ProjectLinkRecord) => {
    if (link.relationType === "secondary_membership") return;
    if (!window.confirm("Remove this Project link? The linked resource will not be deleted.")) return;
    const operationProjectId = projectId;
    try {
      await projectsApi.removeLink(link.id);
      if (!isCurrentProject(operationProjectId)) return;
      await load(operationProjectId);
    } catch (removeError) {
      if (!isCurrentProject(operationProjectId)) return;
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
