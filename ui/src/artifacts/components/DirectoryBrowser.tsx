import type { DragEvent, MouseEvent } from "react";
import type { ArtifactItem } from "../../types/models";
import { formatDateTime, normalizeProjectName } from "../../lib/format";
import type { TreeContextTarget, TreeFolderNode } from "../types";
import { formatSize } from "../utils/file";
import { normalizePath, parentPath } from "../utils/path";
import { sortItems } from "../utils/tree";
import { IcoFile, IcoFolder } from "./ArtifactsIcons";

export type DirectoryViewMode = "tile" | "list";

interface DirectoryBrowserProps {
  currentFolderNode: TreeFolderNode;
  currentFolderPath: string;
  viewMode?: DirectoryViewMode;
  selectedFolderPath: string | null;
  selectedItemIdSet: Set<string>;
  dropTargetPath: string | null;
  draggingItemId: string | null;
  setSelectedFolderPath: (path: string) => void;
  updateSelection: (itemId: string, options?: { shiftKey?: boolean; toggleKey?: boolean }) => void;
  openContextMenu: (event: MouseEvent<HTMLButtonElement | HTMLElement>, target: TreeContextTarget) => void;
  handleDragStart: (event: DragEvent<HTMLButtonElement>, item: ArtifactItem) => void;
  handleDragEnd: () => void;
  handleFolderDragOver: (event: DragEvent<HTMLButtonElement>, targetFolderPath: string) => void;
  handleFolderDrop: (event: DragEvent<HTMLButtonElement>, targetFolderPath: string) => void;
  selectItem: (item: ArtifactItem, options?: { shiftKey?: boolean; toggleKey?: boolean }) => void;
}

export function DirectoryBrowser({
  currentFolderNode,
  currentFolderPath,
  viewMode = "tile",
  selectedFolderPath,
  selectedItemIdSet,
  dropTargetPath,
  draggingItemId,
  setSelectedFolderPath,
  updateSelection,
  openContextMenu,
  handleDragStart,
  handleDragEnd,
  handleFolderDragOver,
  handleFolderDrop,
  selectItem
}: DirectoryBrowserProps) {
  const sortedFolders = [...currentFolderNode.folders.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
  const sortedItems = sortItems(currentFolderNode.items);
  const projectLabel = (item?: ArtifactItem) =>
    item ? normalizeProjectName(item.projectId, item.projectName) : "-";
  const updatedLabel = (item?: ArtifactItem) => item?.updatedAt ? formatDateTime(item.updatedAt) : "-";

  return (
    <ul className={`va-tree-list ${viewMode === "list" ? "list-view" : "tile-view"}`}>
      {viewMode === "list" ? (
        <li className="va-tree-list-header" aria-hidden="true">
          <span>Name</span>
          <span>Project</span>
          <span>Updated</span>
          <span>Size</span>
        </li>
      ) : null}
      {currentFolderPath !== "" && (
        <li>
          <button
            type="button"
            className="va-tree-row folder"
            onClick={() => setSelectedFolderPath(parentPath(currentFolderPath))}
          >
            <span className="va-tree-icon" aria-hidden="true"><IcoFolder /></span>
            <span className="va-tree-label">..</span>
            <span className="va-tree-meta list-only">-</span>
            <span className="va-tree-meta list-only">-</span>
            <span className="va-tree-meta list-only">-</span>
          </button>
        </li>
      )}
      {sortedFolders.map((childFolder) => {
        const isSelected = selectedFolderPath === childFolder.path;
        const isDropTarget = dropTargetPath === normalizePath(childFolder.path);
        const draggableFolderItem = childFolder.folderItem;
        const isFolderItemSelected = Boolean(draggableFolderItem && selectedItemIdSet.has(draggableFolderItem.id));

        return (
          <li key={`folder-${childFolder.path}`}>
            <button
              type="button"
              className={[
                "va-tree-row",
                "folder",
                isSelected ? "active" : "",
                isFolderItemSelected ? "multi-selected" : "",
                isDropTarget ? "drop-target" : "",
                draggableFolderItem && draggingItemId === draggableFolderItem.id ? "dragging" : ""
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={(event) => {
                const withToggle = event.ctrlKey || event.metaKey;
                const withShift = event.shiftKey;
                if (!withShift && !withToggle) {
                  setSelectedFolderPath(childFolder.path);
                }
                if (childFolder.folderItem) {
                  updateSelection(childFolder.folderItem.id, { shiftKey: withShift, toggleKey: withToggle });
                }
              }}
              onDoubleClick={() => setSelectedFolderPath(childFolder.path)}
              onContextMenu={(event) =>
                openContextMenu(event, {
                  type: "folder",
                  folderPath: childFolder.path
                })
              }
              draggable={Boolean(draggableFolderItem)}
              onDragStart={(event) => {
                if (!draggableFolderItem) return;
                handleDragStart(event, draggableFolderItem);
              }}
              onDragEnd={handleDragEnd}
              onDragEnter={(event) => handleFolderDragOver(event, childFolder.path)}
              onDragOver={(event) => handleFolderDragOver(event, childFolder.path)}
              onDrop={(event) => handleFolderDrop(event, childFolder.path)}
            >
              <span className="va-tree-icon" aria-hidden="true"><IcoFolder /></span>
              <span className="va-tree-label">{childFolder.name}</span>
              <span className="va-tree-meta list-only">{projectLabel(draggableFolderItem)}</span>
              <span className="va-tree-meta list-only">{updatedLabel(draggableFolderItem)}</span>
              <span className="va-tree-meta list-only">-</span>
            </button>
          </li>
        );
      })}

      {sortedItems.map((item) => {
        const isSelected = selectedItemIdSet.has(item.id);
        return (
          <li key={item.id}>
            <button
              type="button"
              className={[
                "va-tree-row",
                "item",
                isSelected ? "active" : "",
                isSelected ? "multi-selected" : "",
                draggingItemId === item.id ? "dragging" : ""
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={(event) => selectItem(item, { shiftKey: event.shiftKey, toggleKey: event.ctrlKey || event.metaKey })}
              onContextMenu={(event) => openContextMenu(event, { type: "item", item })}
              draggable
              onDragStart={(event) => handleDragStart(event, item)}
              onDragEnd={handleDragEnd}
            >
              <span className="va-tree-icon" aria-hidden="true"><IcoFile /></span>
              <span className="va-tree-label">{item.title}</span>
              <small className="tile-only">v{item.version}</small>
              <span className="va-tree-meta list-only">{projectLabel(item)}</span>
              <span className="va-tree-meta list-only">{updatedLabel(item)}</span>
              <span className="va-tree-meta list-only">{item.kind === "file" ? formatSize(item.sizeBytes) : "-"}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
