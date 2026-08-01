import type { DragEvent } from "react";
import type { ProjectRecord, WbsItem } from "../../types/models";

export type FlatWbsRow = {
  item: WbsItem;
  depth: number;
  childCount: number;
};

export type WbsDropPosition = "before" | "after" | "child";

export const WBS_MIN_ZOOM = 0.65;
export const WBS_MAX_ZOOM = 1.8;
export const WBS_ZOOM_STEP = 0.08;

export function selectedProjectName(projects: ProjectRecord[], projectId: string | undefined): string | undefined {
  if (!projectId) return undefined;
  return projects.find((project) => project.id === projectId)?.name;
}

export function flattenWbsItems(items: WbsItem[]): FlatWbsRow[] {
  const byParent = new Map<string, WbsItem[]>();
  for (const item of items) {
    const parentKey = item.parentId ?? "";
    const siblings = byParent.get(parentKey) ?? [];
    siblings.push(item);
    byParent.set(parentKey, siblings);
  }

  for (const siblings of byParent.values()) {
    siblings.sort((left, right) => left.sortOrder - right.sortOrder || left.code.localeCompare(right.code));
  }

  const rows: FlatWbsRow[] = [];
  const visit = (item: WbsItem, depth: number) => {
    const children = byParent.get(item.id) ?? [];
    rows.push({ item, depth, childCount: children.length });
    for (const child of children) visit(child, depth + 1);
  };

  for (const root of byParent.get("") ?? []) visit(root, 0);
  return rows;
}

export function numberOrUndefined(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function clampProgress(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function siblingRows(rows: FlatWbsRow[], item: WbsItem): FlatWbsRow[] {
  return rows.filter((row) => row.item.parentId === item.parentId);
}

export function clampWbsZoom(value: number): number {
  return Math.min(WBS_MAX_ZOOM, Math.max(WBS_MIN_ZOOM, Number(value.toFixed(2))));
}

export function isDirectEditTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("input, select, textarea, button"));
}

export function isInsideWbsItem(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("[data-wbs-item-id]"));
}

export function isDescendantItem(items: WbsItem[], candidateId: string, ancestorId: string): boolean {
  let current = items.find((item) => item.id === candidateId);
  while (current?.parentId) {
    if (current.parentId === ancestorId) return true;
    current = items.find((item) => item.id === current?.parentId);
  }
  return false;
}

export function dropPositionForEvent(event: DragEvent<HTMLTableRowElement>, depth: number): WbsDropPosition {
  const rect = event.currentTarget.getBoundingClientRect();
  const yRatio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
  if (yRatio < 0.28) return "before";
  if (yRatio > 0.72) return "after";
  const localX = event.clientX - rect.left;
  const childThreshold = 150 + depth * 20;
  return localX > childThreshold ? "child" : "after";
}
