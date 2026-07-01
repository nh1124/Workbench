export type WbsItemStatus = "todo" | "doing" | "blocked" | "done";

export type WbsDependencyType =
  | "finish_to_start"
  | "start_to_start"
  | "finish_to_finish"
  | "start_to_finish";

export type WbsExportFormat = "json" | "markdown" | "csv";

export interface WbsRollup {
  effortHours: number;
  progress: number;
  itemCount: number;
  doneCount: number;
}

export interface WbsPlanRecord {
  id: string;
  ownerCoreUserId: string;
  projectId?: string;
  projectName?: string;
  title: string;
  description: string;
  settings: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
  rollup?: WbsRollup;
}

export interface WbsListResult {
  items: WbsPlanRecord[];
  nextCursor?: string;
}

export interface WbsPlanCreateInput {
  title: string;
  description?: string;
  projectId?: string;
  projectName?: string;
  settings?: Record<string, unknown>;
}

export interface WbsPlanUpdateInput {
  expectedVersion: number;
  title?: string;
  description?: string;
  projectId?: string | null;
  projectName?: string | null;
  settings?: Record<string, unknown>;
}

export interface WbsItemRecord {
  id: string;
  ownerCoreUserId: string;
  planId: string;
  parentId?: string;
  code: string;
  title: string;
  description: string;
  sortOrder: number;
  ownerLabel?: string;
  startDate?: string;
  dueDate?: string;
  effortHours?: number;
  status: WbsItemStatus;
  progress?: number;
  linkedTaskId?: string;
  metadata: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
  rollup?: WbsRollup;
}

export interface WbsItemCreateInput {
  parentId?: string;
  title: string;
  description?: string;
  ownerLabel?: string;
  startDate?: string;
  dueDate?: string;
  effortHours?: number;
  status?: WbsItemStatus;
  progress?: number;
}

export interface WbsItemUpdateInput {
  expectedVersion: number;
  title?: string;
  description?: string;
  ownerLabel?: string | null;
  startDate?: string | null;
  dueDate?: string | null;
  effortHours?: number | null;
  status?: WbsItemStatus;
  progress?: number | null;
  linkedTaskId?: string | null;
}

export interface WbsItemMoveInput {
  expectedVersion: number;
  parentId?: string | null;
  beforeItemId?: string;
  afterItemId?: string;
}

export interface WbsDependencyRecord {
  id: string;
  ownerCoreUserId: string;
  planId: string;
  fromItemId: string;
  toItemId: string;
  dependencyType: WbsDependencyType;
  lagDays: number;
  createdAt: string;
}

export interface WbsDependencyCreateInput {
  fromItemId: string;
  toItemId: string;
  dependencyType?: WbsDependencyType;
  lagDays?: number;
}

export interface WbsExportContent {
  planId: string;
  title: string;
  projectId?: string;
  projectName?: string;
  sourceVersion: number;
  format: WbsExportFormat;
  filename: string;
  mimeType: string;
  contentText: string;
  contentBase64: string;
}

export interface WbsArtifactExportInput {
  sourceVersion: number;
  artifactItemId: string;
  artifactPath?: string;
  format: WbsExportFormat;
}

export interface WbsArtifactExportRecord extends WbsArtifactExportInput {
  id: string;
  planId: string;
  ownerCoreUserId: string;
  exportedAt: string;
}
