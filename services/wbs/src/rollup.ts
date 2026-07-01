import type { WbsItemStatus, WbsRollup } from "./types.js";

export interface WbsCodeNode {
  id: string;
  parentId?: string;
  sortOrder: number;
}

export interface WbsCodeAssignment {
  id: string;
  code: string;
}

export interface WbsRollupNode extends WbsCodeNode {
  effortHours?: number;
  progress?: number;
  status: WbsItemStatus;
}

function sortSiblings<T extends WbsCodeNode>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.id.localeCompare(b.id);
  });
}

export function recalculateWbsCodes(items: WbsCodeNode[]): WbsCodeAssignment[] {
  const byId = new Set(items.map((item) => item.id));
  const childrenByParent = new Map<string | undefined, WbsCodeNode[]>();

  for (const item of items) {
    const parentId = item.parentId && item.parentId !== item.id && byId.has(item.parentId) ? item.parentId : undefined;
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(item);
    childrenByParent.set(parentId, siblings);
  }

  for (const [parentId, children] of childrenByParent) {
    childrenByParent.set(parentId, sortSiblings(children));
  }

  const assignments: WbsCodeAssignment[] = [];
  const visited = new Set<string>();
  const active = new Set<string>();

  function walk(item: WbsCodeNode, path: number[]): void {
    if (visited.has(item.id) || active.has(item.id)) return;
    active.add(item.id);
    visited.add(item.id);
    assignments.push({ id: item.id, code: path.join(".") });

    const children = childrenByParent.get(item.id) ?? [];
    children.forEach((child, index) => {
      walk(child, [...path, index + 1]);
    });
    active.delete(item.id);
  }

  const roots = childrenByParent.get(undefined) ?? [];
  roots.forEach((root, index) => {
    walk(root, [index + 1]);
  });

  let nextRootIndex = roots.length + 1;
  for (const item of sortSiblings(items)) {
    if (!visited.has(item.id)) {
      walk(item, [nextRootIndex]);
      nextRootIndex += 1;
    }
  }

  return assignments;
}

function progressFromStatus(status: WbsItemStatus): number {
  if (status === "done") return 100;
  if (status === "doing") return 50;
  return 0;
}

function cleanProgress(value: number | undefined, status: WbsItemStatus): number {
  if (value === undefined || !Number.isFinite(value)) return progressFromStatus(status);
  return Math.min(Math.max(Math.round(value), 0), 100);
}

function cleanEffort(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(value, 0);
}

function combineProgress(children: WbsRollup[]): number {
  if (children.length === 0) return 0;
  const effortTotal = children.reduce((sum, child) => sum + child.effortHours, 0);
  if (effortTotal > 0) {
    return Math.round(children.reduce((sum, child) => sum + child.progress * child.effortHours, 0) / effortTotal);
  }
  return Math.round(children.reduce((sum, child) => sum + child.progress, 0) / children.length);
}

export function calculateItemRollups(items: WbsRollupNode[]): Map<string, WbsRollup> {
  const byId = new Map(items.map((item) => [item.id, item]));
  const childrenByParent = new Map<string, WbsRollupNode[]>();

  for (const item of items) {
    if (!item.parentId || item.parentId === item.id || !byId.has(item.parentId)) continue;
    const children = childrenByParent.get(item.parentId) ?? [];
    children.push(item);
    childrenByParent.set(item.parentId, children);
  }

  for (const [parentId, children] of childrenByParent) {
    childrenByParent.set(parentId, sortSiblings(children));
  }

  const memo = new Map<string, WbsRollup>();
  const active = new Set<string>();

  function ownRollup(item: WbsRollupNode): WbsRollup {
    return {
      effortHours: cleanEffort(item.effortHours),
      progress: cleanProgress(item.progress, item.status),
      itemCount: 1,
      doneCount: item.status === "done" ? 1 : 0
    };
  }

  function compute(item: WbsRollupNode): WbsRollup {
    const cached = memo.get(item.id);
    if (cached) return cached;
    if (active.has(item.id)) return ownRollup(item);

    active.add(item.id);
    const own = ownRollup(item);
    const childRollups = (childrenByParent.get(item.id) ?? []).map(compute);
    active.delete(item.id);

    const childEffort = childRollups.reduce((sum, child) => sum + child.effortHours, 0);
    const rollup: WbsRollup = {
      effortHours: own.effortHours + childEffort,
      progress: childRollups.length > 0 ? combineProgress(childRollups) : own.progress,
      itemCount: own.itemCount + childRollups.reduce((sum, child) => sum + child.itemCount, 0),
      doneCount: own.doneCount + childRollups.reduce((sum, child) => sum + child.doneCount, 0)
    };
    memo.set(item.id, rollup);
    return rollup;
  }

  for (const item of items) {
    compute(item);
  }

  return memo;
}

export function calculatePlanRollup(items: WbsRollupNode[]): WbsRollup {
  if (items.length === 0) {
    return { effortHours: 0, progress: 0, itemCount: 0, doneCount: 0 };
  }

  const byId = new Set(items.map((item) => item.id));
  const itemRollups = calculateItemRollups(items);
  const roots = sortSiblings(items.filter((item) => !item.parentId || !byId.has(item.parentId)));
  const rootRollups = roots.map((item) => itemRollups.get(item.id)).filter((rollup): rollup is WbsRollup => Boolean(rollup));

  return {
    effortHours: rootRollups.reduce((sum, rollup) => sum + rollup.effortHours, 0),
    progress: combineProgress(rootRollups),
    itemCount: rootRollups.reduce((sum, rollup) => sum + rollup.itemCount, 0),
    doneCount: rootRollups.reduce((sum, rollup) => sum + rollup.doneCount, 0)
  };
}

export function orderWbsItems<T extends WbsCodeNode>(items: T[]): T[] {
  const assignmentOrder = new Map(recalculateWbsCodes(items).map((assignment, index) => [assignment.id, index]));
  return [...items].sort((a, b) => {
    const aOrder = assignmentOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const bOrder = assignmentOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.id.localeCompare(b.id);
  });
}
