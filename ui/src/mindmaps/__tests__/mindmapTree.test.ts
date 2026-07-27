// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  clampCanvasZoom,
  countNodes,
  extensionForFilename,
  findNode,
  insertChild,
  layoutNodes,
  newNode,
  removeNode,
  selectedProjectName,
  updateNode
} from "../utils/mindmapTree";
import type { MindmapNode } from "../../types/models";

/**
 * The mindmap tree helpers drive every edit on the canvas and had no coverage
 * while they lived inside the page component. They are pure, so extracting
 * them made them directly testable — these are the tests that were not
 * possible before.
 */

function tree(): MindmapNode {
  return {
    id: "root",
    title: "Root",
    children: [
      { id: "a", title: "A", children: [{ id: "a1", title: "A1", children: [] }] },
      { id: "b", title: "B", children: [] }
    ]
  } as MindmapNode;
}

describe("findNode", () => {
  it("finds the root, a child and a grandchild", () => {
    const root = tree();
    expect(findNode(root, "root")?.title).toBe("Root");
    expect(findNode(root, "b")?.title).toBe("B");
    expect(findNode(root, "a1")?.title).toBe("A1");
  });

  it("returns undefined for an unknown id", () => {
    expect(findNode(tree(), "nope")).toBeUndefined();
  });
});

describe("updateNode", () => {
  it("replaces only the target and leaves siblings untouched", () => {
    const root = tree();
    const next = updateNode(root, "a1", (node) => ({ ...node, title: "renamed" }));

    expect(findNode(next, "a1")?.title).toBe("renamed");
    expect(findNode(next, "b")?.title).toBe("B");
  });

  it("does not mutate the original tree", () => {
    const root = tree();
    updateNode(root, "a1", (node) => ({ ...node, title: "renamed" }));
    expect(findNode(root, "a1")?.title).toBe("A1");
  });

  it("returns an equivalent tree when the id is absent", () => {
    const root = tree();
    const next = updateNode(root, "missing", (node) => ({ ...node, title: "x" }));
    expect(countNodes(next)).toBe(countNodes(root));
    expect(findNode(next, "a1")?.title).toBe("A1");
  });
});

describe("removeNode", () => {
  it("removes a leaf and leaves the rest intact", () => {
    const next = removeNode(tree(), "a1");
    expect(findNode(next, "a1")).toBeUndefined();
    expect(findNode(next, "a")).toBeDefined();
    expect(countNodes(next)).toBe(3);
  });

  it("removes a subtree with its descendants", () => {
    const next = removeNode(tree(), "a");
    expect(findNode(next, "a")).toBeUndefined();
    expect(findNode(next, "a1")).toBeUndefined();
    expect(countNodes(next)).toBe(2);
  });

  it("cannot remove the root, which has no parent to remove it from", () => {
    const next = removeNode(tree(), "root");
    expect(next.id).toBe("root");
  });

  it("does not mutate the original tree", () => {
    const root = tree();
    removeNode(root, "a");
    expect(findNode(root, "a")).toBeDefined();
  });
});

describe("insertChild", () => {
  it("appends a child under the target and reports its id", () => {
    const { root: next, childId } = insertChild(tree(), "b");

    const parent = findNode(next, "b");
    expect(parent?.children?.length).toBe(1);
    expect(parent?.children?.[0]?.id).toBe(childId);
    expect(findNode(next, childId)).toBeDefined();
  });

  it("expands a collapsed parent so the new child is visible", () => {
    const root = tree();
    const collapsed = updateNode(root, "a", (node) => ({ ...node, collapsed: true }));

    const { root: next } = insertChild(collapsed, "a");
    expect(findNode(next, "a")?.collapsed).toBe(false);
  });

  it("gives each new node a distinct id", () => {
    const first = insertChild(tree(), "b");
    const second = insertChild(first.root, "b");
    expect(second.childId).not.toBe(first.childId);
  });
});

describe("countNodes", () => {
  it("counts the root and every descendant", () => {
    expect(countNodes(tree())).toBe(4);
    expect(countNodes(newNode())).toBe(1);
  });
});

describe("clampCanvasZoom", () => {
  it("holds the zoom inside its range", () => {
    expect(clampCanvasZoom(99)).toBe(2.25);
    expect(clampCanvasZoom(0)).toBe(0.45);
    expect(clampCanvasZoom(1)).toBe(1);
  });

  it("rounds to two decimals so repeated steps do not drift", () => {
    expect(clampCanvasZoom(1.234567)).toBe(1.23);
    expect(clampCanvasZoom(1.235)).toBe(1.24);
  });
});

describe("layoutNodes", () => {
  it("places each depth in its own column and returns every node", () => {
    const { nodes } = layoutNodes(tree());

    expect(nodes.length).toBe(4);
    const byId = new Map(nodes.map((entry) => [entry.node.id, entry]));
    expect(byId.get("root")?.depth).toBe(0);
    expect(byId.get("a")?.depth).toBe(1);
    expect(byId.get("a1")?.depth).toBe(2);
    expect(byId.get("a")!.x).toBeGreaterThan(byId.get("root")!.x);
    expect(byId.get("a1")!.x).toBeGreaterThan(byId.get("a")!.x);
  });

  it("records each node's parent", () => {
    const { nodes } = layoutNodes(tree());
    const byId = new Map(nodes.map((entry) => [entry.node.id, entry]));

    expect(byId.get("root")?.parentId).toBeUndefined();
    expect(byId.get("a1")?.parentId).toBe("a");
  });

  it("omits the children of a collapsed node", () => {
    const collapsed = updateNode(tree(), "a", (node) => ({ ...node, collapsed: true }));
    const { nodes } = layoutNodes(collapsed);

    expect(nodes.some((entry) => entry.node.id === "a1")).toBe(false);
    expect(nodes.some((entry) => entry.node.id === "a")).toBe(true);
  });

  it("keeps a minimum canvas size even for a single node", () => {
    const { width, height } = layoutNodes(newNode());
    expect(width).toBeGreaterThanOrEqual(1320);
    expect(height).toBeGreaterThanOrEqual(760);
  });
});

describe("selectedProjectName", () => {
  const projects = [
    { id: "p1", name: "Finance" },
    { id: "p2", name: "Ops" }
  ] as Parameters<typeof selectedProjectName>[0];

  it("resolves a known project id", () => {
    expect(selectedProjectName(projects, "p2")).toBe("Ops");
  });

  it("returns undefined for an unknown or absent id", () => {
    expect(selectedProjectName(projects, "nope")).toBeUndefined();
    expect(selectedProjectName(projects, undefined)).toBeUndefined();
  });
});

// The result feeds a file-picker `accept` list, which wants the leading dot,
// so the extension is returned with it and with its original case.
describe("extensionForFilename", () => {
  it("keeps the leading dot and the original case", () => {
    expect(extensionForFilename("Diagram.PNG")).toBe(".PNG");
    expect(extensionForFilename("notes.md")).toBe(".md");
  });

  it("takes only the final extension when the name has several dots", () => {
    expect(extensionForFilename("my.map.v2.svg")).toBe(".svg");
  });

  it("falls back to .txt when there is no extension to read", () => {
    expect(extensionForFilename("README")).toBe(".txt");
    expect(extensionForFilename("trailing.")).toBe(".txt");
  });
});
