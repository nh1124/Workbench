import type { ArtifactItem, ArtifactItemKind, ArtifactPreviewStatus } from "../types/models";

export interface ArtifactEditorDraft {
  id?: string;
  kind: ArtifactItemKind;
  title: string;
  path: string;
  projectId: string;
  projectName: string;
  tags: string[];
  contentMarkdown: string;
  mimeType?: string;
  previewPdfStatus?: ArtifactPreviewStatus;
  previewPdfUpdatedAt?: string;
  sizeBytes?: number;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProjectOption {
  projectId: string;
  projectName?: string;
}

export interface TreeFolderNode {
  name: string;
  path: string;
  folderItem?: ArtifactItem;
  folders: Map<string, TreeFolderNode>;
  items: ArtifactItem[];
}

export type TreeContextTarget =
  | { type: "background"; folderPath: string }
  | { type: "folder"; folderPath: string }
  | { type: "item"; item: ArtifactItem };

export interface TreeContextMenuState {
  x: number;
  y: number;
  target: TreeContextTarget;
}

export interface DeleteConfirmState {
  ids: string[];
  count: number;
  title?: string;
}

export interface CreateFolderState {
  baseFolderPath: string;
}

export interface ParsedMarkdownTable {
  header: string[];
  rows: string[][];
  nextIndex: number;
}

export interface TableCellPosition {
  row: number;
  col: number;
}

export interface TableSelectionState {
  tableId: string;
  start: TableCellPosition;
  end: TableCellPosition;
}

export interface TableSelectionBounds {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

export interface TableContextMenuState {
  x: number;
  y: number;
  selection: TableSelectionState;
}

export interface EditorContextMenuState {
  x: number;
  y: number;
  mode: "edit" | "live";
}

export interface InsertLinkState {
  mode: "edit" | "live";
}

export interface TextSelectionSnapshot {
  start: number;
  end: number;
  text: string;
}

export const defaultDraft: ArtifactEditorDraft = {
  kind: "note",
  title: "",
  path: "",
  projectId: "",
  projectName: "",
  tags: [],
  contentMarkdown: ""
};
