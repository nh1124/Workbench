import type { DragEvent, MouseEvent } from "react";
import type { ArtifactItem } from "../../types/models";
import type { TreeContextTarget, TreeFolderNode } from "../types";
import { normalizePath, parentPath } from "../utils/path";
import { sortItems } from "../utils/tree";
import { IcoFile, IcoFolder } from "./ArtifactsIcons";

interface DirectoryBrowserProps {
  currentFolderNode: TreeFolderNode;
  currentFolderPath: string;
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

  return (
    <ul className="va-tree-list">
      {currentFolderPath !== "" && (
        <li>
          <button
            type="button"
            className="va-tree-row folder"
            onClick={() => setSelectedFolderPath(parentPath(currentFolderPath))}
          >
            <span className="va-tree-icon" aria-hidden="true"><IcoFolder /></span>
            <span className="va-tree-label">..</span>
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
              <small>v{item.version}</small>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
