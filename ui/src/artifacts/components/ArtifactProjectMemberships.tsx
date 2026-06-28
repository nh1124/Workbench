import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { artifactsApi } from "../../lib/api";
import { normalizeProjectName } from "../../lib/format";
import type { ArtifactItem, ArtifactProjectMembership } from "../../types/models";
import { shouldReloadArtifactMemberships } from "../utils/membership";
import "./ArtifactProjectMemberships.css";

interface ArtifactProjectMembershipsProps {
  item: ArtifactItem;
  projects: Array<{ id: string; name: string; status?: "draft" | "active" | "archived" }>;
}

export function ArtifactProjectMemberships({ item, projects }: ArtifactProjectMembershipsProps) {
  const [memberships, setMemberships] = useState<ArtifactProjectMembership[]>([]);
  const [loadedItemId, setLoadedItemId] = useState<string | null>(null);
  const [targetProjectId, setTargetProjectId] = useState("");
  const [note, setNote] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadGenerationRef = useRef(0);
  const isMountedRef = useRef(false);
  const currentItemIdRef = useRef<string | null>(item.id);
  currentItemIdRef.current = item.id;

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const load = async (requestedItemId = item.id) => {
    if (!shouldReloadArtifactMemberships(requestedItemId, currentItemIdRef.current, isMountedRef.current)) return;
    const generation = ++loadGenerationRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const result = await artifactsApi.listProjectMemberships(requestedItemId);
      if (!shouldReloadArtifactMemberships(requestedItemId, currentItemIdRef.current, isMountedRef.current) || generation !== loadGenerationRef.current) return;
      setMemberships(result.memberships ?? []);
      setLoadedItemId(requestedItemId);
    } catch (loadError) {
      if (!shouldReloadArtifactMemberships(requestedItemId, currentItemIdRef.current, isMountedRef.current) || generation !== loadGenerationRef.current) return;
      setError(loadError instanceof Error ? loadError.message : "Project memberships are unavailable.");
      setMemberships([{ projectId: item.projectId, projectName: item.projectName, role: "primary" }]);
      setLoadedItemId(requestedItemId);
    } finally {
      if (isMountedRef.current && generation === loadGenerationRef.current) setIsLoading(false);
    }
  };

  useEffect(() => {
    currentItemIdRef.current = item.id;
    loadGenerationRef.current += 1;
    setLoadedItemId(null);
    setMemberships([{ projectId: item.projectId, projectName: item.projectName, role: "primary" }]);
    setTargetProjectId("");
    setNote("");
    setIsSaving(false);
    setError(null);
    void load();
    return () => {
      currentItemIdRef.current = null;
      loadGenerationRef.current += 1;
    };
  }, [item.id, item.projectId, item.version]);

  const secondary = loadedItemId === item.id
    ? memberships.filter((membership) => membership.role === "secondary")
    : [];
  const projectNameById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects]
  );
  const displayProjectName = (projectId: string, snapshotName?: string) =>
    normalizeProjectName(projectId, snapshotName || projectNameById.get(projectId));
  const primaryProjectId = memberships.find((membership) => membership.role === "primary")?.projectId ?? item.projectId;
  const linkedProjectIds = useMemo(
    () => new Set([primaryProjectId, ...secondary.map((membership) => membership.projectId)]),
    [primaryProjectId, secondary]
  );
  const availableProjects = projects.filter((project) => !linkedProjectIds.has(project.id) && project.status !== "archived");

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!targetProjectId || loadedItemId !== item.id) return;
    const operationItemId = item.id;
    setIsSaving(true);
    setError(null);
    try {
      await artifactsApi.linkProject(operationItemId, {
        projectId: targetProjectId,
        note: note.trim() || undefined,
        expectedArtifactVersion: item.version
      });
      if (!shouldReloadArtifactMemberships(operationItemId, currentItemIdRef.current, isMountedRef.current)) return;
      setTargetProjectId("");
      setNote("");
      await load(operationItemId);
    } catch (saveError) {
      if (shouldReloadArtifactMemberships(operationItemId, currentItemIdRef.current, isMountedRef.current)) {
        setError(saveError instanceof Error ? saveError.message : "Unable to add secondary Project membership.");
      }
    } finally {
      if (shouldReloadArtifactMemberships(operationItemId, currentItemIdRef.current, isMountedRef.current)) {
        setIsSaving(false);
      }
    }
  };

  const unlink = async (membership: ArtifactProjectMembership) => {
    if (loadedItemId !== item.id) return;
    const currentMembership = memberships.find((entry) => entry.projectId === membership.projectId);
    if (currentMembership?.role !== "secondary") return;
    const operationItemId = item.id;
    const label = displayProjectName(currentMembership.projectId, currentMembership.projectName);
    if (!window.confirm(`Remove the secondary Project membership for ${label}?\n\nThe Artifact itself will remain.`)) return;
    setIsSaving(true);
    setError(null);
    try {
      await artifactsApi.unlinkProject(operationItemId, currentMembership.projectId);
      if (!shouldReloadArtifactMemberships(operationItemId, currentItemIdRef.current, isMountedRef.current)) return;
      await load(operationItemId);
    } catch (unlinkError) {
      if (shouldReloadArtifactMemberships(operationItemId, currentItemIdRef.current, isMountedRef.current)) {
        setError(unlinkError instanceof Error ? unlinkError.message : "Unable to remove secondary membership.");
      }
    } finally {
      if (shouldReloadArtifactMemberships(operationItemId, currentItemIdRef.current, isMountedRef.current)) {
        setIsSaving(false);
      }
    }
  };

  return (
    <section className="artifact-memberships" aria-label="Artifact Project memberships">
      <ul className="artifact-membership-list">
        {secondary.map((membership) => <li key={membership.projectId}>
          <div><strong>{displayProjectName(membership.projectId, membership.projectName)}</strong>{membership.note ? <small>{membership.note}</small> : null}</div>
          <button type="button" className="artifact-membership-remove" onClick={() => void unlink(membership)} disabled={isSaving || isLoading || loadedItemId !== item.id} aria-label="Remove membership">Remove</button>
        </li>)}
        {secondary.length === 0 ? <li className="artifact-membership-empty">No secondary Projects.</li> : null}
      </ul>
      <form className="artifact-membership-form" onSubmit={add}>
        <select value={targetProjectId} onChange={(event) => setTargetProjectId(event.target.value)} aria-label="Secondary Project">
          <option value="">Add a secondary Project</option>
          {availableProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Note (optional)" />
        <button type="submit" className="artifact-membership-add" disabled={isSaving || isLoading || loadedItemId !== item.id || !targetProjectId}>{isSaving ? "Adding..." : "Add"}</button>
      </form>
      {item.kind === "folder" ? <p className="artifact-membership-warning">Secondary membership applies to this folder only. It is not inherited by descendants.</p> : null}
      {error ? <p className="artifact-membership-error">{error}</p> : null}
    </section>
  );
}
