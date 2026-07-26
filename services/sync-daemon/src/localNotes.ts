export const LOCAL_NOTE_ID_PREFIX = "local-note-";

export function isLocalNoteId(id: string | undefined): boolean {
  return typeof id === "string" && id.startsWith(LOCAL_NOTE_ID_PREFIX);
}

export function noteOutboxPath(id: string): string {
  return `notes/${id}`;
}

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
