export const PROJECT_STATUSES = ["draft", "active", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export interface Project {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  ownerAccountId: string;
  isFallbackDefault?: boolean;
  isUserDefault?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectInput {
  name: string;
  description?: string;
  status?: ProjectStatus;
  ownerAccountId?: string;
}

export interface ProjectListResult {
  items: Project[];
  nextCursor?: string;
}

export interface DefaultProjectSelection {
  project: Project;
  source: "user" | "fallback";
}

export interface ProjectLink {
  id: string;
  projectId: string;
  targetService: string;
  targetResourceType: string;
  targetResourceId: string;
  relationType: string;
  titleSnapshot?: string;
  summarySnapshot?: string;
  linkedAt: string;
  metadataJson: Record<string, unknown>;
}

export interface ProjectLinkInput {
  targetService: string;
  targetResourceType: string;
  targetResourceId: string;
  relationType?: string;
  titleSnapshot?: string;
  summarySnapshot?: string;
  metadataJson?: Record<string, unknown>;
}

export interface ProjectLinkListResult {
  items: ProjectLink[];
  nextCursor?: string;
}

export interface ProjectContextSummary {
  id: string;
  projectId: string;
  summaryText: string;
  source: string;
  updatedAt: string;
}

export const PROJECT_MEMORY_KINDS = ["decision", "fact", "preference", "pitfall", "observation"] as const;
export type ProjectMemoryKind = (typeof PROJECT_MEMORY_KINDS)[number];
export const PROJECT_MEMORY_AUTHORITIES = ["user_confirmed", "agent_observed", "imported"] as const;
export type ProjectMemoryAuthority = (typeof PROJECT_MEMORY_AUTHORITIES)[number];
export const PROJECT_MEMORY_STATUSES = ["active", "superseded", "archived"] as const;
export type ProjectMemoryStatus = (typeof PROJECT_MEMORY_STATUSES)[number];
export const PROJECT_MEMORY_LIFECYCLE_STATES = ["raw", "triaged", "curated", "verified"] as const;
export type ProjectMemoryLifecycleState = (typeof PROJECT_MEMORY_LIFECYCLE_STATES)[number];
export const PROJECT_MEMORY_REVIEW_REASONS = ["conflict", "manual"] as const;
export type ProjectMemoryReviewReason = (typeof PROJECT_MEMORY_REVIEW_REASONS)[number];
export const CREATED_BY_KINDS = ["user", "agent", "system"] as const;
export type CreatedByKind = (typeof CREATED_BY_KINDS)[number];

export interface ProjectBrief {
  projectId: string;
  contentMarkdown: string;
  version: number;
  updatedByKind: "user" | "agent";
  updatedAt: string;
}

export interface ProjectBriefUpdateInput {
  contentMarkdown: string;
  expectedVersion: number;
  updatedByKind: "user" | "agent";
}

export interface ProjectMemoryEntry {
  id: string;
  projectId: string;
  kind: ProjectMemoryKind;
  bodyMarkdown: string;
  authority: ProjectMemoryAuthority;
  sourceService?: string;
  sourceResourceType?: string;
  sourceResourceId?: string;
  confidence?: number;
  status: ProjectMemoryStatus;
  supersedesId?: string;
  lifecycleState?: ProjectMemoryLifecycleState;
  reviewAfter?: string | null;
  lastConfirmedAt?: string | null;
  reviewReason?: ProjectMemoryReviewReason | null;
  createdByKind: CreatedByKind;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMemoryInput {
  kind: ProjectMemoryKind;
  bodyMarkdown: string;
  authority: ProjectMemoryAuthority;
  sourceService?: string;
  sourceResourceType?: string;
  sourceResourceId?: string;
  confidence?: number;
  supersedesId?: string;
  lifecycleState?: ProjectMemoryLifecycleState;
  reviewAfter?: string | null;
  reviewReason?: ProjectMemoryReviewReason | null;
  createdByKind: CreatedByKind;
}

export interface ProjectMemoryUpdateInput {
  bodyMarkdown?: string;
  status?: ProjectMemoryStatus;
  authority?: ProjectMemoryAuthority;
  lifecycleState?: ProjectMemoryLifecycleState;
  reviewAfter?: string | null;
  reviewReason?: ProjectMemoryReviewReason | null;
}

export interface ProjectMemoryListResult {
  items: ProjectMemoryEntry[];
  nextCursor?: string;
}

export const MAINTENANCE_QUEUE_REASONS = [
  "raw",
  "expired",
  "unconfirmed",
  "conflict",
  "manual",
  "source_changed",
  "unused",
  "brief_unmaintained",
  "brief_oversized"
] as const;
export type MaintenanceQueueReason = (typeof MAINTENANCE_QUEUE_REASONS)[number];
export type MaintenanceQueueKind = "memory" | "brief" | "index_drift";

export interface MaintenanceQueueItem {
  id: string;
  kind: MaintenanceQueueKind;
  projectId: string;
  projectName: string;
  resourceId: string;
  title: string;
  excerpt: string;
  reasons: MaintenanceQueueReason[];
  authority?: ProjectMemoryAuthority;
  lifecycleState?: ProjectMemoryLifecycleState;
  lastConfirmedAt?: string | null;
  reviewAfter?: string | null;
  updatedAt: string;
  suggestedActions: string[];
}

export interface MaintenanceQueueListResult {
  items: MaintenanceQueueItem[];
  nextCursor?: string;
  totals: {
    byReason: Partial<Record<MaintenanceQueueReason, number>>;
  };
}

export const PROJECT_INDEX_ASSOCIATION_KINDS = ["primary", "secondary"] as const;
export type ProjectIndexAssociationKind = (typeof PROJECT_INDEX_ASSOCIATION_KINDS)[number];
export const PROJECT_INDEX_SEARCH_MODES = ["any", "all"] as const;
export type ProjectIndexSearchMode = (typeof PROJECT_INDEX_SEARCH_MODES)[number];
export const PROJECT_INDEX_SEARCH_FIELDS = ["path", "title", "summary", "metadata", "content"] as const;
export type ProjectIndexSearchField = (typeof PROJECT_INDEX_SEARCH_FIELDS)[number];

export interface ProjectIndexEntry {
  id: string;
  projectId: string;
  sourceService: string;
  resourceType: string;
  resourceId: string;
  associationKind: ProjectIndexAssociationKind;
  associationId?: string;
  path?: string;
  title: string;
  summaryText: string;
  summarySource: string;
  sourceVersion?: string;
  contentHash?: string;
  sourceUpdatedAt: string;
  indexedAt: string;
  lastReadAt?: string;
  metadataJson: Record<string, unknown>;
  matchedTokens?: number;
}

export interface ProjectIndexEntryInput {
  sourceService: string;
  resourceType: string;
  resourceId: string;
  associationKind: ProjectIndexAssociationKind;
  associationId?: string;
  path?: string;
  title: string;
  summaryText: string;
  contentText?: string;
  summarySource?: string;
  sourceVersion?: string;
  contentHash?: string;
  sourceUpdatedAt: string;
  metadataJson?: Record<string, unknown>;
}

export interface ProjectIndexListResult {
  items: ProjectIndexEntry[];
  nextCursor?: string;
  appliedQuery?: {
    tokens: string[];
    mode: ProjectIndexSearchMode;
    fields: ProjectIndexSearchField[];
  };
}

export const PROJECT_RELATION_TYPES = ["related", "depends_on", "supports", "informs", "overlaps"] as const;
export type ProjectRelationType = (typeof PROJECT_RELATION_TYPES)[number];
export const PROJECT_RELATION_DIRECTIONS = ["directed", "bidirectional"] as const;
export type ProjectRelationDirection = (typeof PROJECT_RELATION_DIRECTIONS)[number];
export const PROJECT_RELATION_ORIGINS = ["manual", "inferred"] as const;
export type ProjectRelationOrigin = (typeof PROJECT_RELATION_ORIGINS)[number];

export interface ProjectRelation {
  id: string;
  sourceProjectId: string;
  targetProjectId: string;
  relationType: ProjectRelationType;
  directionality: ProjectRelationDirection;
  note: string;
  origin: ProjectRelationOrigin;
  strength?: number;
  createdByKind: CreatedByKind;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRelationInput {
  targetProjectId: string;
  relationType: ProjectRelationType;
  directionality?: ProjectRelationDirection;
  note?: string;
  origin?: ProjectRelationOrigin;
  strength?: number;
  createdByKind: CreatedByKind;
}

export interface ProjectRelationUpdateInput {
  relationType?: ProjectRelationType;
  directionality?: ProjectRelationDirection;
  note?: string;
  origin?: ProjectRelationOrigin;
  strength?: number | null;
  expectedVersion: number;
}

export interface ProjectRelationListResult {
  items: ProjectRelation[];
  nextCursor?: string;
}

export type ProjectContextSection = "brief" | "summary" | "memory" | "index" | "relations" | "links";

export interface ProjectContextPack {
  project: Project;
  brief?: ProjectBrief;
  generatedSummary?: ProjectContextSummary;
  memories?: ProjectMemoryEntry[];
  indexEntries?: ProjectIndexEntry[];
  relations?: ProjectRelation[];
  links?: ProjectLink[];
  truncation: {
    maxChars: number;
    truncatedSections: ProjectContextSection[];
  };
}

export interface ProjectSyncContextSnapshot {
  projectId: string;
  complete: true;
  counts: {
    memories: number;
    relations: number;
  };
  project: Project;
  brief: ProjectBrief;
  memories: ProjectMemoryEntry[];
  relations: ProjectRelation[];
}

export interface ProjectContextExportSnapshot {
  schemaVersion: 1;
  packageType: "workbench.project-context-export";
  generatedAt: string;
  complete: true;
  project: Project;
  brief: ProjectBrief;
  memories: ProjectMemoryEntry[];
  relations: ProjectRelation[];
  links: ProjectLink[];
  indexEntries: ProjectIndexEntry[];
  generatedSummary: ProjectContextSummary | null;
  counts: {
    memories: number;
    relations: number;
    links: number;
    indexEntries: number;
  };
}
