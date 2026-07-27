import { Link } from "react-router-dom";
import type { AnalyserResourceRef } from "../../types/models";

function resourceRefLabel(ref: AnalyserResourceRef): string {
  return ref.pathSnapshot || `${ref.service}/${ref.resourceType}/${ref.resourceId}`;
}

export function ResourceReference({ resource }: { resource: AnalyserResourceRef }) {
  const labelText = resourceRefLabel(resource);
  if (resource.service === "notes") {
    return <Link to={`/notes?noteId=${encodeURIComponent(resource.resourceId)}`}>{labelText}</Link>;
  }
  if (resource.service === "artifacts") {
    return <Link to="/artifacts">{labelText}</Link>;
  }
  if (resource.service === "projects") {
    return <Link to={`/projects?projectId=${encodeURIComponent(resource.resourceId)}`}>{labelText}</Link>;
  }
  return <span>{labelText}</span>;
}


export function ReferenceList({ refs, labelText }: { refs: AnalyserResourceRef[]; labelText: string }) {
  if (refs.length === 0) return <p className="analyser-muted">No {labelText.toLowerCase()}.</p>;
  return (
    <div className="analyser-resource-refs" aria-label={labelText}>
      {refs.map((resource, index) => (
        <ResourceReference key={`${resource.service}:${resource.resourceType}:${resource.resourceId}:${index}`} resource={resource} />
      ))}
    </div>
  );
}


