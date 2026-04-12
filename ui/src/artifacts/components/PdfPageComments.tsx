import { useEffect, useRef, useState } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PdfComment {
  id: string;
  text: string;
  createdAt: string;
}

export type CommentStore = Record<string, PdfComment[]>;

// ── LocalStorage helpers ───────────────────────────────────────────────────────

function storageKey(artifactId: string): string {
  return `workbench_pdf_comments_${artifactId}`;
}

export function loadStore(artifactId: string): CommentStore {
  try {
    const raw = localStorage.getItem(storageKey(artifactId));
    return raw ? (JSON.parse(raw) as CommentStore) : {};
  } catch {
    return {};
  }
}

function persistStore(artifactId: string, store: CommentStore): void {
  localStorage.setItem(storageKey(artifactId), JSON.stringify(store));
}

function makeId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// ── CommentItem ───────────────────────────────────────────────────────────────

interface CommentItemProps {
  comment: PdfComment;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
}

function CommentItem({ comment, onEdit, onDelete }: CommentItemProps) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(comment.text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function startEdit() {
    setEditText(comment.text);
    setEditing(true);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  function commitEdit() {
    const text = editText.trim();
    if (text && text !== comment.text) onEdit(comment.id, text);
    setEditing(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitEdit(); }
    if (e.key === "Escape") setEditing(false);
  }

  return (
    <div className="pdfc-item">
      {editing ? (
        <>
          <textarea
            ref={textareaRef}
            className="pdfc-item-textarea"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Edit comment… (Ctrl+Enter to save)"
            rows={3}
          />
          <div className="pdfc-item-edit-actions">
            <button type="button" onClick={commitEdit}>Save</button>
            <button type="button" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <p className="pdfc-item-text">{comment.text}</p>
          <div className="pdfc-item-actions">
            <button type="button" title="Edit" onClick={startEdit} aria-label="Edit comment">✎</button>
            <button type="button" title="Delete" onClick={() => onDelete(comment.id)} aria-label="Delete comment">✕</button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface PdfPageCommentsProps {
  artifactId: string;
  /** Current page detected from the PDF iframe (1-based). */
  currentPage: number;
  /** Whether auto-detection is working (false = browser doesn't support it). */
  pageDetected: boolean;
  /** Called when user manually overrides the page number. */
  onPageChange: (page: number) => void;
}

export function PdfPageComments({ artifactId, currentPage, pageDetected, onPageChange }: PdfPageCommentsProps) {
  const [store, setStore] = useState<CommentStore>(() => loadStore(artifactId));
  const [addText, setAddText] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const addTextareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setStore(loadStore(artifactId));
    setAddText("");
    setCollapsed({});
  }, [artifactId]);

  function updateStore(next: CommentStore) {
    setStore(next);
    persistStore(artifactId, next);
  }

  const pages = Object.keys(store)
    .map(Number)
    .filter((p) => (store[String(p)]?.length ?? 0) > 0)
    .sort((a, b) => a - b);

  const totalCount = pages.reduce((sum, p) => sum + (store[String(p)]?.length ?? 0), 0);

  function handleAdd() {
    const text = addText.trim();
    if (!text) return;
    const pageKey = String(currentPage);
    const prev = store[pageKey] ?? [];
    updateStore({ ...store, [pageKey]: [...prev, { id: makeId(), text, createdAt: new Date().toISOString() }] });
    setAddText("");
    addTextareaRef.current?.focus();
  }

  function handleEdit(pageKey: string, id: string, text: string) {
    updateStore({
      ...store,
      [pageKey]: (store[pageKey] ?? []).map((c) => (c.id === id ? { ...c, text } : c)),
    });
  }

  function handleDelete(pageKey: string, id: string) {
    const next = (store[pageKey] ?? []).filter((c) => c.id !== id);
    const nextStore = { ...store };
    if (next.length === 0) delete nextStore[pageKey];
    else nextStore[pageKey] = next;
    updateStore(nextStore);
  }

  function toggleCollapse(pageKey: string) {
    setCollapsed((prev) => ({ ...prev, [pageKey]: !prev[pageKey] }));
  }

  function handleAddKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleAdd(); }
  }

  return (
    <div className="pdfc-sidebar">
      {/* Header */}
      <div className="pdfc-header">
        <span className="pdfc-header-title">Comments</span>
        {totalCount > 0 && (
          <span className="pdfc-header-count">{totalCount}</span>
        )}
      </div>

      {/* All-pages comment list */}
      <div className="pdfc-list">
        {pages.length === 0 ? (
          <p className="pdfc-empty">No comments yet</p>
        ) : (
          pages.map((page) => {
            const pageKey = String(page);
            const comments = store[pageKey] ?? [];
            const isCollapsed = !!collapsed[pageKey];
            const isCurrent = page === currentPage;
            return (
              <div key={pageKey} className={`pdfc-page-group${isCurrent ? " current" : ""}`}>
                <button
                  type="button"
                  className="pdfc-page-header"
                  onClick={() => toggleCollapse(pageKey)}
                  aria-expanded={isCollapsed ? "false" : "true"}
                >
                  <span className="pdfc-page-chevron">{isCollapsed ? "▶" : "▼"}</span>
                  <span className="pdfc-page-label">Page {page}</span>
                  {isCurrent && <span className="pdfc-page-current-badge">current</span>}
                  <span className="pdfc-page-count">{comments.length}</span>
                </button>

                {!isCollapsed && (
                  <div className="pdfc-page-comments">
                    {comments.map((comment) => (
                      <CommentItem
                        key={comment.id}
                        comment={comment}
                        onEdit={(id, text) => handleEdit(pageKey, id, text)}
                        onDelete={(id) => handleDelete(pageKey, id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Add comment */}
      <div className="pdfc-add">
        <div className="pdfc-add-page-row">
          <span className="pdfc-add-label">Add to page</span>
          <label className="pdfc-add-page-label">
            <input
              type="number"
              min={1}
              value={currentPage}
              onChange={(e) => onPageChange(Math.max(1, parseInt(e.target.value) || 1))}
              className={`pdfc-page-input${pageDetected ? " detected" : ""}`}
              title={pageDetected ? "Auto-detected page" : "Page not auto-detected — enter manually"}
            />
          </label>
        </div>
        <textarea
          ref={addTextareaRef}
          className="pdfc-add-textarea"
          value={addText}
          onChange={(e) => setAddText(e.target.value)}
          onKeyDown={handleAddKeyDown}
          placeholder="Write a comment… (Ctrl+Enter to save)"
          rows={3}
        />
        <button
          type="button"
          className="pdfc-add-btn"
          onClick={handleAdd}
          disabled={!addText.trim()}
        >
          Add
        </button>
      </div>
    </div>
  );
}
