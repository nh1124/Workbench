import type { MouseEvent as ReactMouseEvent } from "react";
import type { MindmapNode, ProjectRecord } from "../../types/models";

export type PositionedMindmapNode = {
  node: MindmapNode;
  depth: number;
  x: number;
  y: number;
  parentId?: string;
};

export const MIN_CANVAS_ZOOM = 0.45;
export const MAX_CANVAS_ZOOM = 2.25;
export const CANVAS_ZOOM_STEP = 0.1;
export const CANVAS_NODE_WIDTH = 218;
export const CANVAS_NODE_HEIGHT = 62;

export function newNode(title = "New node"): MindmapNode {
  return {
    id: createNodeId(),
    title,
    children: []
  };
}

export function createNodeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function findNode(root: MindmapNode, id: string): MindmapNode | undefined {
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return undefined;
}

export function updateNode(root: MindmapNode, id: string, updater: (node: MindmapNode) => MindmapNode): MindmapNode {
  if (root.id === id) return updater(root);
  return {
    ...root,
    children: (root.children ?? []).map((child) => updateNode(child, id, updater))
  };
}

export function removeNode(root: MindmapNode, id: string): MindmapNode {
  return {
    ...root,
    children: (root.children ?? [])
      .filter((child) => child.id !== id)
      .map((child) => removeNode(child, id))
  };
}

export function insertChild(root: MindmapNode, id: string): { root: MindmapNode; childId: string } {
  const child = newNode();
  return {
    childId: child.id,
    root: updateNode(root, id, (node) => ({
      ...node,
      collapsed: false,
      children: [...(node.children ?? []), child]
    }))
  };
}

export function countNodes(root: MindmapNode): number {
  return 1 + (root.children ?? []).reduce((sum, child) => sum + countNodes(child), 0);
}

export function clampCanvasZoom(value: number): number {
  return Math.min(MAX_CANVAS_ZOOM, Math.max(MIN_CANVAS_ZOOM, Number(value.toFixed(2))));
}

export function layoutNodes(root: MindmapNode): { nodes: PositionedMindmapNode[]; width: number; height: number } {
  const nodes: PositionedMindmapNode[] = [];
  let row = 0;

  function walk(node: MindmapNode, depth: number, parentId?: string): void {
    const children = node.collapsed ? [] : (node.children ?? []);
    const startRow = row;
    if (children.length === 0) {
      row += 1;
    } else {
      for (const child of children) {
        walk(child, depth + 1, node.id);
      }
    }
    const endRow = Math.max(row - 1, startRow);
    nodes.push({
      node,
      depth,
      parentId,
      x: 64 + depth * 280,
      y: 70 + ((startRow + endRow) / 2) * 106
    });
  }

  walk(root, 0);
  return {
    nodes,
    width: Math.max(1320, ...nodes.map((item) => item.x + 260)),
    height: Math.max(760, ...nodes.map((item) => item.y + 110))
  };
}

export function selectedProjectName(projects: ProjectRecord[], projectId: string | undefined): string | undefined {
  if (!projectId) return undefined;
  return projects.find((project) => project.id === projectId)?.name;
}

export function contextMenuPosition(event: ReactMouseEvent): { x: number; y: number } {
  const margin = 8;
  const width = 220;
  const height = 170;
  const x = Math.max(margin, Math.min(event.clientX, window.innerWidth - width - margin));
  const y = Math.max(margin, Math.min(event.clientY, window.innerHeight - height - margin));
  return { x, y };
}

export function extensionForFilename(filename: string): string {
  const match = filename.match(/\.[a-z0-9]+$/i);
  return match?.[0] ?? ".txt";
}
