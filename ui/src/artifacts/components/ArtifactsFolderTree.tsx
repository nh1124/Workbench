import { useEffect, useState } from "react";
import type { TreeFolderNode } from "../types";
import { normalizePath } from "../utils/path";
import { IcoFolder } from "./ArtifactsIcons";

interface ArtifactsFolderTreeProps {
  root: TreeFolderNode;
  currentFolderPath: string;
  onSelectFolder: (path: string) => void;
}

export function ancestorFolderPaths(folderPath: string): string[] {
  const normalizedPath = normalizePath(folderPath);
  if (!normalizedPath) return [];
  const segments = normalizedPath.split("/");
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}

function expandedPathRecord(paths: string[]): Record<string, true> {
  const expanded: Record<string, true> = {};
  for (const path of paths) {
    expanded[path] = true;
  }
  return expanded;
}

function sortedFolders(node: TreeFolderNode): TreeFolderNode[] {
  return [...node.folders.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
}

export function ArtifactsFolderTree({
  root,
  currentFolderPath,
  onSelectFolder
}: ArtifactsFolderTreeProps) {
  const [expandedPaths, setExpandedPaths] = useState<Record<string, true>>(() =>
    expandedPathRecord(ancestorFolderPaths(currentFolderPath))
  );

  useEffect(() => {
    const ancestors = ancestorFolderPaths(currentFolderPath);
    if (ancestors.length === 0) return;
    setExpandedPaths((current) => {
      const missing = ancestors.filter((path) => !current[path]);
      if (missing.length === 0) return current;
      return { ...current, ...expandedPathRecord(missing) };
    });
  }, [currentFolderPath]);

  const toggleFolder = (path: string) => {
    setExpandedPaths((current) => {
      if (!current[path]) return { ...current, [path]: true };
      const next = { ...current };
      delete next[path];
      return next;
    });
  };

  const renderFolders = (node: TreeFolderNode, depth: number) =>
    sortedFolders(node).map((folder) => {
      const hasChildren = folder.folders.size > 0;
      const isExpanded = Boolean(expandedPaths[folder.path]);
      const isActive = currentFolderPath === folder.path;
      return (
        <div className="va-folder-tree-node" key={folder.path}>
          <div
            className={isActive ? "va-folder-tree-row active" : "va-folder-tree-row"}
            style={{ paddingLeft: `${0.4 + depth * 0.7}rem` }}
            aria-current={isActive ? "true" : undefined}
          >
            {hasChildren ? (
              <button
                type="button"
                className="va-folder-tree-disclosure"
                aria-label={`${isExpanded ? "Collapse" : "Expand"} ${folder.name}`}
                aria-expanded={isExpanded}
                onClick={() => toggleFolder(folder.path)}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d={isExpanded ? "M4 6l4 4 4-4" : "M6 4l4 4-4 4"}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            ) : (
              <span className="va-folder-tree-disclosure-placeholder" aria-hidden="true" />
            )}
            <button
              type="button"
              className="va-folder-tree-select"
              title={folder.path}
              onClick={() => onSelectFolder(folder.path)}
            >
              <span className="va-folder-tree-icon" aria-hidden="true"><IcoFolder /></span>
              <span className="va-folder-tree-label">{folder.name}</span>
            </button>
          </div>
          {hasChildren && isExpanded ? renderFolders(folder, depth + 1) : null}
        </div>
      );
    });

  const rootActive = currentFolderPath === "";

  return (
    <nav className="va-folder-tree" aria-label="Artifact folders">
      <div className="artifacts-menu-group-title va-folder-tree-title">Folders</div>
      <div
        className={rootActive ? "va-folder-tree-row active" : "va-folder-tree-row"}
        style={{ paddingLeft: "0.4rem" }}
        aria-current={rootActive ? "true" : undefined}
      >
        <span className="va-folder-tree-disclosure-placeholder" aria-hidden="true" />
        <button
          type="button"
          className="va-folder-tree-select"
          title="All artifacts"
          onClick={() => onSelectFolder("")}
        >
          <span className="va-folder-tree-icon" aria-hidden="true"><IcoFolder /></span>
          <span className="va-folder-tree-label">All artifacts</span>
        </button>
      </div>
      {renderFolders(root, 1)}
    </nav>
  );
}
