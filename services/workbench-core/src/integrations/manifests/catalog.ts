import { integrationManifestIds, type IntegrationManifest, type IntegrationManifestId } from "../types.js";
import { artifactsManifest } from "./artifactsManifest.js";
import { deepResearchManifest } from "./deepResearchManifest.js";
import { notesManifest } from "./notesManifest.js";
import { projectsManifest } from "./projectsManifest.js";
import { tasksManifest } from "./tasksManifest.js";

const integrationManifestCatalog: Record<IntegrationManifestId, IntegrationManifest> = {
  notes: notesManifest,
  artifacts: artifactsManifest,
  tasks: tasksManifest,
  projects: projectsManifest,
  deep_research: deepResearchManifest
};

export function getIntegrationManifests(enabledIntegrationIds: ReadonlySet<string>): IntegrationManifest[] {
  return integrationManifestIds
    .filter((integrationId) => enabledIntegrationIds.has(integrationId))
    .map((integrationId) => integrationManifestCatalog[integrationId]);
}
