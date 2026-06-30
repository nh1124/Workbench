export type MindmapMode = "mindmap" | "logical_tree";
export type MindmapLayoutDirection = "right" | "left" | "radial" | "down";
export type MindmapExportFormat = "json" | "markdown" | "svg";

export interface MindmapNode {
  id: string;
  title: string;
  note?: string;
  markers?: string[];
  collapsed?: boolean;
  children?: MindmapNode[];
}

export interface MindmapDocumentBody {
  root: MindmapNode;
  layout?: {
    direction?: MindmapLayoutDirection;
  };
  theme?: {
    accentColor?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface MindmapDocumentRecord {
  id: string;
  ownerCoreUserId: string;
  title: string;
  description?: string;
  mode: MindmapMode;
  projectId?: string;
  projectName?: string;
  body: MindmapDocumentBody;
  tags: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MindmapListResult {
  items: MindmapDocumentRecord[];
  nextCursor?: string;
}

export interface MindmapCreateInput {
  title: string;
  description?: string;
  mode?: MindmapMode;
  projectId?: string;
  projectName?: string;
  body?: MindmapDocumentBody;
  tags?: string[];
  template?: "blank" | "mindmap" | "logical_tree";
}

export interface MindmapUpdateInput {
  title?: string;
  description?: string;
  mode?: MindmapMode;
  projectId?: string | null;
  projectName?: string | null;
  body?: MindmapDocumentBody;
  tags?: string[];
  expectedVersion?: number;
}

export interface MindmapExportContent {
  documentId: string;
  title: string;
  mode: MindmapMode;
  projectId?: string;
  projectName?: string;
  sourceVersion: number;
  format: MindmapExportFormat;
  filename: string;
  mimeType: string;
  contentText: string;
  contentBase64: string;
}

export interface MindmapArtifactExportInput {
  sourceVersion: number;
  artifactItemId: string;
  artifactItemPath?: string;
  artifactTitle?: string;
  projectId?: string;
  projectName?: string;
  exportFormat: MindmapExportFormat;
}

export interface MindmapArtifactExportRecord extends MindmapArtifactExportInput {
  id: string;
  documentId: string;
  ownerCoreUserId: string;
  createdAt: string;
}
