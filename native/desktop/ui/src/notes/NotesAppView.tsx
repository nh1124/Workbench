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
  /** Bulk delete for a multi-selection; falls back to {@link onDelete} for a single note. */
  onDeleteMany: (noteIds: string[]) => void;
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
  return `?note=${encodeURIComponent(noteId)}`;
}

/**
 * Which notes a click selects, given the modifier keys and what was already selected.
 *
 * Extracted because the interesting part is not the clicking, it is the bookkeeping: a shift
 * range is measured from the anchor rather than from the last click, so extending a range
 * twice grows it from the same origin instead of walking away from it.
 */
export function nextNoteSelection(options: {
  orderedIds: string[];
  clickedId: string;
  selected: Set<string>;
  anchorId: string | null;
  shiftKey: boolean;
  toggleKey: boolean;
}): { selected: Set<string>; anchorId: string } {
  const { orderedIds, clickedId, selected, anchorId, shiftKey, toggleKey } = options;

  if (shiftKey && anchorId && anchorId !== clickedId) {
    const from = orderedIds.indexOf(anchorId);
    const to = orderedIds.indexOf(clickedId);
    if (from !== -1 && to !== -1) {
      const [start, end] = from < to ? [from, to] : [to, from];
      // The anchor stays put so a second shift-click re-measures from the same note.
      return { selected: new Set(orderedIds.slice(start, end + 1)), anchorId };
    }
  }

  if (toggleKey) {
    const next = new Set(selected);
    if (next.has(clickedId)) {
      next.delete(clickedId);
    } else {
      next.add(clickedId);
    }
    return { selected: next, anchorId: clickedId };
  }

  return { selected: new Set([clickedId]), anchorId: clickedId };
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
  onDeleteMany,
  error,
  standaloneNoteId
}: NotesAppViewProps) {
  const [viewMode, setViewMode] = useState<NotesViewMode>(readStoredViewMode);
  const [isListCollapsed, setIsListCollapsed] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; noteId: string } | null>(null);
  const isStandalone = Boolean(standaloneNoteId);

  // Filtering or deleting can take notes out from under the selection; ids that are no
  // longer on screen must not keep counting towards "3 selected" or a bulk delete.
  useEffect(() => {
    const visible = new Set(notes.map((note) => note.id));
    setSelectedIds((current) => {
      const pruned = new Set([...current].filter((id) => visible.has(id)));
      return pruned.size === current.size ? current : pruned;
    });
  }, [notes]);

  useEffect(() => {
    if (!rowMenu) return;
    const close = () => setRowMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [rowMenu]);

  const handleRowClick = (noteId: string, event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    const next = nextNoteSelection({
      orderedIds: notes.map((note) => note.id),
      clickedId: noteId,
      selected: selectedIds,
      anchorId,
      shiftKey: event.shiftKey,
      toggleKey: event.ctrlKey || event.metaKey
    });
    setSelectedIds(next.selected);
    setAnchorId(next.anchorId);
    // The reading pane follows the note you just touched, whatever else is selected.
    onSelect(noteId);
  };

  const openRowMenu = (event: { preventDefault: () => void; clientX: number; clientY: number }, noteId: string) => {
    event.preventDefault();
    // Right-clicking outside the selection acts on that note alone, which is what every
    // file manager does and stops a stray click deleting a selection you forgot about.
    if (!selectedIds.has(noteId)) {
      setSelectedIds(new Set([noteId]));
      setAnchorId(noteId);
      onSelect(noteId);
    }
    setRowMenu({ x: event.clientX, y: event.clientY, noteId });
  };

  const menuTargetIds = rowMenu
    ? selectedIds.has(rowMenu.noteId) && selectedIds.size > 1
      ? [...selectedIds]
      : [rowMenu.noteId]
    : [];

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
                    className={[
                      "notes-app-row",
                      note.id === selectedNote?.id ? "active" : "",
                      selectedIds.has(note.id) ? "multi-selected" : ""
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    aria-selected={selectedIds.has(note.id)}
                    onClick={(event) => handleRowClick(note.id, event)}
                    onContextMenu={(event) => openRowMenu(event, note.id)}
                    title="Shift or Ctrl click to select several; right-click for actions"
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

          {rowMenu ? (
            <div
              className="notes-app-row-menu"
              style={{ left: rowMenu.x, top: rowMenu.y }}
              role="menu"
              // The document listener that closes this fires on mousedown, so a press that
              // starts on the menu must not travel up to it.
              onMouseDown={(event) => event.stopPropagation()}
            >
              {menuTargetIds.length === 1 ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setRowMenu(null);
                    openInNewWindow();
                  }}
                >
                  Open in a new window
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                className="danger"
                onClick={() => {
                  setRowMenu(null);
                  if (menuTargetIds.length === 1) {
                    const target = notes.find((note) => note.id === menuTargetIds[0]);
                    onDelete(menuTargetIds[0], target?.title);
                  } else {
                    onDeleteMany(menuTargetIds);
                  }
                }}
              >
                {menuTargetIds.length > 1 ? `Delete ${menuTargetIds.length} notes` : "Delete note"}
              </button>
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
