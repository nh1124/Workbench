import { projectsClient } from "./internalClients.js";
import { recordUsageEventBestEffort } from "./usageEventsStore.js";

type JsonRecord = Record<string, unknown>;

export type ResourceReadInput = {
  accessToken: string;
  userId: string;
  sourceService: string;
  resourceType: string;
  resourceId: string;
  projectId?: string;
  metadataJson?: JsonRecord;
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function compactText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function responseItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const items = asRecord(value).items;
  return Array.isArray(items) ? items : [];
}

function contextIndexHitCount(context: unknown): number {
  const entries = asRecord(context).indexEntries;
  return Array.isArray(entries) ? entries.length : 0;
}

function truncatedSections(context: unknown): string[] {
  const sections = asRecord(asRecord(context).truncation).truncatedSections;
  return Array.isArray(sections)
    ? sections.filter((section): section is string => typeof section === "string" && section.trim().length > 0)
    : [];
}

function truncationMaxChars(context: unknown): number | undefined {
  const maxChars = asRecord(asRecord(context).truncation).maxChars;
  return typeof maxChars === "number" && Number.isFinite(maxChars) ? maxChars : undefined;
}

export function recordProjectContextUsageBestEffort(input: {
  userId: string;
  projectId: string;
  context: unknown;
  query?: string;
  source: "core-api" | "core-mcp";
}): void {
  const sections = truncatedSections(input.context);
  if (sections.length > 0) {
    recordUsageEventBestEffort({
      userId: input.userId,
      eventType: "context_truncation",
      projectId: input.projectId,
      metadataJson: {
        source: input.source,
        sections,
        maxChars: truncationMaxChars(input.context)
      }
    });
  }

  const query = compactText(input.query);
  if (query) {
    recordUsageEventBestEffort({
      userId: input.userId,
      eventType: "index_search",
      projectId: input.projectId,
      queryText: query,
      hitCount: contextIndexHitCount(input.context),
      metadataJson: {
        source: input.source,
        route: "projects.context.get"
      }
    });
  }
}

export function recordIndexSearchUsageBestEffort(input: {
  userId: string;
  projectId: string;
  query?: string;
  result: unknown;
  source: "core-api" | "core-mcp";
}): void {
  const query = compactText(input.query);
  if (!query) return;
  recordUsageEventBestEffort({
    userId: input.userId,
    eventType: "index_search",
    projectId: input.projectId,
    queryText: query,
    hitCount: responseItems(input.result).length,
    metadataJson: {
      source: input.source,
      route: "projects.index.search"
    }
  });
}

export function recordResourceReadUsageBestEffort(input: ResourceReadInput): void {
  const sourceService = compactText(input.sourceService);
  const resourceType = compactText(input.resourceType);
  const resourceId = compactText(input.resourceId);
  if (!sourceService || !resourceType || !resourceId) return;

  recordUsageEventBestEffort({
    userId: input.userId,
    eventType: "resource_read",
    projectId: compactText(input.projectId) ?? null,
    sourceService,
    resourceType,
    resourceId,
    metadataJson: input.metadataJson ?? { source: "core-mcp" }
  });

  void projectsClient.markIndexEntriesRead(input.accessToken, {
    marks: [{ sourceService, resourceId }]
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[usage] failed to mark index entry read", { sourceService, resourceId, message });
  });
}
