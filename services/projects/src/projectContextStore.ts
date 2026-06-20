import { getProject, getProjectContextSummary, listProjectLinks } from "./store.js";
import { getProjectBrief } from "./projectBriefStore.js";
import { searchProjectIndex } from "./projectIndexStore.js";
import { listProjectMemories } from "./projectMemoryStore.js";
import { listProjectRelations } from "./projectRelationsStore.js";
import type { ProjectContextPack, ProjectContextSection } from "./types.js";
import { budgetProjectContext, clampContextMaxChars } from "./projectContextBudget.js";

const DEFAULT_CONTEXT_SECTIONS: ProjectContextSection[] = ["brief", "summary", "memory", "index", "relations", "links"];

export type GetProjectContextOptions = {
  query?: string;
  include?: ProjectContextSection[];
  memoryLimit?: number;
  indexLimit?: number;
  relationLimit?: number;
  linkLimit?: number;
  maxChars?: number;
};

export async function getProjectContext(
  projectId: string,
  ownerAccountId: string,
  options?: GetProjectContextOptions
): Promise<ProjectContextPack | undefined> {
  const project = await getProject(projectId, ownerAccountId);
  if (!project) return undefined;
  const include = new Set(options?.include?.length ? options.include : DEFAULT_CONTEXT_SECTIONS);
  const [brief, generatedSummary, memories, indexEntries, relations, links] = await Promise.all([
    include.has("brief") ? getProjectBrief(projectId, ownerAccountId) : undefined,
    include.has("summary") ? getProjectContextSummary(projectId, ownerAccountId) : undefined,
    include.has("memory") ? listProjectMemories(projectId, ownerAccountId, {
      query: options?.query, limit: options?.memoryLimit ?? 10
    }) : undefined,
    include.has("index") ? searchProjectIndex(projectId, ownerAccountId, {
      query: options?.query, limit: options?.indexLimit ?? 20
    }) : undefined,
    include.has("relations") ? listProjectRelations(projectId, ownerAccountId, {
      limit: options?.relationLimit ?? 10
    }) : undefined,
    include.has("links") ? listProjectLinks(projectId, ownerAccountId, {
      limit: options?.linkLimit ?? 10
    }) : undefined
  ]);

  const full: ProjectContextPack = {
    project,
    brief,
    generatedSummary,
    memories: memories?.items,
    indexEntries: indexEntries?.items,
    relations: relations?.items,
    links: links?.items,
    truncation: { maxChars: clampContextMaxChars(options?.maxChars), truncatedSections: [] }
  };
  return budgetProjectContext(full, options?.maxChars ?? 12_000);
}
