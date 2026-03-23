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

export interface ArtifactItemUpdate {
  title?: string;
  path?: string;
  scope?: ArtifactScope;
  tags?: string[];
  contentMarkdown?: string;
  projectName?: string;
}

export interface ArtifactFileData {
  item: ArtifactItem;
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}

