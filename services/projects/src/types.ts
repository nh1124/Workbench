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
