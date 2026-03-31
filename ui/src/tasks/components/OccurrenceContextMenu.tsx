/**
 * OccurrenceContextMenu.tsx
 * Fixed-position context menu for multi-selected occurrence rows.
 * Receives all state and handlers as props  Eno internal state.
 */

import type { TaskOccurrenceRow } from "../types";
import { toDateKey } from "../../lib/taskDateUtils";

export interface OccurrenceContextMenuProps {
  visible: boolean;
  x: number;
  y: number;
  showMoveDateInput: boolean;
  moveDateInput: string;
  selectedOccurrenceKeys: Set<string>;
  activeOccurrenceRows: TaskOccurrenceRow[];
  myDayFlaggedIds: Set<string>;
  today: Date;
  onMarkDone: () => void;
  onSkip: () => void;
  onShowMoveDate: () => void;
  onMoveDateChange: (value: string) => void;
  onConfirmMove: () => void;
  onDeleteSelected: () => void;
  onToggleToday: (add: boolean) => void;
}

export function OccurrenceContextMenu({
  visible,
  x,
  y,
  showMoveDateInput,
  moveDateInput,
  selectedOccurrenceKeys,
  activeOccurrenceRows,
  myDayFlaggedIds,
  today,
  onMarkDone,
  onSkip,
  onShowMoveDate,
  onMoveDateChange,
  onConfirmMove,
  onDeleteSelected,
  onToggleToday,
}: OccurrenceContextMenuProps) {
  if (!visible) return null;

  const selRows = activeOccurrenceRows.filter((r) => selectedOccurrenceKeys.has(r.key));
  const anyNotInToday = selRows.some((r) => !myDayFlaggedIds.has(r.taskId));
  const anyInToday = selRows.some((r) => myDayFlaggedIds.has(r.taskId));

  return (
    <div
      className="task-occurrence-menu"
      style={{ top: y, left: x }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <button type="button" onClick={onMarkDone}>Mark as Done</button>
      <button type="button" onClick={onSkip}>Skip task</button>
      {!showMoveDateInput ? (
        <button
          type="button"
          onClick={() => {
            onShowMoveDate();
            onMoveDateChange(toDateKey(today));
          }}
        >
          Move to date
        </button>
      ) : (
        <div className="occurrence-menu-date-row" onClick={(e) => e.stopPropagation()}>
          <input
            type="date"
            className="occurrence-menu-date-input"
            value={moveDateInput}
            onChange={(e) => onMoveDateChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onConfirmMove(); }}
            aria-label="Move selected tasks to date"
            title="Move selected tasks to date"
            autoFocus
          />
          <button type="button" onClick={onConfirmMove} disabled={!moveDateInput}>OK</button>
        </div>
      )}
      <button type="button" className="danger" onClick={onDeleteSelected}>Remove occurrence</button>
      <hr className="occurrence-menu-divider" />
      {anyNotInToday && (
        <button type="button" onClick={() => onToggleToday(true)}>Add to Today</button>
      )}
      {anyInToday && (
        <button type="button" onClick={() => onToggleToday(false)}>Remove from Today</button>
      )}
    </div>
  );
}

