import type { TableSelectionState } from "../types";
import {
  clampTableSelectionBounds,
  createNotionTableCell,
  getNotionTableColumnCount,
  getNotionTableRows,
  normalizeNotionBlockElement,
  normalizeTableSelectionBounds
} from "./notionMarkdown";

export const isCellInTableSelection = (selection: TableSelectionState, row: number, col: number): boolean => {
  const bounds = normalizeTableSelectionBounds(selection);
  return row >= bounds.startRow && row <= bounds.endRow && col >= bounds.startCol && col <= bounds.endCol;
};

export function applyTableSelectionVisual(editor: HTMLElement | null, selection: TableSelectionState | null): void {
  if (!editor) return;
  editor.querySelectorAll(".va-notion-table-cell.table-selected").forEach((node) => {
    node.classList.remove("table-selected");
  });
  if (!selection) {
    return;
  }
  const tableBlock = editor.querySelector(
    `[data-md-kind="table"][data-table-id="${selection.tableId}"]`
  ) as HTMLElement | null;
  if (!tableBlock) {
    return;
  }
  const table = tableBlock.querySelector("table");
  if (!(table instanceof HTMLTableElement)) {
    return;
  }
  const rows = getNotionTableRows(table);
  const bounds = clampTableSelectionBounds(
    normalizeTableSelectionBounds(selection),
    rows.length,
    getNotionTableColumnCount(table)
  );
  for (let row = bounds.startRow; row <= bounds.endRow; row += 1) {
    const rowElement = rows[row];
    if (!rowElement) continue;
    for (let col = bounds.startCol; col <= bounds.endCol; col += 1) {
      const cell = rowElement.cells[col];
      if (cell instanceof HTMLTableCellElement) {
        cell.classList.add("table-selected");
      }
    }
  }
}

export const getSelectedTableContext = (editor: HTMLElement | null, selection: TableSelectionState | null) => {
  if (!editor || !selection) {
    return null;
  }
  const block = editor.querySelector(
    `[data-md-kind="table"][data-table-id="${selection.tableId}"]`
  ) as HTMLElement | null;
  if (!block) {
    return null;
  }
  normalizeNotionBlockElement(block);
  const table = block.querySelector("table");
  if (!(table instanceof HTMLTableElement)) {
    return null;
  }
  const rows = getNotionTableRows(table);
  if (rows.length === 0) {
    return null;
  }
  const colCount = getNotionTableColumnCount(table);
  return {
    block,
    table,
    rows,
    colCount,
    selection: {
      ...selection,
      ...{
        start: selection.start,
        end: selection.end
      }
    },
    bounds: clampTableSelectionBounds(normalizeTableSelectionBounds(selection), rows.length, colCount)
  };
};

export function applyTableOperation(
  editor: HTMLElement | null,
  activeSelection: TableSelectionState | null,
  operation:
    | "insert-row-above"
    | "insert-row-below"
    | "insert-column-left"
    | "insert-column-right"
    | "delete-rows"
    | "delete-columns"
): TableSelectionState | null {
  const context = getSelectedTableContext(editor, activeSelection);
  if (!context) {
    return null;
  }
  const { table, rows, colCount, bounds } = context;
  const tbody = table.tBodies[0] ?? table.createTBody();
  const headerRow = table.tHead?.rows[0] ?? table.createTHead().insertRow();
  while (headerRow.cells.length < colCount) {
    headerRow.appendChild(createNotionTableCell("th"));
  }

  let nextSelection: TableSelectionState | null = activeSelection;

  if (operation === "insert-row-above" || operation === "insert-row-below") {
    const bodyInsertIndex =
      operation === "insert-row-above"
        ? Math.max(0, bounds.startRow - 1)
        : Math.max(0, bounds.endRow);
    const row = tbody.insertRow(Math.min(bodyInsertIndex, tbody.rows.length));
    for (let col = 0; col < colCount; col += 1) {
      row.appendChild(createNotionTableCell("td"));
    }
    const fullRowIndex =
      operation === "insert-row-above"
        ? Math.max(1, bounds.startRow)
        : Math.max(1, bounds.endRow + 1);
    nextSelection = {
      tableId: activeSelection!.tableId,
      start: { row: fullRowIndex, col: bounds.startCol },
      end: { row: fullRowIndex, col: bounds.endCol }
    };
  }

  if (operation === "delete-rows") {
    const deleteStart = Math.max(1, bounds.startRow);
    const deleteEnd = Math.max(1, bounds.endRow);
    if (deleteStart <= deleteEnd && tbody.rows.length > 0) {
      const bodyStart = Math.max(0, deleteStart - 1);
      const bodyEnd = Math.min(tbody.rows.length - 1, deleteEnd - 1);
      for (let index = bodyEnd; index >= bodyStart; index -= 1) {
        tbody.deleteRow(index);
      }
    }
    if (tbody.rows.length === 0) {
      const fallback = tbody.insertRow();
      for (let col = 0; col < colCount; col += 1) {
        fallback.appendChild(createNotionTableCell("td"));
      }
    }
    nextSelection = {
      tableId: activeSelection!.tableId,
      start: { row: 1, col: bounds.startCol },
      end: { row: 1, col: bounds.endCol }
    };
  }

  if (operation === "insert-column-left" || operation === "insert-column-right") {
    const insertCol = operation === "insert-column-left" ? bounds.startCol : bounds.endCol + 1;
    const tableRows = getNotionTableRows(table);
    for (let row = 0; row < tableRows.length; row += 1) {
      const rowElement = tableRows[row];
      const isHeader = row === 0;
      const nextCell = createNotionTableCell(isHeader ? "th" : "td");
      const reference = rowElement.cells[insertCol];
      if (reference) {
        rowElement.insertBefore(nextCell, reference);
      } else {
        rowElement.appendChild(nextCell);
      }
    }
    nextSelection = {
      tableId: activeSelection!.tableId,
      start: { row: bounds.startRow, col: insertCol },
      end: { row: bounds.endRow, col: insertCol }
    };
  }

  if (operation === "delete-columns") {
    const tableRows = getNotionTableRows(table);
    const currentColCount = getNotionTableColumnCount(table);
    const deleteCount = bounds.endCol - bounds.startCol + 1;
    if (currentColCount > deleteCount) {
      for (const rowElement of tableRows) {
        for (let col = bounds.endCol; col >= bounds.startCol; col -= 1) {
          if (rowElement.cells[col]) {
            rowElement.deleteCell(col);
          }
        }
      }
    }
    const nextCol = Math.max(0, Math.min(bounds.startCol, getNotionTableColumnCount(table) - 1));
    nextSelection = {
      tableId: activeSelection!.tableId,
      start: { row: bounds.startRow, col: nextCol },
      end: { row: bounds.endRow, col: nextCol }
    };
  }

  const normalizedContext = getSelectedTableContext(editor, nextSelection);
  const correctedSelection = normalizedContext
    ? {
        tableId: nextSelection!.tableId,
        start: { row: normalizedContext.bounds.startRow, col: normalizedContext.bounds.startCol },
        end: { row: normalizedContext.bounds.endRow, col: normalizedContext.bounds.endCol }
      }
    : nextSelection;
  return correctedSelection;
}
