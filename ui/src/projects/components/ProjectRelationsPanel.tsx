import { useEffect, useMemo, useState, type FormEvent } from "react";
import { projectsApi } from "../../lib/api";
import { normalizeProjectName } from "../../lib/format";
import type {
  ProjectRecord,
  ProjectRelation,
  ProjectRelationDirectionality,
  ProjectRelationType
} from "../../types/models";
import { projectRelationViewDirection } from "../projectContextUtils";
import { useProjectAsyncGuard } from "../hooks/useProjectAsyncGuard";

const RELATION_TYPES: ProjectRelationType[] = ["related", "depends_on", "supports", "informs", "overlaps"];

function isConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && (error as { status?: number }).status === 409;
}

export function ProjectRelationsPanel({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<ProjectRelation[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [targetProjectId, setTargetProjectId] = useState("");
  const [relationType, setRelationType] = useState<ProjectRelationType>("related");
  const [directionality, setDirectionality] = useState<ProjectRelationDirectionality>("directed");
  const [note, setNote] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { beginRequest, isCurrentRequest, isCurrentProject, invalidateRequests } = useProjectAsyncGuard(projectId);

  const projectNames = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);

  const load = async (requestedProjectId = projectId) => {
    const request = beginRequest(requestedProjectId);
    setIsLoading(true);
    setError(null);
    try {
      const [relations, projectList] = await Promise.all([
        projectsApi.listRelations(requestedProjectId),
        projectsApi.list(undefined, undefined, 200)
      ]);
      if (!isCurrentRequest(request)) return;
      setItems(relations.items ?? []);
      setProjects(projectList.items ?? []);
    } catch (loadError) {
      if (!isCurrentRequest(request)) return;
      setError(loadError instanceof Error ? loadError.message : "Unable to load Project relations.");
    } finally {
      if (isCurrentRequest(request)) setIsLoading(false);
    }
  };

  useEffect(() => {
    invalidateRequests();
    setItems([]);
    setProjects([]);
    setTargetProjectId("");
    setIsSaving(false);
    setError(null);
    void load(projectId);
    return invalidateRequests;
  }, [projectId]);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!targetProjectId) return;
    const operationProjectId = projectId;
    setIsSaving(true);
    setError(null);
    try {
      await projectsApi.addRelation(projectId, {
        targetProjectId,
        relationType,
        directionality,
        note: note.trim() || undefined
      });
      if (!isCurrentProject(operationProjectId)) return;
      setTargetProjectId("");
      setNote("");
      await load(operationProjectId);
    } catch (saveError) {
      if (!isCurrentProject(operationProjectId)) return;
      setError(saveError instanceof Error ? saveError.message : "Unable to add Project relation.");
    } finally {
      if (isCurrentProject(operationProjectId)) setIsSaving(false);
    }
  };

  const remove = async (relation: ProjectRelation) => {
    if (!window.confirm(`Remove the ${relation.relationType} Project relation?`)) return;
    const operationProjectId = projectId;
    try {
      await projectsApi.removeRelation(relation.id);
      if (!isCurrentProject(operationProjectId)) return;
      await load(operationProjectId);
    } catch (removeError) {
      if (!isCurrentProject(operationProjectId)) return;
      setError(removeError instanceof Error ? removeError.message : "Unable to remove Project relation.");
    }
  };

  const editNote = async (relation: ProjectRelation) => {
    const nextNote = window.prompt("Update the reason for this Project relation:", relation.note ?? "");
    if (nextNote === null || nextNote.trim() === (relation.note ?? "")) return;
    const operationProjectId = projectId;
    try {
      await projectsApi.updateRelation(relation.id, {
        note: nextNote.trim(),
        expectedVersion: relation.version
      });
      if (!isCurrentProject(operationProjectId)) return;
      await load(operationProjectId);
    } catch (updateError) {
      if (!isCurrentProject(operationProjectId)) return;
      if (isConflict(updateError)) {
        await load(operationProjectId);
        if (!isCurrentProject(operationProjectId)) return;
        setError("This relation changed in another session. The latest version was reloaded; review it before editing again.");
      } else {
        setError(updateError instanceof Error ? updateError.message : "Unable to update Project relation.");
      }
    }
  };

  return (
    <article className="panel project-context-panel">
      <div className="project-context-panel-head"><div><h3>Project Network</h3><p>Typed Project-to-Project relations. They do not propagate Artifact membership.</p></div></div>
      <ul className="project-context-list">
        {items.map((relation) => {
          const viewDirection = projectRelationViewDirection(relation, projectId);
          const otherId = relation.sourceProjectId === projectId ? relation.targetProjectId : relation.sourceProjectId;
          const otherName = relation.sourceProjectId === projectId ? relation.targetProjectName : relation.sourceProjectName;
          return <li key={relation.id}>
            <div className="project-context-badges"><span>{viewDirection}</span><span>{relation.relationType}</span><span className={`authority-${relation.origin}`}>{relation.origin}</span></div>
            <strong>{normalizeProjectName(otherId, otherName ?? projectNames.get(otherId))}</strong>
            {relation.note ? <p>{relation.note}</p> : null}
            <div className="project-context-actions project-context-inline-action"><button type="button" className="ghost-button" onClick={() => void editNote(relation)}>Edit note</button><button type="button" className="ghost-button" onClick={() => void remove(relation)}>Remove relation</button></div>
          </li>;
        })}
        {!isLoading && items.length === 0 ? <li className="muted">No Project relations.</li> : null}
      </ul>
      <form className="project-context-form" onSubmit={add}>
        <h4>Add Project relation</h4>
        <select value={targetProjectId} onChange={(event) => setTargetProjectId(event.target.value)} required aria-label="Related Project">
          <option value="">Select a Project</option>
          {projects.filter((project) => project.id !== projectId).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <div className="project-context-filters">
          <select value={relationType} onChange={(event) => setRelationType(event.target.value as ProjectRelationType)} aria-label="Relation type">{RELATION_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</select>
          <select value={directionality} onChange={(event) => setDirectionality(event.target.value as ProjectRelationDirectionality)} aria-label="Relation direction"><option value="directed">Directed</option><option value="bidirectional">Bidirectional</option></select>
        </div>
        <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Why are these Projects related?" />
        <button type="submit" disabled={isSaving || !targetProjectId}>{isSaving ? "Saving..." : "Add relation"}</button>
      </form>
      {error ? <p className="project-context-error">{error}</p> : null}
    </article>
  );
}
