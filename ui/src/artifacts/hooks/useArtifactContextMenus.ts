import { useEffect, useMemo, useState } from "react";
import type {
  EditorContextMenuState,
  OutlineContextMenuState,
  TableContextMenuState,
  TreeContextMenuState
} from "../types";

export type ContextMenuPosition = { left: number; top: number };

/**
 * Owns the page's four context menus.
 *
 * They were four copies of the same clamping memo — differing only in the menu
 * size used to keep it inside the viewport — plus one effect that closes all of
 * them on Escape, resize or scroll. Keeping them together means a new menu
 * cannot forget the dismissal wiring.
 *
 * The clamp is shared rather than repeated; the sizes stay per-menu because
 * they describe the rendered menus and changing any of them would move where a
 * menu appears near a viewport edge.
 */
function clampToViewport(
  anchor: { x: number; y: number } | null,
  menuWidth: number,
  menuHeight: number
): ContextMenuPosition | null {
  if (!anchor) return null;
  const margin = 8;
  const maxX = window.innerWidth - menuWidth - margin;
  const maxY = window.innerHeight - menuHeight - margin;
  return {
    left: Math.max(margin, Math.min(anchor.x, maxX)),
    top: Math.max(margin, Math.min(anchor.y, maxY))
  };
}

export function useArtifactContextMenus() {
  const [contextMenu, setContextMenu] = useState<TreeContextMenuState | null>(null);
  const [tableContextMenu, setTableContextMenu] = useState<TableContextMenuState | null>(null);
  const [editorContextMenu, setEditorContextMenu] = useState<EditorContextMenuState | null>(null);
  const [outlineContextMenu, setOutlineContextMenu] = useState<OutlineContextMenuState | null>(null);

  const contextMenuPosition = useMemo(() => clampToViewport(contextMenu, 180, 320), [contextMenu]);
  const tableContextMenuPosition = useMemo(() => clampToViewport(tableContextMenu, 220, 220), [tableContextMenu]);
  const editorContextMenuPosition = useMemo(() => clampToViewport(editorContextMenu, 180, 110), [editorContextMenu]);
  const outlineContextMenuPosition = useMemo(() => clampToViewport(outlineContextMenu, 190, 160), [outlineContextMenu]);

  useEffect(() => {
    if (!contextMenu && !tableContextMenu && !editorContextMenu && !outlineContextMenu) return;

    const closeAll = () => {
      setContextMenu(null);
      setTableContextMenu(null);
      setEditorContextMenu(null);
      setOutlineContextMenu(null);
    };
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        closeAll();
      }
    };

    window.addEventListener("keydown", handleEscape);
    window.addEventListener("resize", closeAll);
    window.addEventListener("scroll", closeAll, true);
    return () => {
      window.removeEventListener("keydown", handleEscape);
      window.removeEventListener("resize", closeAll);
      window.removeEventListener("scroll", closeAll, true);
    };
  }, [contextMenu, editorContextMenu, outlineContextMenu, tableContextMenu]);

  return {
    contextMenu,
    setContextMenu,
    contextMenuPosition,
    tableContextMenu,
    setTableContextMenu,
    tableContextMenuPosition,
    editorContextMenu,
    setEditorContextMenu,
    editorContextMenuPosition,
    outlineContextMenu,
    setOutlineContextMenu,
    outlineContextMenuPosition
  };
}
