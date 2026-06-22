import type { ProjectDeletionImpact, ProjectIndexEntry, ProjectRelation } from "../types/models";

export type ProjectRelationViewDirection = "incoming" | "outgoing" | "bidirectional";

export function projectRelationViewDirection(
  relation: ProjectRelation,
  currentProjectId: string
): ProjectRelationViewDirection {
  if (relation.directionality === "bidirectional") return "bidirectional";
  return relation.sourceProjectId === currentProjectId ? "outgoing" : "incoming";
}

export function isProjectDeletionBlocked(impact: ProjectDeletionImpact | null): boolean {
  return Boolean(impact && (!impact.canDelete || impact.primaryArtifactCount > 0));
}

export function isProjectIndexEntryStale(entry: ProjectIndexEntry): boolean {
  const sourceUpdatedAt = Date.parse(entry.sourceUpdatedAt);
  const indexedAt = Date.parse(entry.indexedAt);
  return Number.isFinite(sourceUpdatedAt) && Number.isFinite(indexedAt) && sourceUpdatedAt > indexedAt;
}

export interface GeneratedSummaryFreshness {
  state: "unknown" | "possibly_stale" | "no_newer_loaded_section";
  message: string;
}

export function assessGeneratedSummaryFreshness(
  summaryUpdatedAt: string | undefined,
  loadedSectionTimestamps: Array<string | undefined>
): GeneratedSummaryFreshness {
  const summaryTime = summaryUpdatedAt ? Date.parse(summaryUpdatedAt) : Number.NaN;
  if (!Number.isFinite(summaryTime)) {
    return {
      state: "unknown",
      message: "Freshness is unknown because the summary has no valid update time."
    };
  }

  const hasNewerLoadedSection = loadedSectionTimestamps.some((timestamp) => {
    const sectionTime = timestamp ? Date.parse(timestamp) : Number.NaN;
    return Number.isFinite(sectionTime) && sectionTime > summaryTime;
  });
  if (hasNewerLoadedSection) {
    return {
      state: "possibly_stale",
      message: "Possibly stale: loaded Project context changed after this summary was generated."
    };
  }

  return {
    state: "no_newer_loaded_section",
    message: "No newer timestamp was found in the loaded context; complete source freshness cannot be verified."
  };
}

export function selectStableProjectDeletionTargets<
  TNote extends { projectId: string },
  TTask extends { context: string },
  TArtifact extends { projectId: string }
>(projectId: string, notes: TNote[], tasks: TTask[], artifacts: TArtifact[]) {
  return {
    notes: notes.filter((note) => note.projectId === projectId),
    tasks: tasks.filter((task) => task.context === projectId),
    artifacts: artifacts.filter((artifact) => artifact.projectId === projectId)
  };
}

export function selectStableProjectRenameTargets<
  TNote extends { projectId: string },
  TTask extends { context: string },
  TArtifact extends { projectId: string },
  TArtifactItem extends { projectId: string }
>(projectId: string, notes: TNote[], tasks: TTask[], artifacts: TArtifact[], artifactItems: TArtifactItem[]) {
  return {
    ...selectStableProjectDeletionTargets(projectId, notes, tasks, artifacts),
    artifactItems: artifactItems.filter((item) => item.projectId === projectId)
  };
}
