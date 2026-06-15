export interface Artifact {
  id: string;
  name: string;
  type: string;
  description: string;
  projectId: string;
  projectName?: string;
  url?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactInput {
  name: string;
  type: string;
  description: string;
  projectId: string;
  projectName?: string;
  url?: string;
}

export interface ArtifactProjectSummary {
  projectId: string;
  projectName?: string;
  artifactCount: number;
  latestUpdatedAt: string;
}

export type ArtifactItemKind = "folder" | "note" | "file";
export type ArtifactScope = "private" | "org" | "project";
export type ArtifactPreviewStatus = "pending" | "ready" | "error";

export interface ArtifactItem {
  id: string;
  projectId: string;
  projectName?: string;
  kind: ArtifactItemKind;
  title: string;
  path: string;
  parentPath: string;
  scope: ArtifactScope;
  tags: string[];
  mimeType?: string;
  sizeBytes?: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  contentMarkdown?: string;
  previewPdfStatus?: ArtifactPreviewStatus;
  previewPdfUpdatedAt?: string;
}

export interface ArtifactFolderInput {
  projectId?: string;
  projectName?: string;
  path: string;
  title?: string;
  scope?: ArtifactScope;
}

export interface ArtifactNoteInput {
  projectId?: string;
  projectName?: string;
  path?: string;
  title: string;
  scope?: ArtifactScope;
  tags?: string[];
  contentMarkdown?: string;
}

export interface ArtifactFileInput {
  projectId?: string;
  projectName?: string;
  directoryPath?: string;
  scope?: ArtifactScope;
  tags?: string[];
  originalFilename: string;
  mimeType?: string;
  buffer: Buffer;
  sizeBytes: number;
}

export interface ArtifactFileReplacementInput {
  expectedVersion?: number;
  originalFilename?: string;
  mimeType?: string;
  buffer: Buffer;
  sizeBytes: number;
}

export interface ArtifactItemUpdate {
  projectId?: string;
  title?: string;
  path?: string;
  scope?: ArtifactScope;
  tags?: string[];
  contentMarkdown?: string;
  projectName?: string;
}

export interface ArtifactItemListOptions {
  projectId?: string;
  pathPrefix?: string;
  kinds?: ArtifactItemKind[];
  includeContent?: boolean;
  updatedSince?: string;
  limit?: number;
}

export type ArtifactNotePatchOperation =
  | { type: "insert"; index: number; text: string }
  | { type: "delete"; start: number; end: number }
  | { type: "replace"; start: number; end: number; text: string };

export interface ArtifactNotePatchInput {
  expectedVersion?: number;
  operations: ArtifactNotePatchOperation[];
}

export type ArtifactNoteSectionUpdateMode = "replaceBody" | "appendBody" | "prependBody";

export interface ArtifactNoteSectionUpdateInput {
  heading: string;
  level?: number;
  expectedVersion?: number;
  mode?: ArtifactNoteSectionUpdateMode;
  contentMarkdown: string;
  createIfMissing?: boolean;
}

export interface ArtifactFileData {
  item: ArtifactItem;
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}

