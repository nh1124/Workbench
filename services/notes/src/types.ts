export interface Note {
  id: string;
  title: string;
  content: string;
  projectId: string;
  projectName?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface NoteInput {
  title: string;
  content: string;
  projectId: string;
  projectName?: string;
  tags?: string[];
}

export interface NoteProjectSummary {
  projectId: string;
  projectName?: string;
  noteCount: number;
  latestUpdatedAt: string;
}
