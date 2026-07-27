// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  applyTableOperation,
  applyTableSelectionVisual,
  getSelectedTableContext,
  isCellInTableSelection
} from "../utils/notionTableOps";
import type { TableSelectionState } from "../types";

/**
 * The Notion-style table editing logic used to live inside ArtifactsPage and had
 * no coverage at all. Extracting it to a module made it directly testable in
 * jsdom, which is the point of the extraction — these are the tests that were
 * impossible before.
 *
 * Row 0 is the header row; body rows start at 1. Several operations clamp with
 * Math.max(1, ...) so the header can never be deleted, which is asserted below.
 */

const TABLE_ID = "table-1";

/** Builds the editor DOM shape the operations look for: a block wrapping a table. */
function buildEditor(rows: number, cols: number): HTMLElement {
  const editor = document.createElement("div");
  const block = document.createElement("div");
  block.setAttribute("data-md-kind", "table");
  block.setAttribute("data-table-id", TABLE_ID);

  const table = document.createElement("table");
  const thead = table.createTHead();
  const headerRow = thead.insertRow();
  for (let col = 0; col < cols; col += 1) {
    const th = document.createElement("th");
    th.className = "va-notion-table-cell";
    th.textContent = `h${col}`;
    headerRow.appendChild(th);
  }

  const tbody = table.createTBody();
  for (let row = 1; row < rows; row += 1) {
    const tr = tbody.insertRow();
    for (let col = 0; col < cols; col += 1) {
      const td = document.createElement("td");
      td.className = "va-notion-table-cell";
      td.textContent = `r${row}c${col}`;
      tr.appendChild(td);
    }
  }

  block.appendChild(table);
  editor.appendChild(block);
  document.body.appendChild(editor);
  return editor;
}

function selection(startRow: number, startCol: number, endRow = startRow, endCol = startCol): TableSelectionState {
  return { tableId: TABLE_ID, start: { row: startRow, col: startCol }, end: { row: endRow, col: endCol } };
}

function shape(editor: HTMLElement) {
  const table = editor.querySelector("table") as HTMLTableElement;
  const header = table.tHead?.rows[0];
  const body = Array.from(table.tBodies[0]?.rows ?? []);
  return {
    headerCells: header ? header.cells.length : 0,
    bodyRows: body.length,
    bodyCells: body.map((row) => row.cells.length),
    text: body.map((row) => Array.from(row.cells).map((cell) => cell.textContent))
  };
}

describe("isCellInTableSelection", () => {
  it("includes cells inside the rectangle regardless of drag direction", () => {
    const dragged = selection(3, 4, 1, 2);
    expect(isCellInTableSelection(dragged, 2, 3)).toBe(true);
    expect(isCellInTableSelection(dragged, 1, 2)).toBe(true);
    expect(isCellInTableSelection(dragged, 3, 4)).toBe(true);
  });

  it("excludes cells outside the rectangle", () => {
    const sel = selection(1, 1, 2, 2);
    expect(isCellInTableSelection(sel, 0, 1)).toBe(false);
    expect(isCellInTableSelection(sel, 3, 1)).toBe(false);
    expect(isCellInTableSelection(sel, 1, 3)).toBe(false);
  });
});

describe("getSelectedTableContext", () => {
  it("resolves the table and clamps the selection to its real size", () => {
    const editor = buildEditor(3, 2);
    const context = getSelectedTableContext(editor, selection(0, 0, 99, 99));

    expect(context).not.toBeNull();
    expect(context!.rows.length).toBe(3);
    expect(context!.colCount).toBe(2);
    expect(context!.bounds.endRow).toBe(2);
    expect(context!.bounds.endCol).toBe(1);
  });

  it("returns null without an editor or a selection, and for an unknown table", () => {
    const editor = buildEditor(2, 2);
    expect(getSelectedTableContext(null, selection(1, 0))).toBeNull();
    expect(getSelectedTableContext(editor, null)).toBeNull();
    expect(getSelectedTableContext(editor, { ...selection(1, 0), tableId: "missing" })).toBeNull();
  });
});

describe("applyTableSelectionVisual", () => {
  it("marks exactly the selected cells and clears the previous marking", () => {
    const editor = buildEditor(3, 3);

    applyTableSelectionVisual(editor, selection(1, 0, 2, 1));
    expect(editor.querySelectorAll(".table-selected").length).toBe(4);

    applyTableSelectionVisual(editor, selection(1, 2));
    const marked = Array.from(editor.querySelectorAll(".table-selected"));
    expect(marked.length).toBe(1);
    expect(marked[0]?.textContent).toBe("r1c2");
  });

  it("clears all marking when the selection is dropped", () => {
    const editor = buildEditor(2, 2);
    applyTableSelectionVisual(editor, selection(1, 0, 1, 1));
    applyTableSelectionVisual(editor, null);
    expect(editor.querySelectorAll(".table-selected").length).toBe(0);
  });
});

describe("applyTableOperation rows", () => {
  it("inserts a row above the selected one", () => {
    const editor = buildEditor(3, 2); // header + 2 body rows
    applyTableOperation(editor, selection(2, 0), "insert-row-above");

    const after = shape(editor);
    expect(after.bodyRows).toBe(3);
    // The new empty row lands before the previously-second body row.
    expect(after.text[1]?.every((cell) => cell === "")).toBe(true);
    expect(after.text[2]?.[0]).toBe("r2c0");
  });

  it("inserts a row below the selected one", () => {
    const editor = buildEditor(3, 2);
    applyTableOperation(editor, selection(1, 0), "insert-row-below");

    const after = shape(editor);
    expect(after.bodyRows).toBe(3);
    expect(after.text[0]?.[0]).toBe("r1c0");
    expect(after.text[1]?.every((cell) => cell === "")).toBe(true);
  });

  it("deletes the selected body rows", () => {
    const editor = buildEditor(4, 2); // header + 3 body rows
    applyTableOperation(editor, selection(1, 0, 2, 0), "delete-rows");

    const after = shape(editor);
    expect(after.bodyRows).toBe(1);
    expect(after.text[0]?.[0]).toBe("r3c0");
  });

  it("keeps one empty body row rather than leaving the table with none", () => {
    const editor = buildEditor(2, 2); // header + 1 body row
    applyTableOperation(editor, selection(1, 0), "delete-rows");

    const after = shape(editor);
    expect(after.bodyRows).toBe(1);
    expect(after.text[0]?.every((cell) => cell === "")).toBe(true);
  });

  it("never deletes the header row even when it is selected", () => {
    const editor = buildEditor(3, 2);
    applyTableOperation(editor, selection(0, 0), "delete-rows");

    const table = editor.querySelector("table") as HTMLTableElement;
    expect(table.tHead?.rows.length).toBe(1);
    expect(table.tHead?.rows[0]?.cells[0]?.textContent).toBe("h0");
  });
});

describe("applyTableOperation columns", () => {
  it("inserts a column to the left of the selection", () => {
    const editor = buildEditor(3, 2);
    applyTableOperation(editor, selection(1, 1), "insert-column-left");

    const after = shape(editor);
    expect(after.headerCells).toBe(3);
    expect(after.bodyCells).toEqual([3, 3]);
    expect(after.text[0]?.[1]).toBe("");
    expect(after.text[0]?.[2]).toBe("r1c1");
  });

  it("inserts a column to the right of the selection", () => {
    const editor = buildEditor(3, 2);
    applyTableOperation(editor, selection(1, 0), "insert-column-right");

    const after = shape(editor);
    expect(after.headerCells).toBe(3);
    expect(after.text[0]?.[0]).toBe("r1c0");
    expect(after.text[0]?.[1]).toBe("");
  });

  it("deletes the selected column from every row including the header", () => {
    const editor = buildEditor(3, 3);
    applyTableOperation(editor, selection(1, 0), "delete-columns");

    const after = shape(editor);
    expect(after.headerCells).toBe(2);
    expect(after.bodyCells).toEqual([2, 2]);
    expect(after.text[0]).toEqual(["r1c1", "r1c2"]);
  });

  // Tables keep a two-column minimum, the column-wise counterpart of the
  // one-body-row minimum above. Deleting past it re-adds an empty column
  // rather than leaving a single-column table.
  it("keeps two columns rather than collapsing the table", () => {
    const editor = buildEditor(3, 3);
    applyTableOperation(editor, selection(1, 0, 1, 1), "delete-columns");

    const after = shape(editor);
    expect(after.headerCells).toBe(2);
    expect(after.text[0]?.[0]).toBe("r1c2");
    expect(after.text[0]?.[1]).toBe("");
  });
});

describe("applyTableOperation return value", () => {
  it("returns a selection clamped to the resulting table", () => {
    const editor = buildEditor(4, 2);
    const next = applyTableOperation(editor, selection(1, 0, 3, 0), "delete-rows");

    expect(next).not.toBeNull();
    const table = editor.querySelector("table") as HTMLTableElement;
    const rowCount = (table.tHead?.rows.length ?? 0) + (table.tBodies[0]?.rows.length ?? 0);
    expect(next!.end.row).toBeLessThan(rowCount);
    expect(next!.start.row).toBeGreaterThanOrEqual(0);
  });

  it("does nothing and returns null when the table cannot be resolved", () => {
    const editor = buildEditor(3, 2);
    const before = shape(editor);

    const next = applyTableOperation(editor, { ...selection(1, 0), tableId: "missing" }, "delete-rows");

    expect(next).toBeNull();
    expect(shape(editor)).toEqual(before);
  });
});
