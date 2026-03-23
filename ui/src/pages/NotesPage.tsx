import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { notesApi, projectsApi } from "../lib/api";
import { formatDateTime, normalizeProjectName } from "../lib/format";
import type { Note } from "../types/models";
import "./NotesPage.css";

type NoteModalMode = "create" | "edit";
type ProjectOption = { projectId: string; projectName?: string };

interface NoteDraft {
  title: string;
  content: string;
  projectId: string;
  projectName: string;
  tags: string[];
}

const DEFAULT_PROJECT_ID = "general";

const emptyDraft: NoteDraft = {
  title: "",
  content: "",
  projectId: DEFAULT_PROJECT_ID,
  projectName: "",
  tags: []
};

function noteToDraft(note: Note): NoteDraft {
  return {
    title: note.title,
    content: note.content,
    projectId: note.projectId || DEFAULT_PROJECT_ID,
    projectName: note.projectName ?? "",
    tags: [...note.tags]
  };
}

function isAuthErrorMessage(message: string): boolean {
  const value = message.toLowerCase();
  return value.includes("missing bearer token") || value.includes("unauthorized") || value.includes("forbidden");
}

function previewContent(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "No content yet.";
  }
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

function mergeProjectOptions(...groups: ProjectOption[][]): ProjectOption[] {
  const map = new Map<string, ProjectOption>();
  for (const group of groups) {
    for (const option of group) {
      const id = option.projectId?.trim();
      if (!id) {
        continue;
      }
      const prev = map.get(id);
      map.set(id, {
        projectId: id,
        projectName: option.projectName?.trim() || prev?.projectName
      });
    }
  }
  return [...map.values()].sort((a, b) =>
    normalizeProjectName(a.projectId, a.projectName).localeCompare(
      normalizeProjectName(b.projectId, b.projectName)
    )
  );
}

const IcoNote = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </svg>
);

const IcoSearch = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </svg>
);

const IcoFilter = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M3 5h18l-7 8v6l-4-2v-4z" />
  </svg>
);

const IcoEdit = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z" />
  </svg>
);

const IcoTrash = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
    <path d="M9 6V4h6v2" />
  </svg>
);

const IcoClose = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const IcoPencil = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z" />
  </svg>
);

const IcoMic = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 10a7 7 0 0 0 14 0M12 17v4M9 21h6" />
  </svg>
);

export function NotesPage() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [projectOptions, setProjectOptions] = useState<ProjectOption[]>([]);
  const [defaultProject, setDefaultProject] = useState<ProjectOption | null>(null);
  const [projectFilter, setProjectFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [modalMode, setModalMode] = useState<NoteModalMode | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [draft, setDraft] = useState<NoteDraft>(emptyDraft);
  const [tagInput, setTagInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [deleteConfirmNote, setDeleteConfirmNote] = useState<{ id: string; title: string } | null>(null);

  const load = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const [noteList, projectListResult, noteProjectSummaries, defaultSelection] = await Promise.all([
        notesApi.list(projectFilter || undefined),
        projectsApi.list(undefined, undefined, 200).catch(() => ({ items: [] })),
        notesApi.projects().catch(() => []),
        projectsApi.getDefault().catch(() => null)
      ]);

      const resolvedDefault: ProjectOption | null = defaultSelection
        ? { projectId: defaultSelection.project.id, projectName: defaultSelection.project.name }
        : null;
      setDefaultProject(resolvedDefault);

      const serviceProjects: ProjectOption[] = projectListResult.items.map((project) => ({
        projectId: project.id,
        projectName: project.name
      }));
      const notesProjects: ProjectOption[] = noteProjectSummaries.map((project) => ({
        projectId: project.projectId,
        projectName: project.projectName
      }));
      setNotes(noteList);
      setProjectOptions(
        mergeProjectOptions(
          [{ projectId: DEFAULT_PROJECT_ID, projectName: "general" }],
          resolvedDefault ? [resolvedDefault] : [],
          serviceProjects,
          notesProjects
        )
      );
      setAuthRequired(false);
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "Unable to load notes right now.";
      if (isAuthErrorMessage(message)) {
        setAuthRequired(true);
        setError(null);
      } else {
        // API errors are routed to the global notification center.
        setError(null);
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [projectFilter]);

  const filteredNotes = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const sorted = [...notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    if (!query) {
      return sorted;
    }

    return sorted.filter((note) => {
      const haystack = [
        note.title,
        note.content,
        note.projectId,
        note.projectName ?? "",
        note.tags.join(" ")
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [notes, searchQuery]);

  const editingNote = useMemo(() => notes.find((note) => note.id === editingNoteId) ?? null, [editingNoteId, notes]);
  const resolveProjectName = (projectId: string): string | undefined => {
    const matched = projectOptions.find((project) => project.projectId === projectId);
    return matched?.projectName?.trim() || undefined;
  };

  const openCreateModal = () => {
    const initialProjectId = defaultProject?.projectId || DEFAULT_PROJECT_ID;
    const initialProjectName = defaultProject?.projectName || resolveProjectName(initialProjectId) || "";

    setModalMode("create");
    setEditingNoteId(null);
    setDraft({ ...emptyDraft, projectId: initialProjectId, projectName: initialProjectName });
    setTagInput("");
    setError(null);
  };

  const openEditModal = (note: Note) => {
    setModalMode("edit");
    setEditingNoteId(note.id);
    setDraft(noteToDraft(note));
    setTagInput("");
    setError(null);
  };

  const closeModal = (force = false) => {
    if (isSaving && !force) {
      return;
    }
    setModalMode(null);
    setEditingNoteId(null);
    setDraft(emptyDraft);
    setTagInput("");
    setError(null);
  };

  const addTag = (value: string) => {
    const normalized = value.trim();
    if (!normalized) {
      return;
    }

    const exists = draft.tags.some((tag) => tag.toLowerCase() === normalized.toLowerCase());
    if (exists) {
      setTagInput("");
      return;
    }

    setDraft((prev) => ({ ...prev, tags: [...prev.tags, normalized] }));
    setTagInput("");
  };

  const removeTag = (tag: string) => {
    setDraft((prev) => ({ ...prev, tags: prev.tags.filter((value) => value !== tag) }));
  };

  const handleTagInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      addTag(tagInput);
    }
    if (event.key === "Backspace" && !tagInput && draft.tags.length > 0) {
      setDraft((prev) => ({ ...prev, tags: prev.tags.slice(0, -1) }));
    }
  };

  const handleSave = async () => {
    if (!draft.title.trim()) {
      setError("Title is required.");
      return;
    }

    setError(null);
    setIsSaving(true);

    try {
      const normalizedProjectId = draft.projectId.trim() || DEFAULT_PROJECT_ID;
      const payload = {
        title: draft.title.trim(),
        content: draft.content,
        projectId: normalizedProjectId,
        projectName: draft.projectName.trim() || resolveProjectName(normalizedProjectId),
        tags: draft.tags
      };

      if (modalMode === "edit" && editingNoteId) {
        await notesApi.update(editingNoteId, payload);
      } else {
        await notesApi.create(payload as Omit<Note, "id" | "createdAt" | "updatedAt">);
      }

      closeModal(true);
      await load();
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : "Unable to save note.";
      setError(isAuthErrorMessage(message) ? "Sign-in is required to save notes." : message);
    } finally {
      setIsSaving(false);
    }
  };

  const performDelete = async (noteId: string) => {
    setIsSaving(true);
    setError(null);

    try {
      await notesApi.remove(noteId);
      if (editingNoteId === noteId) {
        closeModal(true);
      }
      await load();
    } catch (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : "Unable to delete note.";
      if (!modalMode) {
        const target = notes.find((note) => note.id === noteId);
        if (target) {
          openEditModal(target);
        }
      }
      setError(isAuthErrorMessage(message) ? "Sign-in is required to manage notes." : message);
    } finally {
      setIsSaving(false);
    }
  };

  const requestDelete = (noteId: string, title?: string) => {
    setDeleteConfirmNote({
      id: noteId,
      title: title?.trim() || "note"
    });
  };

  const showNoData = !isLoading && !authRequired && filteredNotes.length === 0;
  const hasActiveFilters = projectFilter.length > 0 || searchQuery.trim().length > 0;

  return (
    <section className="notes-page">
      <header className="notes-header-row">
        <div className="notes-header-title-wrap">
          <span className="notes-header-icon" aria-hidden="true">
            <IcoNote />
          </span>
          <h2 className="notes-header-title">Notes</h2>
        </div>

        <div className="notes-top-actions">
          <button type="button" className="notes-action-secondary" onClick={openCreateModal}>
            <IcoMic />
            Audio
          </button>
          <button type="button" className="notes-action-primary" onClick={openCreateModal}>
            <IcoPencil />
            Text Note
          </button>
        </div>
      </header>

      <section className="notes-filter-bar panel">
        <label className="notes-search-control" aria-label="Search notes">
          <span className="notes-search-icon" aria-hidden="true">
            <IcoSearch />
          </span>
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search notes by title, content, tags, or project"
          />
        </label>

        <label className="notes-project-filter">
          <span className="notes-filter-prefix" aria-hidden="true">
            <IcoFilter />
          </span>
          <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}>
            <option value="">All projects</option>
            {projectOptions.map((project) => (
              <option key={project.projectId} value={project.projectId}>
                {normalizeProjectName(project.projectId, project.projectName)}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="notes-cards-surface panel">
        {authRequired ? (
          <div className="notes-state-card">
            <h3>Sign in required</h3>
            <p>Please sign in to view and manage notes in this workspace.</p>
            <div className="notes-state-actions">
              <Link to="/settings" className="notes-inline-link">
                Open Settings
              </Link>
            </div>
          </div>
        ) : null}

        {!authRequired && isLoading ? (
          <div className="notes-loading-state">
            <p>Loading notes...</p>
          </div>
        ) : null}

        {!authRequired && !isLoading && filteredNotes.length > 0 ? (
          <div className="notes-card-grid">
            {filteredNotes.map((note) => (
              <article key={note.id} className="note-card" onClick={() => openEditModal(note)}>
                <div className="note-card-top-row">
                  <span className="note-category-badge">Project</span>
                  <div className="note-card-actions" onClick={(event) => event.stopPropagation()}>
                    <button type="button" className="note-card-action" onClick={() => openEditModal(note)} aria-label="Edit note">
                      <IcoEdit />
                    </button>
                    <button
                      type="button"
                      className="note-card-action danger"
                      onClick={() => requestDelete(note.id, note.title)}
                      aria-label="Delete note"
                    >
                      <IcoTrash />
                    </button>
                  </div>
                </div>

                <h3 className="note-card-title">{note.title}</h3>
                <p className="note-card-preview">{previewContent(note.content)}</p>

                <div className="note-card-tags">
                  {note.tags.length > 0 ? note.tags.map((tag) => <span key={`${note.id}-${tag}`}>#{tag}</span>) : <span className="muted">No tags</span>}
                </div>

                <div className="note-card-footer">
                  <div>
                    <small>Project</small>
                    <p>{normalizeProjectName(note.projectId, note.projectName)}</p>
                  </div>
                  <div>
                    <small>Created</small>
                    <p>{formatDateTime(note.createdAt)}</p>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : null}

        {showNoData ? (
          hasActiveFilters ? (
            <div className="notes-state-card">
              <h3>No matching notes</h3>
              <p>Try a broader search or switch projects.</p>
              <div className="notes-state-actions">
                <button type="button" className="notes-action-primary" onClick={openCreateModal}>
                  Create Text Note
                </button>
              </div>
            </div>
          ) : (
            <div className="notes-state-card notes-empty-tray">
              <h3 className="notes-empty-title">No notes yet</h3>
              <div className="notes-state-actions">
                <button type="button" className="notes-empty-create" onClick={openCreateModal}>
                  + Create Note
                </button>
              </div>
            </div>
          )
        ) : null}
      </section>

      {modalMode ? (
        <div className="modal-backdrop" role="presentation" onClick={() => closeModal()}>
          <section
            className="notes-modal"
            role="dialog"
            aria-modal="true"
            aria-label={modalMode === "edit" ? "Edit note" : "Create note"}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="notes-modal-head">
              <div>
                <h3>{modalMode === "edit" ? "Edit Note" : "Create Note"}</h3>
                <p>{modalMode === "edit" ? "Update note details" : "Capture a new text note"}</p>
              </div>
              <button type="button" className="notes-modal-close" onClick={() => closeModal()} aria-label="Close">
                <IcoClose />
              </button>
            </header>

            <div className="notes-modal-body">
              {error ? <p className="notes-modal-error">{error}</p> : null}

              <label>
                Title
                <input
                  value={draft.title}
                  onChange={(event) => setDraft((prev) => ({ ...prev, title: event.target.value }))}
                  placeholder="Note title"
                />
              </label>

              <label>
                Content
                <textarea
                  rows={9}
                  value={draft.content}
                  onChange={(event) => setDraft((prev) => ({ ...prev, content: event.target.value }))}
                  placeholder="Write note content"
                />
              </label>

              <label className="notes-modal-field-label">
                Link to Project
                <select
                  value={draft.projectId}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      projectId: event.target.value,
                      projectName: resolveProjectName(event.target.value) ?? prev.projectName
                    }))
                  }
                >
                  {projectOptions.map((project) => (
                    <option key={project.projectId} value={project.projectId}>
                      {normalizeProjectName(project.projectId, project.projectName)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="notes-modal-field-label">
                Tags
                <div className="note-tags-input" onClick={() => document.getElementById("note-tag-input")?.focus()}>
                  {draft.tags.map((tag) => (
                    <span key={tag} className="note-tag-token">
                      {tag}
                      <button type="button" onClick={() => removeTag(tag)} aria-label={`Remove ${tag}`}>
                        <IcoClose />
                      </button>
                    </span>
                  ))}
                  <input
                    id="note-tag-input"
                    value={tagInput}
                    onChange={(event) => setTagInput(event.target.value)}
                    onKeyDown={handleTagInputKeyDown}
                    onBlur={() => addTag(tagInput)}
                    placeholder={draft.tags.length === 0 ? "Add tag and press Enter..." : "Add tag"}
                  />
                </div>
              </label>

              {modalMode === "edit" && editingNote ? (
                <div className="notes-modal-meta">
                  <small>Created {formatDateTime(editingNote.createdAt)}</small>
                  <small>Updated {formatDateTime(editingNote.updatedAt)}</small>
                </div>
              ) : null}
            </div>

            <footer className="notes-modal-foot">
              {modalMode === "edit" && editingNoteId ? (
                <button
                  type="button"
                  className="notes-modal-delete"
                  disabled={isSaving}
                  onClick={() => requestDelete(editingNoteId, editingNote?.title)}
                >
                  Delete
                </button>
              ) : (
                <span />
              )}
              <div className="notes-modal-actions">
                <button type="button" className="ghost-button" onClick={() => closeModal()} disabled={isSaving}>
                  Cancel
                </button>
                <button type="button" onClick={() => void handleSave()} disabled={isSaving}>
                  {isSaving ? "Saving..." : modalMode === "edit" ? "Save Changes" : "Save"}
                </button>
              </div>
            </footer>
          </section>
        </div>
      ) : null}

      <ConfirmDialog
        open={Boolean(deleteConfirmNote)}
        title="Delete Note"
        message={`Delete "${deleteConfirmNote?.title || "note"}"?`}
        confirmLabel="Delete"
        confirmTone="danger"
        busy={isSaving}
        onCancel={() => setDeleteConfirmNote(null)}
        onConfirm={() => {
          if (!deleteConfirmNote) return;
          const target = deleteConfirmNote;
          setDeleteConfirmNote(null);
          void performDelete(target.id);
        }}
      />
    </section>
  );
}
