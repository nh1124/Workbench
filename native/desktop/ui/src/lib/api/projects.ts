import { fetchProjectsFacadeJson } from "./transport";
import {
  buildProjectIndexQuery,
  buildProjectMemoryQuery
} from "../../projects/projectContextQueries";
import type {
  ProjectDefaultSelection,
  ProjectBriefRecord,
  ProjectContextPack,
  ProjectContextSummary,
  ProjectDeletionImpact,
  ProjectIndexListResult,
  ProjectLinkListResult,
  ProjectLinkRecord,
  ProjectListResult,
  ProjectMemoryAuthority,
  ProjectMemoryEntry,
  ProjectMemoryKind,
  ProjectMemoryListResult,
  ProjectMemoryStatus,
  ProjectRecord,
  ProjectRelation,
  ProjectRelationDirectionality,
  ProjectRelationListResult,
  ProjectRelationType
} from "../../types/models";

export const projectsApi = {
  list: (query?: string, status?: "draft" | "active" | "archived", limit?: number, cursor?: string): Promise<ProjectListResult> => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (status) params.set("status", status);
    if (limit) params.set("limit", String(limit));
    if (cursor) params.set("cursor", cursor);
    const queryString = params.toString();
    return fetchProjectsFacadeJson<ProjectListResult>(`/api/projects${queryString ? `?${queryString}` : ""}`);
  },
  get: (id: string): Promise<ProjectRecord> =>
    fetchProjectsFacadeJson<ProjectRecord>(`/api/projects/${encodeURIComponent(id)}`),
  create: (payload: { name: string; description?: string; status?: "draft" | "active" | "archived" }): Promise<ProjectRecord> =>
    fetchProjectsFacadeJson<ProjectRecord>("/api/projects", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  update: (id: string, payload: Partial<Pick<ProjectRecord, "name" | "description" | "status">>): Promise<ProjectRecord> =>
    fetchProjectsFacadeJson<ProjectRecord>(`/api/projects/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  remove: (id: string): Promise<void> =>
    fetchProjectsFacadeJson<void>(`/api/projects/${encodeURIComponent(id)}`, {
      method: "DELETE"
    }),
  getDefault: (): Promise<ProjectDefaultSelection> =>
    fetchProjectsFacadeJson<ProjectDefaultSelection>("/api/projects/default"),
  setDefault: (projectId: string): Promise<ProjectDefaultSelection> =>
    fetchProjectsFacadeJson<ProjectDefaultSelection>("/api/projects/default", {
      method: "PUT",
      body: JSON.stringify({ projectId })
    }),
  getContext: (
    id: string,
    options?: {
      q?: string;
      include?: Array<"brief" | "summary" | "memory" | "index" | "relations" | "links">;
      memoryLimit?: number;
      indexLimit?: number;
      relationLimit?: number;
      maxChars?: number;
    }
  ): Promise<ProjectContextPack> => {
    const params = new URLSearchParams();
    if (options?.q) params.set("q", options.q);
    if (options?.include?.length) params.set("include", options.include.join(","));
    if (options?.memoryLimit) params.set("memoryLimit", String(options.memoryLimit));
    if (options?.indexLimit) params.set("indexLimit", String(options.indexLimit));
    if (options?.relationLimit) params.set("relationLimit", String(options.relationLimit));
    if (options?.maxChars) params.set("maxChars", String(options.maxChars));
    const query = params.toString();
    return fetchProjectsFacadeJson<ProjectContextPack>(
      `/api/projects/${encodeURIComponent(id)}/context${query ? `?${query}` : ""}`
    );
  },
  getBrief: (id: string): Promise<ProjectBriefRecord> =>
    fetchProjectsFacadeJson<ProjectBriefRecord>(`/api/projects/${encodeURIComponent(id)}/brief`),
  updateBrief: (
    id: string,
    payload: { contentMarkdown: string; expectedVersion: number }
  ): Promise<ProjectBriefRecord> =>
    fetchProjectsFacadeJson<ProjectBriefRecord>(`/api/projects/${encodeURIComponent(id)}/brief`, {
      method: "PUT",
      body: JSON.stringify(payload)
    }),
  listMemories: (
    id: string,
    options?: {
      q?: string;
      kind?: ProjectMemoryKind;
      authority?: ProjectMemoryAuthority;
      status?: ProjectMemoryStatus;
      limit?: number;
      cursor?: string;
    }
  ): Promise<ProjectMemoryListResult> => {
    const query = buildProjectMemoryQuery(options);
    return fetchProjectsFacadeJson<ProjectMemoryListResult>(
      `/api/projects/${encodeURIComponent(id)}/memories${query ? `?${query}` : ""}`
    );
  },
  appendMemory: (
    id: string,
    payload: {
      kind: ProjectMemoryKind;
      bodyMarkdown: string;
      authority?: ProjectMemoryAuthority;
      sourceService?: string;
      sourceResourceType?: string;
      sourceResourceId?: string;
      confidence?: number;
      supersedesId?: string;
    }
  ): Promise<ProjectMemoryEntry> =>
    fetchProjectsFacadeJson<ProjectMemoryEntry>(`/api/projects/${encodeURIComponent(id)}/memories`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateMemory: (
    memoryId: string,
    payload: Partial<Pick<ProjectMemoryEntry, "bodyMarkdown" | "status">>
  ): Promise<ProjectMemoryEntry> =>
    fetchProjectsFacadeJson<ProjectMemoryEntry>(`/api/project-memories/${encodeURIComponent(memoryId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  archiveMemory: (memoryId: string): Promise<ProjectMemoryEntry> =>
    fetchProjectsFacadeJson<ProjectMemoryEntry>(`/api/project-memories/${encodeURIComponent(memoryId)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "archived" })
    }),
  searchIndex: (
    id: string,
    options?: { q?: string; sourceService?: string; resourceType?: string; limit?: number; cursor?: string }
  ): Promise<ProjectIndexListResult> => {
    const query = buildProjectIndexQuery(options);
    return fetchProjectsFacadeJson<ProjectIndexListResult>(
      `/api/projects/${encodeURIComponent(id)}/index${query ? `?${query}` : ""}`
    );
  },
  rebuildIndex: (id: string): Promise<{
    projectId: string;
    indexed: number;
    primary: number;
    secondary: number;
    tombstoned: number;
    staleLinksRemoved: number;
  }> =>
    fetchProjectsFacadeJson<{
      projectId: string;
      indexed: number;
      primary: number;
      secondary: number;
      tombstoned: number;
      staleLinksRemoved: number;
    }>(
      `/api/projects/${encodeURIComponent(id)}/index/rebuild`,
      { method: "POST" }
    ),
  listRelations: (id: string): Promise<ProjectRelationListResult> =>
    fetchProjectsFacadeJson<ProjectRelationListResult>(`/api/projects/${encodeURIComponent(id)}/relations`),
  addRelation: (
    id: string,
    payload: {
      targetProjectId: string;
      relationType: ProjectRelationType;
      directionality: ProjectRelationDirectionality;
      note?: string;
      strength?: number;
    }
  ): Promise<ProjectRelation> =>
    fetchProjectsFacadeJson<ProjectRelation>(`/api/projects/${encodeURIComponent(id)}/relations`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateRelation: (
    relationId: string,
    payload: Partial<Pick<ProjectRelation, "relationType" | "directionality" | "note" | "strength">> & {
      expectedVersion: number;
    }
  ): Promise<ProjectRelation> =>
    fetchProjectsFacadeJson<ProjectRelation>(`/api/project-relations/${encodeURIComponent(relationId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  removeRelation: (relationId: string): Promise<void> =>
    fetchProjectsFacadeJson<void>(`/api/project-relations/${encodeURIComponent(relationId)}`, {
      method: "DELETE"
    }),
  listLinks: (
    id: string,
    options?: {
      targetService?: string;
      targetResourceType?: string;
      relationType?: string;
      limit?: number;
      cursor?: string;
    }
  ): Promise<ProjectLinkListResult> => {
    const params = new URLSearchParams();
    if (options?.targetService) params.set("targetService", options.targetService);
    if (options?.targetResourceType) params.set("targetResourceType", options.targetResourceType);
    if (options?.relationType) params.set("relationType", options.relationType);
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.cursor) params.set("cursor", options.cursor);
    const query = params.toString();
    return fetchProjectsFacadeJson<ProjectLinkListResult>(
      `/api/projects/${encodeURIComponent(id)}/links${query ? `?${query}` : ""}`
    );
  },
  addLink: (
    id: string,
    payload: {
      targetService: string;
      targetResourceType: string;
      targetResourceId: string;
      relationType?: string;
      titleSnapshot?: string;
      summarySnapshot?: string;
      metadataJson?: Record<string, unknown>;
    }
  ): Promise<ProjectLinkRecord> =>
    fetchProjectsFacadeJson<ProjectLinkRecord>(`/api/projects/${encodeURIComponent(id)}/links`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  removeLink: (linkId: string): Promise<void> =>
    fetchProjectsFacadeJson<void>(`/api/project-links/${encodeURIComponent(linkId)}`, { method: "DELETE" }),
  getContextSummary: (id: string): Promise<ProjectContextSummary> =>
    fetchProjectsFacadeJson<ProjectContextSummary>(`/api/projects/${encodeURIComponent(id)}/context-summary`),
  refreshContextSummary: (id: string): Promise<ProjectContextSummary> =>
    fetchProjectsFacadeJson<ProjectContextSummary>(
      `/api/projects/${encodeURIComponent(id)}/context-summary/refresh`,
      { method: "POST" }
    ),
  getDeletionImpact: (id: string): Promise<ProjectDeletionImpact> =>
    fetchProjectsFacadeJson<ProjectDeletionImpact>(`/api/projects/${encodeURIComponent(id)}/deletion-impact`)
};

