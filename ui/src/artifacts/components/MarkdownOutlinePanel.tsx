import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import type { MarkdownOutlineItem } from "../utils/markdownOutline";

interface MarkdownOutlinePanelProps {
  collapsed: boolean;
  markdownVisible: boolean;
  entries: MarkdownOutlineItem[];
  bodyHeight: number;
  onToggleCollapsed: () => void;
  onBodyHeightChange: (next: number) => void;
  onSelectEntry: (entry: MarkdownOutlineItem) => void;
  onMoveEntry: (draggedId: string, targetId: string, targetLevel: number) => void;
  onOpenContextMenu: (event: MouseEvent<HTMLButtonElement>, entry: MarkdownOutlineItem) => void;
}

const OUTLINE_DRAG_MIME = "application/x-workbench-outline-heading";
const MIN_OUTLINE_BODY_HEIGHT = 96;
const MAX_OUTLINE_BODY_HEIGHT = 2000;

function clampLevel(level: number): number {
  return Math.max(1, Math.min(6, Math.trunc(level || 1)));
}

function clampHeight(height: number): number {
  return Math.max(MIN_OUTLINE_BODY_HEIGHT, Math.min(MAX_OUTLINE_BODY_HEIGHT, Math.trunc(height || MIN_OUTLINE_BODY_HEIGHT)));
}

function resolveDropLevel(event: DragEvent<HTMLButtonElement>, fallback: number): number {
  const rect = event.currentTarget.getBoundingClientRect();
  const relativeX = event.clientX - rect.left;
  const estimated = Math.floor((relativeX - 8) / 22) + 1;
  return clampLevel(Number.isFinite(estimated) ? estimated : fallback);
}

function readDraggedEntryId(event: DragEvent): string {
  return (
    event.dataTransfer.getData(OUTLINE_DRAG_MIME).trim() ||
    event.dataTransfer.getData("text/plain").trim()
  );
}

export function MarkdownOutlinePanel({
  collapsed,
  markdownVisible,
  entries,
  bodyHeight,
  onToggleCollapsed,
  onBodyHeightChange,
  onSelectEntry,
  onMoveEntry,
  onOpenContextMenu
}: MarkdownOutlinePanelProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ targetId: string; targetLevel: number } | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStateRef = useRef<{ startY: number; startHeight: number } | null>(null);

  useEffect(() => {
    if (!isResizing || !resizeStateRef.current) {
      return;
    }

    const handleMouseMove = (event: globalThis.MouseEvent) => {
      const state = resizeStateRef.current;
      if (!state) return;
      const deltaY = event.clientY - state.startY;
      // Top resize-handle: dragging up expands, dragging down shrinks.
      onBodyHeightChange(clampHeight(state.startHeight - deltaY));
    };

    const handleMouseUp = () => {
      resizeStateRef.current = null;
      setIsResizing(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, onBodyHeightChange]);

  return (
    <section
      className="va-outline-pane"
      onDragEnter={(event) => {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => {
        if (entries.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        const draggedEntryId = readDraggedEntryId(event);
        if (!draggedEntryId) return;
        const fallbackTarget = entries[entries.length - 1]!;
        onMoveEntry(draggedEntryId, fallbackTarget.id, fallbackTarget.level);
        setDraggingId(null);
        setDropHint(null);
      }}
    >
      <button
        type="button"
        className="va-outline-head"
        onClick={onToggleCollapsed}
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expand outline" : "Collapse outline"}
      >
        <span className={`va-outline-caret${collapsed ? " collapsed" : ""}`} aria-hidden="true" />
        <strong>Outline</strong>
      </button>

      {!collapsed ? (
        <>
          <div
            className="va-outline-resizer"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize outline"
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              resizeStateRef.current = {
                startY: event.clientY,
                startHeight: clampHeight(bodyHeight)
              };
              setIsResizing(true);
            }}
          />

          <div
            className="va-outline-body"
            style={{ height: `${clampHeight(bodyHeight)}px` }}
            onDragEnter={(event) => {
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = "move";
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = "move";
            }}
            onDrop={(event) => {
              if (entries.length === 0) return;
              event.preventDefault();
              event.stopPropagation();
              const draggedEntryId = readDraggedEntryId(event);
              if (!draggedEntryId) return;
              const fallbackTarget = entries[entries.length - 1]!;
              onMoveEntry(draggedEntryId, fallbackTarget.id, fallbackTarget.level);
              setDraggingId(null);
              setDropHint(null);
            }}
          >
            {!markdownVisible ? (
              <p className="va-outline-empty">Outline is available for markdown files.</p>
            ) : entries.length === 0 ? (
              <p className="va-outline-empty">No headings found.</p>
            ) : (
              <ul className="va-outline-list">
                {entries.map((entry) => {
                  const isDropTarget = dropHint?.targetId === entry.id;
                  const highlightedLevel = isDropTarget ? dropHint?.targetLevel : entry.level;

                  return (
                    <li key={entry.id}>
                      <button
                        type="button"
                        className={[
                          "va-outline-row",
                          draggingId === entry.id ? "dragging" : "",
                          isDropTarget ? "drop-target" : ""
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        style={{ paddingLeft: `${0.45 + ((highlightedLevel ?? entry.level) - 1) * 0.7}rem` }}
                        onClick={() => onSelectEntry(entry)}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onOpenContextMenu(event, entry);
                        }}
                        onDragStart={(event) => {
                          setDraggingId(entry.id);
                          setDropHint({ targetId: entry.id, targetLevel: entry.level });
                          event.dataTransfer.setData(OUTLINE_DRAG_MIME, entry.id);
                          event.dataTransfer.setData("text/plain", entry.id);
                          event.dataTransfer.effectAllowed = "move";
                        }}
                        onDragEnter={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          event.dataTransfer.dropEffect = "move";
                        }}
                        onDragOver={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          event.dataTransfer.dropEffect = "move";
                          if (!draggingId) return;
                          const targetLevel = resolveDropLevel(event, entry.level);
                          setDropHint({ targetId: entry.id, targetLevel });
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          const draggedEntryId = readDraggedEntryId(event);
                          if (!draggedEntryId) return;
                          const targetLevel = resolveDropLevel(event, entry.level);
                          onMoveEntry(draggedEntryId, entry.id, targetLevel);
                          setDraggingId(null);
                          setDropHint(null);
                        }}
                        onDragEnd={() => {
                          setDraggingId(null);
                          setDropHint(null);
                        }}
                        draggable
                        title={`${entry.title} (line ${entry.line})`}
                      >
                        <span className="va-outline-title-wrap">
                          <span className="va-outline-level" aria-hidden="true">{"#".repeat(entry.level)}</span>
                          <span className="va-outline-title">{entry.title}</span>
                        </span>
                        <small>#{entry.level}</small>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}
