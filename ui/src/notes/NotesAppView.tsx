import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { TitleBarPortal } from "../components/VariantChrome";
import { formatDateTime, normalizeProjectName } from "../lib/format";
import { openQuickNoteWindow } from "../lib/api";
import type { Note } from "../types/models";

/**
 * Notes as a dedicated app.
 *
 * The card wall used in the main workspace wastes a full window: every note is a large
 * tile, so only a handful fit and none of them can be read. The list view is a dense,
 * scannable column beside a reading pane; the grid view keeps the browsable card wall for
 * when you are hunting rather than reading. Controls that apply to the whole app — search,
 * project, view, new note — live in the title bar.
 *
 * The reading pane IS the editor: there is no separate edit mode and no overlay. Edits are
 * saved a moment after typing stops.
 */

const VIEW_MODE_STORAGE_KEY = "workbench-notes-view-mode";
const AUTOSAVE_DELAY_MS = 700;

export type NotesViewMode = "list" | "grid";

export interface ProjectOption {
  projectId: string;
  projectName?: string;
}

interface NotesAppViewProps {
  notes: Note[];
  selectedNote: Note | null;
  onSelect: (noteId: string) => void;
  projectOptions: ProjectOption[];
  projectFilter: string;
  onProjectFilterChange: (value: string) => void;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  isLoading: boolean;
  authRequired: boolean;
  hasActiveFilters: boolean;
  onCreate: () => void;
  onSave: (noteId: string, patch: { title?: string; content?: string }) => Promise<void>;
  onDelete: (noteId: string, title?: string) => void;
  error: string | null;
  /** Set when this window was opened to show a single note. */
  standaloneNoteId?: string | null;
}

/** First non-empty line, so the list shows something other than markdown punctuation. */
export function noteSnippet(content: string): string {
  const line = content
    .split("\n")
    .map((entry) => entry.replace(/^#+\s*/, "").trim())
    .find((entry) => entry.length > 0);
  return line ?? "";
}

export function readStoredViewMode(): NotesViewMode {
  if (typeof window === "undefined") return "list";
  return window.localStorage.getItem(VIEW_MODE_STORAGE_KEY) === "grid" ? "grid" : "list";
}

/** URL that opens one note in its own window, the way Quick Note gets its own window. */
export function standaloneNoteUrl(noteId: string): string {
  return `?app=notes&note=${encodeURIComponent(noteId)}`;
}

export function NotesAppView({
  notes,
  selectedNote,
  onSelect,
  projectOptions,
  projectFilter,
  onProjectFilterChange,
  searchQuery,
  onSearchQueryChange,
  isLoading,
  authRequired,
  hasActiveFilters,
  onCreate,
  onSave,
  onDelete,
  error,
  standaloneNoteId
}: NotesAppViewProps) {
  const [viewMode, setViewMode] = useState<NotesViewMode>(readStoredViewMode);
  const [isListCollapsed, setIsListCollapsed] = useState(false);
  const isStandalone = Boolean(standaloneNoteId);

  const changeViewMode = (mode: NotesViewMode) => {
    setViewMode(mode);
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  };

  // The quick-note window is the proven path for a note in its own window; reuse it rather
  // than maintaining a second kind of note window.
  const openInNewWindow = () => {
    void openQuickNoteWindow();
  };

  return (
    <>
      <TitleBarPortal>
        {!isStandalone ? (
          <>
            <input
              className="chrome-search"
              type="search"
              value={searchQuery}
              onChange={(event) => onSearchQueryChange(event.target.value)}
              placeholder="Search notes"
              aria-label="Search notes"
            />
            <select
              className="chrome-select"
              value={projectFilter}
              onChange={(event) => onProjectFilterChange(event.target.value)}
              aria-label="Filter by project"
            >
              <option value="">All projects</option>
              {projectOptions.map((project) => (
                <option key={project.projectId} value={project.projectId}>
                  {normalizeProjectName(project.projectId, project.projectName)}
                </option>
              ))}
            </select>
            <div className="chrome-segmented" role="group" aria-label="View mode">
              <button
                type="button"
                className={viewMode === "list" ? "chrome-icon-button active" : "chrome-icon-button"}
                aria-pressed={viewMode === "list"}
                aria-label="List view"
                title="List view"
                onClick={() => changeViewMode("list")}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
              <button
                type="button"
                className={viewMode === "grid" ? "chrome-icon-button active" : "chrome-icon-button"}
                aria-pressed={viewMode === "grid"}
                aria-label="Panel view"
                title="Panel view"
                onClick={() => changeViewMode("grid")}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <rect x="2" y="2" width="5" height="5" fill="none" stroke="currentColor" strokeWidth="1.4" />
                  <rect x="9" y="2" width="5" height="5" fill="none" stroke="currentColor" strokeWidth="1.4" />
                  <rect x="2" y="9" width="5" height="5" fill="none" stroke="currentColor" strokeWidth="1.4" />
                  <rect x="9" y="9" width="5" height="5" fill="none" stroke="currentColor" strokeWidth="1.4" />
                </svg>
              </button>
            </div>
            {viewMode === "list" ? (
              <button
                type="button"
                className={isListCollapsed ? "chrome-icon-button active" : "chrome-icon-button"}
                aria-pressed={isListCollapsed}
                aria-label={isListCollapsed ? "Show the note list" : "Hide the note list"}
                title={isListCollapsed ? "Show the note list" : "Hide the note list (full-width editor)"}
                onClick={() => setIsListCollapsed((collapsed) => !collapsed)}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <rect x="2" y="3" width="12" height="10" fill="none" stroke="currentColor" strokeWidth="1.4" />
                  <path d="M6 3v10" stroke="currentColor" strokeWidth="1.4" />
                </svg>
              </button>
            ) : null}
            <button type="button" className="chrome-primary" onClick={onCreate}>
              New note
            </button>
          </>
        ) : null}
      </TitleBarPortal>

      {authRequired ? (
        <div className="notes-app-empty">
          <h3>Sign in required</h3>
          <p>Sign in to view and manage notes in this workspace.</p>
          <Link to="/settings" className="notes-inline-link">Open Settings</Link>
        </div>
      ) : (
        <div
          className={
            isStandalone
              ? "notes-app notes-app-standalone"
              : viewMode === "grid"
                ? "notes-app notes-app-grid-layout"
                : isListCollapsed
                  ? "notes-app notes-app-collapsed"
                  : "notes-app"
          }
        >
          {!isStandalone && viewMode === "list" && !isListCollapsed ? (
            <ul className="notes-app-list">
              {isLoading ? <li className="notes-app-hint">Loading…</li> : null}
              {!isLoading && notes.length === 0 ? (
                <li className="notes-app-hint">
                  {hasActiveFilters ? "No matching notes." : "No notes yet."}
                </li>
              ) : null}
              {notes.map((note) => (
                <li key={note.id} className="notes-app-row-wrap">
                  <button
                    type="button"
                    className="notes-icon-action danger notes-app-row-delete"
                    onClick={() => onDelete(note.id, note.title)}
                    aria-label={`Delete ${note.title}`}
                    title="Delete note"
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className={note.id === selectedNote?.id ? "notes-app-row active" : "notes-app-row"}
                    onClick={() => onSelect(note.id)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      openInNewWindow();
                    }}
                    title="Right-click to open in a new window"
                  >
                    <span className="notes-app-row-title">{note.title}</span>
                    <span className="notes-app-row-snippet">{noteSnippet(note.content)}</span>
                    <span className="notes-app-row-meta">
                      <span>{normalizeProjectName(note.projectId, note.projectName)}</span>
                      <time>{formatDateTime(note.createdAt)}</time>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {!isStandalone && viewMode === "grid" ? (
            <div className="notes-app-grid">
              {isLoading ? <p className="notes-app-hint">Loading…</p> : null}
              {!isLoading && notes.length === 0 ? (
                <p className="notes-app-hint">
                  {hasActiveFilters ? "No matching notes." : "No notes yet."}
                </p>
              ) : null}
              {notes.map((note) => (
                <button
                  key={note.id}
                  type="button"
                  className="notes-app-tile"
                  onClick={() => openInNewWindow()}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    openInNewWindow();
                  }}
                  title="Right-click to open in a new window"
                >
                  <span className="notes-app-tile-title">{note.title}</span>
                  <span className="notes-app-tile-body">{noteSnippet(note.content)}</span>
                  <span className="notes-app-row-meta">
                    <span>{normalizeProjectName(note.projectId, note.projectName)}</span>
                    <time>{formatDateTime(note.createdAt)}</time>
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          {/* Panels is for browsing: opening a note there gives it a window of its own,
              so the wall stays a wall instead of shrinking to make room for an editor. */}
          {viewMode === "list" || isStandalone ? (
            <NoteEditorPane
              note={selectedNote}
              onSave={onSave}
              onDelete={onDelete}
              onOpenInNewWindow={isStandalone ? undefined : openInNewWindow}
              error={error}
            />
          ) : null}
        </div>
      )}
    </>
  );
}

interface NoteEditorPaneProps {
  note: Note | null;
  onSave: (noteId: string, patch: { title?: string; content?: string }) => Promise<void>;
  onDelete: (noteId: string, title?: string) => void;
  onOpenInNewWindow?: () => void;
  error: string | null;
}

/** The reading pane and the editor are the same surface; edits autosave. */
function NoteEditorPane({ note, onSave, onDelete, onOpenInNewWindow, error }: NoteEditorPaneProps) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<"idle" | "dirty" | "saving" | "saved">("idle");
  const timerRef = useRef<number | undefined>(undefined);
  const noteId = note?.id ?? null;

  // Adopt the selected note. Switching notes must not carry the previous draft over, and
  // must not schedule a save of the old text against the new note.
  useEffect(() => {
    window.clearTimeout(timerRef.current);
    setTitle(note?.title ?? "");
    setContent(note?.content ?? "");
    setStatus("idle");
  }, [noteId, note?.title, note?.content]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const scheduleSave = useCallback(
    (patch: { title?: string; content?: string }) => {
      if (!noteId) return;
      setStatus("dirty");
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        setStatus("saving");
        void onSave(noteId, patch).then(() => setStatus("saved"));
      }, AUTOSAVE_DELAY_MS);
    },
    [noteId, onSave]
  );

  if (!note) {
    return (
      <article className="notes-app-reader">
        <p className="notes-app-hint">Select a note, or create one.</p>
      </article>
    );
  }

  return (
    <article className="notes-app-reader">
      <header className="notes-app-reader-head">
        <input
          className="notes-app-title-input"
          value={title}
          aria-label="Note title"
          onChange={(event) => {
            setTitle(event.target.value);
            scheduleSave({ title: event.target.value });
          }}
        />
        <div className="notes-app-reader-actions">
          <span className="notes-app-save-state" aria-live="polite">
            {status === "dirty" || status === "saving" ? "Saving…" : status === "saved" ? "Saved" : ""}
          </span>
          {onOpenInNewWindow ? (
            <button
              type="button"
              className="notes-icon-action"
              onClick={() => onOpenInNewWindow()}
              aria-label="Open in a new window"
              title="Open in a new window"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M6 3H3v10h10v-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                <path d="M9.5 3H13v3.5M13 3L7.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ) : null}
          <button
            type="button"
            className="notes-icon-action danger"
            onClick={() => onDelete(note.id, note.title)}
            aria-label="Delete note"
            title="Delete note"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </header>

      <p className="notes-app-reader-meta">
        {normalizeProjectName(note.projectId, note.projectName)}
        <span aria-hidden="true"> · </span>
        {formatDateTime(note.createdAt)}
      </p>

      {note.tags.length > 0 ? (
        <div className="notes-app-reader-tags">
          {note.tags.map((tag) => (
            <span key={`${note.id}-${tag}`}>#{tag}</span>
          ))}
        </div>
      ) : null}

      {error ? <p className="notes-app-error">{error}</p> : null}

      <textarea
        className="notes-app-editor"
        value={content}
        aria-label="Note content"
        placeholder="Start typing…"
        onChange={(event) => {
          setContent(event.target.value);
          scheduleSave({ content: event.target.value });
        }}
      />
    </article>
  );
}
