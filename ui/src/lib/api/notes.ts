import { fetchNotesFacadeJson } from "./transport";
import type {
  Note,
  NoteProjectSummary
} from "../../types/models";

export const notesApi = {
  list: (projectId?: string, limit?: number): Promise<Note[]> => {
    const params = new URLSearchParams();
    if (projectId) params.set("projectId", projectId);
    if (limit) params.set("limit", String(limit));
    const query = params.toString();
    return fetchNotesFacadeJson<Note[]>(`/api/notes${query ? `?${query}` : ""}`);
  },
  get: (id: string): Promise<Note> => fetchNotesFacadeJson<Note>(`/api/notes/${encodeURIComponent(id)}`),
  create: (payload: Omit<Note, "id" | "createdAt" | "updatedAt">): Promise<Note> =>
    fetchNotesFacadeJson<Note>("/api/notes", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  update: (
    id: string,
    payload: Partial<Omit<Note, "id" | "createdAt" | "updatedAt">>
  ): Promise<Note> =>
    fetchNotesFacadeJson<Note>(`/api/notes/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  remove: (id: string): Promise<void> =>
    fetchNotesFacadeJson<void>(`/api/notes/${encodeURIComponent(id)}`, {
      method: "DELETE"
    }),
  projects: (): Promise<NoteProjectSummary[]> => fetchNotesFacadeJson<NoteProjectSummary[]>("/api/notes/projects")
};

