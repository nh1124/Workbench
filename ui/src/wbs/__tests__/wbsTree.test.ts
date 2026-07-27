// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  clampProgress,
  clampWbsZoom,
  flattenWbsItems,
  isDescendantItem,
  isDirectEditTarget,
  isInsideWbsItem,
  numberOrUndefined,
  siblingRows
} from "../utils/wbsTree";
import type { WbsItem } from "../../types/models";

/**
 * The WBS tree helpers decide row ordering, drag validity and edit targets, and
 * had no coverage while they lived inside the page component. They are pure, so
 * extracting them made them directly testable.
 */

function item(overrides: Partial<WbsItem> & { id: string; code: string }): WbsItem {
  return {
    planId: "plan-1",
    parentId: undefined,
    title: overrides.id,
    status: "todo",
    sortOrder: 0,
    ...overrides
  } as WbsItem;
}

describe("flattenWbsItems", () => {
  it("returns roots first with their descendants in depth order", () => {
    const rows = flattenWbsItems([
      item({ id: "c", code: "1.1", parentId: "a", sortOrder: 0 }),
      item({ id: "a", code: "1", sortOrder: 0 }),
      item({ id: "b", code: "2", sortOrder: 1 })
    ]);

    expect(rows.map((row) => row.item.id)).toEqual(["a", "c", "b"]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 0]);
  });

  it("reports how many direct children each row has", () => {
    const rows = flattenWbsItems([
      item({ id: "a", code: "1" }),
      item({ id: "a1", code: "1.1", parentId: "a" }),
      item({ id: "a2", code: "1.2", parentId: "a", sortOrder: 1 })
    ]);

    const byId = new Map(rows.map((row) => [row.item.id, row]));
    expect(byId.get("a")?.childCount).toBe(2);
    expect(byId.get("a1")?.childCount).toBe(0);
  });

  it("orders siblings by sortOrder, falling back to code", () => {
    const rows = flattenWbsItems([
      item({ id: "second", code: "2", sortOrder: 5 }),
      item({ id: "first", code: "1", sortOrder: 1 })
    ]);
    expect(rows.map((row) => row.item.id)).toEqual(["first", "second"]);

    const tied = flattenWbsItems([
      item({ id: "b", code: "2", sortOrder: 0 }),
      item({ id: "a", code: "1", sortOrder: 0 })
    ]);
    expect(tied.map((row) => row.item.id)).toEqual(["a", "b"]);
  });

  it("drops items whose parent is missing, since they have no root to hang from", () => {
    const rows = flattenWbsItems([
      item({ id: "a", code: "1" }),
      item({ id: "orphan", code: "9.9", parentId: "gone" })
    ]);

    expect(rows.map((row) => row.item.id)).toEqual(["a"]);
  });

  it("returns nothing for an empty plan", () => {
    expect(flattenWbsItems([])).toEqual([]);
  });
});

describe("siblingRows", () => {
  it("returns the rows sharing the target's parent", () => {
    const items = [
      item({ id: "a", code: "1" }),
      item({ id: "a1", code: "1.1", parentId: "a" }),
      item({ id: "a2", code: "1.2", parentId: "a", sortOrder: 1 }),
      item({ id: "b", code: "2", sortOrder: 1 })
    ];
    const rows = flattenWbsItems(items);

    const siblings = siblingRows(rows, items[1]!);
    expect(siblings.map((row) => row.item.id)).toEqual(["a1", "a2"]);
  });

  it("treats roots as siblings of each other", () => {
    const items = [item({ id: "a", code: "1" }), item({ id: "b", code: "2", sortOrder: 1 })];
    const rows = flattenWbsItems(items);

    expect(siblingRows(rows, items[0]!).map((row) => row.item.id)).toEqual(["a", "b"]);
  });
});

describe("isDescendantItem", () => {
  const items = [
    item({ id: "a", code: "1" }),
    item({ id: "a1", code: "1.1", parentId: "a" }),
    item({ id: "a1x", code: "1.1.1", parentId: "a1" }),
    item({ id: "b", code: "2" })
  ];

  it("detects direct and indirect descendants", () => {
    expect(isDescendantItem(items, "a1", "a")).toBe(true);
    expect(isDescendantItem(items, "a1x", "a")).toBe(true);
  });

  it("rejects unrelated items and self", () => {
    expect(isDescendantItem(items, "b", "a")).toBe(false);
    expect(isDescendantItem(items, "a", "a")).toBe(false);
    expect(isDescendantItem(items, "a", "a1")).toBe(false);
  });
});

describe("numberOrUndefined", () => {
  it("parses numbers and rejects anything that is not one", () => {
    expect(numberOrUndefined("42")).toBe(42);
    expect(numberOrUndefined("3.5")).toBe(3.5);
    expect(numberOrUndefined("abc")).toBeUndefined();
    expect(numberOrUndefined("Infinity")).toBeUndefined();
  });

  it("treats blank input as absent rather than zero", () => {
    expect(numberOrUndefined("")).toBeUndefined();
    expect(numberOrUndefined("   ")).toBeUndefined();
  });
});

describe("clampProgress", () => {
  it("holds progress between 0 and 100 and rounds it", () => {
    expect(clampProgress(150)).toBe(100);
    expect(clampProgress(-10)).toBe(0);
    expect(clampProgress(33.4)).toBe(33);
    expect(clampProgress(33.6)).toBe(34);
  });

  it("passes undefined through, so 'unset' stays distinct from 0", () => {
    expect(clampProgress(undefined)).toBeUndefined();
  });
});

describe("clampWbsZoom", () => {
  it("holds the zoom inside its range and rounds to two decimals", () => {
    expect(clampWbsZoom(99)).toBe(1.8);
    expect(clampWbsZoom(0)).toBe(0.65);
    expect(clampWbsZoom(1.234567)).toBe(1.23);
  });
});

describe("event target helpers", () => {
  it("recognises form controls as direct edit targets", () => {
    const row = document.createElement("div");
    row.innerHTML = '<input id="i" /><span id="s">text</span><button id="btn">x</button>';
    document.body.appendChild(row);

    expect(isDirectEditTarget(row.querySelector("#i"))).toBe(true);
    expect(isDirectEditTarget(row.querySelector("#btn"))).toBe(true);
    expect(isDirectEditTarget(row.querySelector("#s"))).toBe(false);
    expect(isDirectEditTarget(null)).toBe(false);
  });

  it("recognises anything inside a WBS row, including nested nodes", () => {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = '<div data-wbs-item-id="a"><span id="inner">t</span></div><span id="outside">o</span>';
    document.body.appendChild(wrapper);

    expect(isInsideWbsItem(wrapper.querySelector("#inner"))).toBe(true);
    expect(isInsideWbsItem(wrapper.querySelector("[data-wbs-item-id]"))).toBe(true);
    expect(isInsideWbsItem(wrapper.querySelector("#outside"))).toBe(false);
    expect(isInsideWbsItem(null)).toBe(false);
  });
});
