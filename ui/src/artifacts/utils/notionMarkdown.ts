import type { ParsedMarkdownTable, TableSelectionBounds, TableSelectionState } from "../types";

/** Convert leading `-- ` / `--- ` bullet syntax to standard indented Markdown list syntax. */
export function preprocessMarkdownBullets(md: string): string {
  return md
    .split("\n")
    .map((line) => {
      if (/^--- /.test(line)) return "    - " + line.slice(4);
      if (/^-- /.test(line)) return "  - " + line.slice(3);
      return line;
    })
    .join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function markdownInlineToHtml(value: string): string {
  const escaped = escapeHtml(value);
  return escaped
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");
}

function parseMarkdownTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) {
    return null;
  }
  const withoutEdges = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = withoutEdges.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
  return cells.length > 0 ? cells : null;
}

function isMarkdownTableSeparatorRow(line: string): boolean {
  const cells = parseMarkdownTableRow(line);
  if (!cells || cells.length < 2) {
    return false;
  }
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function padMarkdownTableRow(cells: string[], columnCount: number): string[] {
  if (cells.length >= columnCount) {
    return cells.slice(0, columnCount);
  }
  return [...cells, ...Array.from({ length: columnCount - cells.length }, () => "")];
}

function tryParseMarkdownTable(lines: string[], startIndex: number): ParsedMarkdownTable | null {
  if (startIndex + 1 >= lines.length) {
    return null;
  }
  const header = parseMarkdownTableRow(lines[startIndex]);
  if (!header || header.length < 2) {
    return null;
  }
  if (!isMarkdownTableSeparatorRow(lines[startIndex + 1])) {
    return null;
  }

  const separatorCells = parseMarkdownTableRow(lines[startIndex + 1]) ?? [];
  const columnCount = Math.max(2, header.length, separatorCells.length);
  const rows: string[][] = [];
  let cursor = startIndex + 2;
  while (cursor < lines.length) {
    const rowLine = lines[cursor];
    if (!rowLine.trim()) {
      break;
    }
    const rowCells = parseMarkdownTableRow(rowLine);
    if (!rowCells || rowCells.length < 2) {
      break;
    }
    rows.push(padMarkdownTableRow(rowCells, columnCount));
    cursor += 1;
  }

  return {
    header: padMarkdownTableRow(header, columnCount),
    rows,
    nextIndex: cursor
  };
}

export function createNotionTableCell(tagName: "th" | "td", value = ""): HTMLTableCellElement {
  const cell = document.createElement(tagName);
  cell.className = "va-notion-table-cell";
  cell.innerHTML = value ? markdownInlineToHtml(value) : "<br>";
  return cell;
}

export function getNotionTableRows(table: HTMLTableElement): HTMLTableRowElement[] {
  const headerRows = table.tHead ? Array.from(table.tHead.rows) : [];
  const bodyRows = table.tBodies.length > 0 ? Array.from(table.tBodies[0].rows) : [];
  return [...headerRows, ...bodyRows];
}

export function getNotionTableColumnCount(table: HTMLTableElement): number {
  const rows = getNotionTableRows(table);
  return Math.max(1, ...rows.map((row) => row.cells.length));
}

export function ensureNotionTableBlockStructure(block: HTMLElement): void {
  let table = block.querySelector("table") as HTMLTableElement | null;
  if (!table) {
    table = document.createElement("table");
    table.className = "va-notion-table";
    block.innerHTML = "";
    block.appendChild(table);
  } else {
    table.classList.add("va-notion-table");
  }

  const thead = table.tHead ?? table.createTHead();
  let headerRow = thead.rows[0];
  if (!headerRow) {
    headerRow = thead.insertRow();
    headerRow.appendChild(createNotionTableCell("th"));
    headerRow.appendChild(createNotionTableCell("th"));
  }

  const tbody = table.tBodies[0] ?? table.createTBody();
  let columnCount = Math.max(1, headerRow.cells.length);
  if (columnCount < 2) {
    headerRow.appendChild(createNotionTableCell("th"));
    columnCount = 2;
  }

  while (headerRow.cells.length < columnCount) {
    headerRow.appendChild(createNotionTableCell("th"));
  }
  while (headerRow.cells.length > columnCount) {
    headerRow.deleteCell(headerRow.cells.length - 1);
  }
  Array.from(headerRow.cells).forEach((cell) => {
    if (cell instanceof HTMLTableCellElement) {
      cell.classList.add("va-notion-table-cell");
    }
  });

  if (tbody.rows.length === 0) {
    const row = tbody.insertRow();
    for (let i = 0; i < columnCount; i += 1) {
      row.appendChild(createNotionTableCell("td"));
    }
  }

  for (const row of Array.from(tbody.rows)) {
    while (row.cells.length < columnCount) {
      row.appendChild(createNotionTableCell("td"));
    }
    while (row.cells.length > columnCount) {
      row.deleteCell(row.cells.length - 1);
    }
    Array.from(row.cells).forEach((cell) => {
      if (cell instanceof HTMLTableCellElement) {
        cell.classList.add("va-notion-table-cell");
      }
    });
  }
}

function tableCellToMarkdown(cell: HTMLTableCellElement): string {
  const inline = Array.from(cell.childNodes).map((node) => inlineNodeToMarkdown(node)).join("");
  return inline
    .replace(/\n+/g, "<br>")
    .replace(/\|/g, "\\|")
    .trim();
}

function tableBlockToMarkdown(block: HTMLElement): string {
  ensureNotionTableBlockStructure(block);
  const table = block.querySelector("table") as HTMLTableElement | null;
  if (!table) {
    return "|  |  |\n| --- | --- |\n|  |  |";
  }

  const rows = getNotionTableRows(table);
  if (rows.length === 0) {
    return "|  |  |\n| --- | --- |\n|  |  |";
  }

  const columnCount = getNotionTableColumnCount(table);
  const headerRow = rows[0];
  const bodyRows = rows.slice(1);
  const header = Array.from({ length: columnCount }, (_, index) => {
    const cell = headerRow.cells[index] as HTMLTableCellElement | undefined;
    return cell ? tableCellToMarkdown(cell) : "";
  });
  const separator = Array.from({ length: columnCount }, () => "---");
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${separator.join(" | ")} |`
  ];

  for (const row of bodyRows) {
    const rowCells = Array.from({ length: columnCount }, (_, index) => {
      const cell = row.cells[index] as HTMLTableCellElement | undefined;
      return cell ? tableCellToMarkdown(cell) : "";
    });
    lines.push(`| ${rowCells.join(" | ")} |`);
  }

  return lines.join("\n");
}

export function normalizeTableSelectionBounds(selection: TableSelectionState): TableSelectionBounds {
  return {
    startRow: Math.min(selection.start.row, selection.end.row),
    endRow: Math.max(selection.start.row, selection.end.row),
    startCol: Math.min(selection.start.col, selection.end.col),
    endCol: Math.max(selection.start.col, selection.end.col)
  };
}

export function clampTableSelectionBounds(bounds: TableSelectionBounds, rowCount: number, colCount: number): TableSelectionBounds {
  const maxRow = Math.max(0, rowCount - 1);
  const maxCol = Math.max(0, colCount - 1);
  return {
    startRow: Math.max(0, Math.min(bounds.startRow, maxRow)),
    endRow: Math.max(0, Math.min(bounds.endRow, maxRow)),
    startCol: Math.max(0, Math.min(bounds.startCol, maxCol)),
    endCol: Math.max(0, Math.min(bounds.endCol, maxCol))
  };
}

export function markdownToNotionHtml(markdown: string): string {
  const lines = markdown.split("\n");
  const blocks: string[] = [];
  let tableIndex = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const table = tryParseMarkdownTable(lines, i);
    if (table) {
      const tableId = `table-${tableIndex + 1}`;
      tableIndex += 1;
      const headerHtml = table.header
        .map((cell) => `<th class="va-notion-table-cell">${cell ? markdownInlineToHtml(cell) : "<br>"}</th>`)
        .join("");
      const bodyHtml = table.rows
        .map(
          (row) =>
            `<tr>${row
              .map((cell) => `<td class="va-notion-table-cell">${cell ? markdownInlineToHtml(cell) : "<br>"}</td>`)
              .join("")}</tr>`
        )
        .join("");
      const ensuredBodyHtml =
        bodyHtml ||
        `<tr>${table.header.map(() => `<td class="va-notion-table-cell"><br></td>`).join("")}</tr>`;
      blocks.push(
        `<div class="va-notion-block va-notion-table-wrap" data-md-kind="table" data-table-id="${tableId}"><table class="va-notion-table"><thead><tr>${headerHtml}</tr></thead><tbody>${ensuredBodyHtml}</tbody></table></div>`
      );
      i = table.nextIndex - 1;
      continue;
    }

    const line = lines[i];
    const headingMatch = line.match(/^(#{1,3})\s?(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = headingMatch[2] ? markdownInlineToHtml(headingMatch[2]) : "<br>";
      blocks.push(`<p class="va-notion-block va-notion-heading level-${level}" data-md-kind="heading" data-md-level="${level}">${content}</p>`);
      continue;
    }
    const bulletMatch = line.match(/^(-{1,3})\s?(.*)$/);
    if (bulletMatch) {
      const level = bulletMatch[1].length;
      const content = bulletMatch[2] ? markdownInlineToHtml(bulletMatch[2]) : "<br>";
      blocks.push(`<p class="va-notion-block va-notion-bullet level-${level}" data-md-kind="bullet" data-md-level="${level}">${content}</p>`);
      continue;
    }
    const content = line ? markdownInlineToHtml(line) : "<br>";
    blocks.push(`<p class="va-notion-block" data-md-kind="paragraph">${content}</p>`);
  }

  return blocks.join("");
}

function inlineNodeToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.nodeValue ?? "").replaceAll("\u00a0", " ");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  const element = node as HTMLElement;
  if (element.tagName === "BR") {
    return "\n";
  }

  const inner = Array.from(element.childNodes).map((child) => inlineNodeToMarkdown(child)).join("");
  if (element.tagName === "STRONG" || element.tagName === "B") {
    return `**${inner}**`;
  }
  if (element.tagName === "DEL" || element.tagName === "S" || element.tagName === "STRIKE") {
    return `~~${inner}~~`;
  }
  if (element.tagName === "A") {
    const href = element.getAttribute("href")?.trim() ?? "";
    if (!href) {
      return inner;
    }
    const label = inner || href;
    return `[${label}](${href})`;
  }
  return inner;
}

export function notionEditorToMarkdown(editor: HTMLElement): string {
  const parts: string[] = [];
  const blocks = Array.from(editor.children) as HTMLElement[];
  for (const block of blocks) {
    const kind = block.dataset.mdKind === "table"
      ? "table"
      : block.dataset.mdKind === "bullet"
      ? "bullet"
      : block.dataset.mdKind === "heading"
        ? "heading"
        : "paragraph";
    if (kind === "table") {
      parts.push(tableBlockToMarkdown(block));
      continue;
    }
    const levelRaw = Number(block.dataset.mdLevel || "1");
    const level = Number.isFinite(levelRaw) ? Math.max(1, Math.min(3, Math.floor(levelRaw))) : 1;
    const inline = Array.from(block.childNodes).map((node) => inlineNodeToMarkdown(node)).join("");
    const content = inline.replace(/\n+$/g, "");
    if (kind === "bullet") {
      parts.push(`${"-".repeat(level)} ${content}`.trimEnd());
    } else if (kind === "heading") {
      parts.push(`${"#".repeat(level)} ${content}`.trimEnd());
    } else {
      parts.push(content);
    }
  }
  return parts.join("\n");
}

export function normalizeNotionBlockElement(block: HTMLElement): void {
  const kind = block.dataset.mdKind === "table" || block.classList.contains("va-notion-table-wrap")
    ? "table"
    : block.dataset.mdKind === "bullet"
    ? "bullet"
    : block.dataset.mdKind === "heading"
      ? "heading"
      : "paragraph";
  const levelRaw = Number(block.dataset.mdLevel || "1");
  const level = Number.isFinite(levelRaw) ? Math.max(1, Math.min(3, Math.floor(levelRaw))) : 1;
  block.dataset.mdKind = kind;
  if (kind === "table") {
    delete block.dataset.mdLevel;
    if (!block.dataset.tableId) {
      block.dataset.tableId = `table-${Math.floor(Math.random() * 1_000_000_000)}`;
    }
    block.className = "va-notion-block va-notion-table-wrap";
    ensureNotionTableBlockStructure(block);
    return;
  }
  block.className = "va-notion-block";
  if (kind === "bullet") {
    block.dataset.mdLevel = String(level);
    block.classList.add("va-notion-bullet", `level-${level}`);
  } else if (kind === "heading") {
    block.dataset.mdLevel = String(level);
    block.classList.add("va-notion-heading", `level-${level}`);
  } else {
    delete block.dataset.mdLevel;
  }
}

export function createNotionBlock(kind: "paragraph" | "bullet" | "heading", level = 1): HTMLParagraphElement {
  const block = document.createElement("p");
  block.dataset.mdKind = kind;
  if (kind === "bullet" || kind === "heading") {
    block.dataset.mdLevel = String(Math.max(1, Math.min(3, Math.floor(level))));
  }
  block.innerHTML = "<br>";
  normalizeNotionBlockElement(block);
  return block;
}

export function findNotionBlock(root: HTMLElement, target: Node | null): HTMLElement | null {
  let node: Node | null = target;
  while (node && node !== root) {
    if (node instanceof HTMLElement && node.dataset.mdKind) {
      return node;
    }
    node = node.parentNode;
  }
  return null;
}

export function placeCaretAtBlockStart(block: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.setStart(block, 0);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function hasMeaningfulBlockContent(block: HTMLElement): boolean {
  if (block.dataset.mdKind === "table") {
    return true;
  }
  return (block.textContent ?? "").replace(/\u200b/g, "").trim().length > 0;
}
