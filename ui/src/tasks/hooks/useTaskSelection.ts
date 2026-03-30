/**
 * useTaskSelection.ts
 * Owns the multi-select state for occurrence rows (shift-click / ctrl-click),
 * the context menu position, and the move-date sub-input.
 *
 * Behavior is identical to the selection/context-menu logic in TasksPage.tsx.
 */

import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { TaskOccurrenceRow } from "../types";

export interface OccurrenceMenuState {
  x: number;
  y: number;
  visible: boolean;
}

export interface TaskSelectionState {
  selectedOccurrenceKeys: Set<string>;
  lastOccurrenceKey: string | null;
  occurrenceMenu: OccurrenceMenuState;
  showMoveDateInput: boolean;
  moveDateInput: string;
}

export interface TaskSelectionActions {
  handleOccurrenceClick: (
    event: ReactMouseEvent<HTMLButtonElement>,
    row: TaskOccurrenceRow,
    activeOccurrenceOrderedKeys: string[],
    onOpen: (row: TaskOccurrenceRow) => void
  ) => void;
  ensureContextSelection: (
    row: TaskOccurrenceRow,
    x: number,
    y: number
  ) => void;
  getSelectedOccurrenceRows: (
    activeOccurrenceRows: TaskOccurrenceRow[]
  ) => TaskOccurrenceRow[];
  setSelectedOccurrenceKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  setLastOccurrenceKey: React.Dispatch<React.SetStateAction<string | null>>;
  setOccurrenceMenu: React.Dispatch<React.SetStateAction<OccurrenceMenuState>>;
  setShowMoveDateInput: React.Dispatch<React.SetStateAction<boolean>>;
  setMoveDateInput: React.Dispatch<React.SetStateAction<string>>;
  clearSelection: () => void;
}

export function useTaskSelection(): TaskSelectionState & TaskSelectionActions {
  const [selectedOccurrenceKeys, setSelectedOccurrenceKeys] = useState<Set<string>>(new Set());
  const [lastOccurrenceKey, setLastOccurrenceKey] = useState<string | null>(null);
  const [occurrenceMenu, setOccurrenceMenu] = useState<OccurrenceMenuState>({
    x: 0,
    y: 0,
    visible: false
  });
  const [showMoveDateInput, setShowMoveDateInput] = useState(false);
  const [moveDateInput, setMoveDateInput] = useState("");

  // Close menu on outside click/ESC
  useEffect(() => {
    if (!occurrenceMenu.visible) {
      setShowMoveDateInput(false);
      setMoveDateInput("");
      return;
    }
    const close = () =>
      setOccurrenceMenu((prev) => ({ ...prev, visible: false }));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [occurrenceMenu.visible]);

  const clearSelection = () => {
    setSelectedOccurrenceKeys(new Set());
    setLastOccurrenceKey(null);
    setOccurrenceMenu((prev) => ({ ...prev, visible: false }));
  };

  /**
   * Handle a click on an occurrence row.
   * - Shift: range-select from lastOccurrenceKey to this row (anchor stays fixed).
   * - Ctrl/Meta: toggle this row in the selection.
   * - Plain: select only this row and open its detail via `onOpen`.
   */
  const handleOccurrenceClick = (
    event: ReactMouseEvent<HTMLButtonElement>,
    row: TaskOccurrenceRow,
    activeOccurrenceOrderedKeys: string[],
    onOpen: (row: TaskOccurrenceRow) => void
  ) => {
    const isShift = event.shiftKey;
    const isToggle = event.metaKey || event.ctrlKey;

    if (isShift || isToggle) event.preventDefault();

    if (isShift) {
      if (lastOccurrenceKey) {
        const start = activeOccurrenceOrderedKeys.indexOf(lastOccurrenceKey);
        const end = activeOccurrenceOrderedKeys.indexOf(row.key);
        const rangeSet = new Set<string>();
        if (start >= 0 && end >= 0) {
          const [from, to] = start < end ? [start, end] : [end, start];
          for (let i = from; i <= to; i++) {
            rangeSet.add(activeOccurrenceOrderedKeys[i]);
          }
        } else {
          rangeSet.add(lastOccurrenceKey);
          rangeSet.add(row.key);
        }
        setSelectedOccurrenceKeys(rangeSet);
        // anchor stays — do NOT update lastOccurrenceKey
      } else {
        setSelectedOccurrenceKeys(new Set([row.key]));
        setLastOccurrenceKey(row.key);
      }
    } else if (isToggle) {
      const next = new Set(selectedOccurrenceKeys);
      if (next.has(row.key)) next.delete(row.key);
      else next.add(row.key);
      setSelectedOccurrenceKeys(next);
      setLastOccurrenceKey(row.key);
    } else {
      setSelectedOccurrenceKeys(new Set([row.key]));
      setLastOccurrenceKey(row.key);
      onOpen(row);
    }
  };

  /**
   * Ensure the right-clicked row is in the selection,
   * then open the context menu at (x, y).
   */
  const ensureContextSelection = (
    row: TaskOccurrenceRow,
    x: number,
    y: number
  ) => {
    setSelectedOccurrenceKeys((prev) => {
      if (prev.has(row.key)) return prev;
      return new Set([row.key]);
    });
    setLastOccurrenceKey(row.key);
    setOccurrenceMenu({ x, y, visible: true });
  };

  const getSelectedOccurrenceRows = (
    activeOccurrenceRows: TaskOccurrenceRow[]
  ): TaskOccurrenceRow[] => {
    if (selectedOccurrenceKeys.size === 0) return [];
    return activeOccurrenceRows.filter((row) =>
      selectedOccurrenceKeys.has(row.key)
    );
  };

  return {
    selectedOccurrenceKeys,
    lastOccurrenceKey,
    occurrenceMenu,
    showMoveDateInput,
    moveDateInput,
    handleOccurrenceClick,
    ensureContextSelection,
    getSelectedOccurrenceRows,
    setSelectedOccurrenceKeys,
    setLastOccurrenceKey,
    setOccurrenceMenu,
    setShowMoveDateInput,
    setMoveDateInput,
    clearSelection
  };
}
