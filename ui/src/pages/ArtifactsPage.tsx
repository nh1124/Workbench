import { createContext, useContext, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link, useSearchParams } from "react-router-dom";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { TextInputDialog } from "../components/TextInputDialog";
import { artifactsApi, projectsApi } from "../lib/api";
import { formatDateTime, normalizeProjectName } from "../lib/format";
import type { ArtifactItem, ArtifactItemKind, ProjectRecord } from "../types/models";
import "./ArtifactsPage.css";

interface ArtifactEditorDraft {
  id?: string;
  kind: ArtifactItemKind;
  title: string;
  path: string;
  projectId: string;
  projectName: string;
  tags: string[];
  contentMarkdown: string;
  mimeType?: string;
  sizeBytes?: number;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
}

interface ProjectOption {
  projectId: string;
  projectName?: string;
}

interface TreeFolderNode {
  name: string;
  path: string;
  folderItem?: ArtifactItem;
  folders: Map<string, TreeFolderNode>;
  items: ArtifactItem[];
}

type TreeContextTarget =
  | { type: "background"; folderPath: string }
  | { type: "folder"; folderPath: string }
  | { type: "item"; item: ArtifactItem };

interface TreeContextMenuState {
  x: number;
  y: number;
  target: TreeContextTarget;
}

interface DeleteConfirmState {
  ids: string[];
  count: number;
  title?: string;
}

interface CreateFolderState {
  baseFolderPath: string;
}

interface ParsedMarkdownTable {
  header: string[];
  rows: string[][];
  nextIndex: number;
}

interface TableCellPosition {
  row: number;
  col: number;
}

interface TableSelectionState {
  tableId: string;
  start: TableCellPosition;
  end: TableCellPosition;
}

interface TableSelectionBounds {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

interface TableContextMenuState {
  x: number;
  y: number;
  selection: TableSelectionState;
}

const defaultDraft: ArtifactEditorDraft = {
  kind: "note",
  title: "",
  path: "",
  projectId: "",
  projectName: "",
  tags: [],
  contentMarkdown: ""
};

function normalizePath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join("/");
}

function parentPath(itemPath: string): string {
  const normalized = normalizePath(itemPath);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : "";
}

function leafPath(itemPath: string): string {
  const normalized = normalizePath(itemPath);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function joinPath(basePath: string, leaf: string): string {
  const base = normalizePath(basePath);
  const cleanLeaf = normalizePath(leaf);
  if (!base) return cleanLeaf;
  if (!cleanLeaf) return base;
  return `${base}/${cleanLeaf}`;
}

function formatSize(value?: number): string {
  if (!value || value <= 0) return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function isPdf(item: ArtifactEditorDraft): boolean {
  const mime = (item.mimeType ?? "").toLowerCase();
  if (mime.includes("pdf")) return true;
  return /\.pdf$/i.test(item.path);
}

function isImage(item: ArtifactEditorDraft): boolean {
  const mime = (item.mimeType ?? "").toLowerCase();
  if (mime.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico|tiff?)$/i.test(item.path);
}

function isMarkdownFilePath(itemPath: string): boolean {
  return /\.(md|markdown)$/i.test(itemPath.trim());
}

function extractYoutubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("?")[0];
    if (u.hostname === "youtube.com" || u.hostname === "www.youtube.com") {
      const v = u.searchParams.get("v");
      if (v) return v;
      const m = u.pathname.match(/\/(?:embed|shorts|v)\/([^/?&]+)/);
      if (m) return m[1];
    }
  } catch {
    // ignore invalid URLs
  }
  return null;
}

function isExternalUrl(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

function resolveMarkdownRef(markdownFilePath: string, href: string): string {
  if (!href) return href;
  if (href.startsWith("/")) return normalizePath(href.slice(1));
  const dir = parentPath(markdownFilePath);
  return normalizePath(joinPath(dir, href));
}

function relativeArtifactPath(fromFilePath: string, toFilePath: string): string {
  const fromDir = normalizePath(parentPath(fromFilePath));
  const to = normalizePath(toFilePath);
  if (fromDir && to.startsWith(fromDir + "/")) return to.slice(fromDir.length + 1);
  return to;
}

/** Convert leading `-- ` / `--- ` bullet syntax to standard indented Markdown list syntax. */
function preprocessMarkdownBullets(md: string): string {
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
  return escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
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

function createNotionTableCell(tagName: "th" | "td", value = ""): HTMLTableCellElement {
  const cell = document.createElement(tagName);
  cell.className = "va-notion-table-cell";
  cell.innerHTML = value ? markdownInlineToHtml(value) : "<br>";
  return cell;
}

function getNotionTableRows(table: HTMLTableElement): HTMLTableRowElement[] {
  const headerRows = table.tHead ? Array.from(table.tHead.rows) : [];
  const bodyRows = table.tBodies.length > 0 ? Array.from(table.tBodies[0].rows) : [];
  return [...headerRows, ...bodyRows];
}

function getNotionTableColumnCount(table: HTMLTableElement): number {
  const rows = getNotionTableRows(table);
  return Math.max(1, ...rows.map((row) => row.cells.length));
}

function ensureNotionTableBlockStructure(block: HTMLElement): void {
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

function normalizeTableSelectionBounds(selection: TableSelectionState): TableSelectionBounds {
  return {
    startRow: Math.min(selection.start.row, selection.end.row),
    endRow: Math.max(selection.start.row, selection.end.row),
    startCol: Math.min(selection.start.col, selection.end.col),
    endCol: Math.max(selection.start.col, selection.end.col)
  };
}

function clampTableSelectionBounds(bounds: TableSelectionBounds, rowCount: number, colCount: number): TableSelectionBounds {
  const maxRow = Math.max(0, rowCount - 1);
  const maxCol = Math.max(0, colCount - 1);
  return {
    startRow: Math.max(0, Math.min(bounds.startRow, maxRow)),
    endRow: Math.max(0, Math.min(bounds.endRow, maxRow)),
    startCol: Math.max(0, Math.min(bounds.startCol, maxCol)),
    endCol: Math.max(0, Math.min(bounds.endCol, maxCol))
  };
}

function markdownToNotionHtml(markdown: string): string {
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
  return inner;
}

function notionEditorToMarkdown(editor: HTMLElement): string {
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

function normalizeNotionBlockElement(block: HTMLElement): void {
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

function createNotionBlock(kind: "paragraph" | "bullet" | "heading", level = 1): HTMLParagraphElement {
  const block = document.createElement("p");
  block.dataset.mdKind = kind;
  if (kind === "bullet" || kind === "heading") {
    block.dataset.mdLevel = String(Math.max(1, Math.min(3, Math.floor(level))));
  }
  block.innerHTML = "<br>";
  normalizeNotionBlockElement(block);
  return block;
}

function findNotionBlock(root: HTMLElement, target: Node | null): HTMLElement | null {
  let node: Node | null = target;
  while (node && node !== root) {
    if (node instanceof HTMLElement && node.dataset.mdKind) {
      return node;
    }
    node = node.parentNode;
  }
  return null;
}

function placeCaretAtBlockStart(block: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.setStart(block, 0);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

interface EditorTextTransformResult {
  nextText: string;
  nextSelectionStart: number;
  nextSelectionEnd: number;
}

function transformLineLevel(line: string, delta: 1 | -1): string {
  const matched = line.match(/^(\s*)(-+)\s*(.*)$/);
  if (delta === 1) {
    if (matched) {
      const level = Math.min(matched[2].length + 1, 3);
      const rest = matched[3];
      return `${matched[1]}${"-".repeat(level)}${rest ? ` ${rest}` : " "}`;
    }
    const indent = (line.match(/^(\s*)/)?.[1] ?? "");
    const rest = line.trimStart();
    return `${indent}-${rest ? ` ${rest}` : " "}`;
  }

  if (!matched) {
    return line;
  }
  const currentLevel = matched[2].length;
  const nextLevel = Math.max(0, currentLevel - 1);
  const rest = matched[3];
  if (nextLevel === 0) {
    return `${matched[1]}${rest}`;
  }
  return `${matched[1]}${"-".repeat(nextLevel)}${rest ? ` ${rest}` : " "}`;
}

function transformSelectedLinesLevel(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  delta: 1 | -1
): EditorTextTransformResult | null {
  const lineStart = text.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1;
  const lineEndRaw = text.indexOf("\n", selectionEnd);
  const lineEnd = lineEndRaw >= 0 ? lineEndRaw : text.length;
  const currentBlock = text.slice(lineStart, lineEnd);
  const transformedBlock = currentBlock
    .split("\n")
    .map((line) => transformLineLevel(line, delta))
    .join("\n");

  if (transformedBlock === currentBlock) {
    return null;
  }

  const nextText = `${text.slice(0, lineStart)}${transformedBlock}${text.slice(lineEnd)}`;
  if (selectionStart === selectionEnd) {
    const deltaLen = transformedBlock.length - currentBlock.length;
    const nextPos = Math.max(lineStart, selectionStart + deltaLen);
    return {
      nextText,
      nextSelectionStart: nextPos,
      nextSelectionEnd: nextPos
    };
  }

  return {
    nextText,
    nextSelectionStart: lineStart,
    nextSelectionEnd: lineStart + transformedBlock.length
  };
}

function transformBoldAtSelection(
  text: string,
  selectionStart: number,
  selectionEnd: number
): EditorTextTransformResult {
  if (selectionStart === selectionEnd) {
    const nextText = `${text.slice(0, selectionStart)}****${text.slice(selectionEnd)}`;
    const nextPos = selectionStart + 2;
    return {
      nextText,
      nextSelectionStart: nextPos,
      nextSelectionEnd: nextPos
    };
  }

  const selected = text.slice(selectionStart, selectionEnd);
  if (selected.startsWith("**") && selected.endsWith("**") && selected.length >= 4) {
    const unwrapped = selected.slice(2, -2);
    const nextText = `${text.slice(0, selectionStart)}${unwrapped}${text.slice(selectionEnd)}`;
    const nextEnd = selectionStart + unwrapped.length;
    return {
      nextText,
      nextSelectionStart: selectionStart,
      nextSelectionEnd: nextEnd
    };
  }

  const hasOuterBold = selectionStart >= 2 && text.slice(selectionStart - 2, selectionStart) === "**"
    && text.slice(selectionEnd, selectionEnd + 2) === "**";
  if (hasOuterBold) {
    const nextText = `${text.slice(0, selectionStart - 2)}${selected}${text.slice(selectionEnd + 2)}`;
    return {
      nextText,
      nextSelectionStart: selectionStart - 2,
      nextSelectionEnd: selectionEnd - 2
    };
  }

  const nextText = `${text.slice(0, selectionStart)}**${selected}**${text.slice(selectionEnd)}`;
  return {
    nextText,
    nextSelectionStart: selectionStart + 2,
    nextSelectionEnd: selectionEnd + 2
  };
}

function transformEnterWithLevelContinuation(
  text: string,
  selectionStart: number,
  selectionEnd: number
): EditorTextTransformResult | null {
  if (selectionStart !== selectionEnd) {
    return null;
  }
  const lineStart = text.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1;
  const currentLine = text.slice(lineStart, selectionStart);
  const matched = currentLine.match(/^(\s*-{1,3})(?:\s+.*)?$/);
  if (!matched) {
    return null;
  }
  const insert = `\n${matched[1]} `;
  const nextText = `${text.slice(0, selectionStart)}${insert}${text.slice(selectionEnd)}`;
  const nextPos = selectionStart + insert.length;
  return {
    nextText,
    nextSelectionStart: nextPos,
    nextSelectionEnd: nextPos
  };
}

function itemToDraft(item: ArtifactItem): ArtifactEditorDraft {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    path: item.path,
    projectId: item.projectId,
    projectName: item.projectName ?? "",
    tags: [...item.tags],
    contentMarkdown: item.contentMarkdown ?? "",
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    version: item.version,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

function buildTree(items: ArtifactItem[]): TreeFolderNode {
  const root: TreeFolderNode = {
    name: "",
    path: "",
    folders: new Map<string, TreeFolderNode>(),
    items: []
  };

  const ensureFolder = (folderPath: string): TreeFolderNode => {
    const normalized = normalizePath(folderPath);
    if (!normalized) return root;

    const segments = normalized.split("/");
    let cursor = root;
    let cursorPath = "";

    for (const segment of segments) {
      cursorPath = cursorPath ? `${cursorPath}/${segment}` : segment;
      let child = cursor.folders.get(segment);
      if (!child) {
        child = {
          name: segment,
          path: cursorPath,
          folders: new Map<string, TreeFolderNode>(),
          items: []
        };
        cursor.folders.set(segment, child);
      }
      cursor = child;
    }

    return cursor;
  };

  for (const item of items) {
    const pathValue = normalizePath(item.path);
    if (!pathValue) continue;

    if (item.kind === "folder") {
      const folderNode = ensureFolder(pathValue);
      folderNode.folderItem = item;
      continue;
    }

    const parent = ensureFolder(parentPath(pathValue));
    parent.items.push(item);
  }

  return root;
}

function sortItems(items: ArtifactItem[]): ArtifactItem[] {
  return [...items].sort((a, b) => {
    if (a.kind !== b.kind) {
      if (a.kind === "note") return -1;
      if (b.kind === "note") return 1;
    }
    return a.path.localeCompare(b.path, undefined, { sensitivity: "base" });
  });
}

function uniqueProjectOptions(records: ProjectRecord[], pinned?: ProjectOption | null): ProjectOption[] {
  const map = new Map<string, ProjectOption>();
  if (pinned?.projectId) {
    map.set(pinned.projectId, pinned);
  }
  for (const record of records) {
    map.set(record.id, { projectId: record.id, projectName: record.name });
  }
  return [...map.values()].sort((a, b) => (a.projectName || a.projectId).localeCompare(b.projectName || b.projectId));
}

function collectVisibleSelectableItemIds(root: TreeFolderNode, collapsedFolders: Record<string, true>): string[] {
  const result: string[] = [];

  const visit = (folder: TreeFolderNode) => {
    const sortedFolders = [...folder.folders.values()].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    );
    const sortedItems = sortItems(folder.items);

    for (const childFolder of sortedFolders) {
      if (childFolder.folderItem) {
        result.push(childFolder.folderItem.id);
      }
      if (!collapsedFolders[childFolder.path]) {
        visit(childFolder);
      }
    }

    for (const item of sortedItems) {
      result.push(item.id);
    }
  };

  visit(root);
  return result;
}

const IcoHome = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M3 11l9-8 9 8" />
    <path d="M5 10v10h14V10" />
  </svg>
);

const IcoFolder = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);

const IcoFile = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
    <path d="M14 3v6h6" />
  </svg>
);

const IcoUpload = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M12 16V4" />
    <path d="M7 9l5-5 5 5" />
    <path d="M4 20h16" />
  </svg>
);

const IcoDownload = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M12 4v12" />
    <path d="M7 11l5 5 5-5" />
    <path d="M4 20h16" />
  </svg>
);

const IcoTrash = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
    <path d="M9 6V4h6v2" />
  </svg>
);

const IcoClose = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
);

const IcoFloppy = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
    <polyline points="17 21 17 13 7 13 7 21" />
    <polyline points="7 3 7 8 15 8" />
  </svg>
);

const IcoExpand = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
  </svg>
);

const IcoCompress = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M4 14h6v6M14 4h6v6M10 20l-7-7M20 10l-7 7" />
  </svg>
);


interface MarkdownRendererCtx {
  items: ArtifactItem[];
  currentPath: string;
  selectItem: (item: ArtifactItem) => void;
}

const MarkdownRendererContext = createContext<MarkdownRendererCtx | null>(null);

function resolveArtifactSrc(src: string, currentPath: string): string {
  // Leading `/` → absolute artifact path (strip slash)
  if (src.startsWith("/")) return normalizePath(src.slice(1));
  // Otherwise: relative to the markdown file's directory
  return resolveMarkdownRef(currentPath, src);
}

function MarkdownImageComponent({ src, alt }: { src?: string; alt?: string }) {
  // All hooks must be called unconditionally (Rules of Hooks)
  const ctx = useContext(MarkdownRendererContext);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const youtubeId = src ? extractYoutubeId(src) : null;
  const isExternal = isExternalUrl(src ?? "");

  useEffect(() => {
    if (youtubeId || !src || !ctx || isExternal) return;

    const artifactPath = resolveArtifactSrc(src, ctx.currentPath);
    const item = ctx.items.find((i) => normalizePath(i.path) === artifactPath);
    if (!item) return;

    let cancelled = false;
    let url: string | null = null;
    void artifactsApi.downloadFile(item.id).then((blob) => {
      if (cancelled) return;
      url = URL.createObjectURL(blob);
      setBlobUrl(url);
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [src, ctx, youtubeId, isExternal]);

  // YouTube URL in img syntax → embed as video player
  if (youtubeId) {
    return (
      <span className="va-md-embed-block">
        <iframe
          className="va-md-youtube"
          src={`https://www.youtube-nocookie.com/embed/${youtubeId}`}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          title={alt || "YouTube video"}
        />
      </span>
    );
  }

  const displaySrc = isExternal ? src : blobUrl;
  if (!displaySrc) return <span className="va-md-img-loading">[{alt ?? src}]</span>;
  if (/\.pdf$/i.test(src ?? "")) {
    return <iframe src={displaySrc} className="va-md-pdf-embed" title={alt ?? "PDF"} />;
  }
  return <img src={displaySrc} alt={alt} className="va-md-img" />;
}

function MarkdownLinkComponent({ href, children }: { href?: string; children?: ReactNode }) {
  const ctx = useContext(MarkdownRendererContext);
  if (!href) return <>{children}</>;

  const youtubeId = extractYoutubeId(href);
  if (youtubeId) {
    return (
      <span className="va-md-embed-block">
        <iframe
          className="va-md-youtube"
          src={`https://www.youtube-nocookie.com/embed/${youtubeId}`}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          title="YouTube video"
        />
      </span>
    );
  }

  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

const MARKDOWN_COMPONENTS = {
  img: MarkdownImageComponent,
  a: MarkdownLinkComponent,
};

export function ArtifactsPage() {
  const ROOT_DROP_PATH = "";
  const [searchParams] = useSearchParams();
  const requestedItemId = searchParams.get("item");
  const [projectOptions, setProjectOptions] = useState<ProjectOption[]>([]);
  const [defaultProject, setDefaultProject] = useState<ProjectOption | null>(null);
  const [projectFilter, setProjectFilter] = useState("");
  const [items, setItems] = useState<ArtifactItem[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, true>>({});
  const [draft, setDraft] = useState<ArtifactEditorDraft>(defaultDraft);
  const [mode, setMode] = useState<"view" | "create-note">("view");
  const [tagInput, setTagInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [notePreviewMode, setNotePreviewMode] = useState<"edit" | "preview" | "live">("edit");
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null);
  const [imageBlobUrl, setImageBlobUrl] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<TreeContextMenuState | null>(null);
  const [tableContextMenu, setTableContextMenu] = useState<TableContextMenuState | null>(null);
  const [tableSelection, setTableSelection] = useState<TableSelectionState | null>(null);
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState | null>(null);
  const [createFolderState, setCreateFolderState] = useState<CreateFolderState | null>(null);
  const [editorExpanded, setEditorExpanded] = useState(false);
  const [mobileTreeVisible, setMobileTreeVisible] = useState(false);

  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const notionEditorRef = useRef<HTMLDivElement | null>(null);
  const draggingItemRef = useRef<ArtifactItem | null>(null);
  const tableSelectionDragRef = useRef<TableSelectionState | null>(null);
  const handleSaveRef = useRef<() => Promise<void>>(async () => {});
  const shortcutStateRef = useRef({ canSave: false, isSaving: false, markdownEditorVisible: false });
  const notionSyncRef = useRef<{ itemId?: string; markdown: string }>({ itemId: undefined, markdown: "" });

  const treeRoot = useMemo(() => buildTree(items), [items]);
  const visibleSelectableItemIds = useMemo(
    () => collectVisibleSelectableItemIds(treeRoot, collapsedFolders),
    [treeRoot, collapsedFolders]
  );
  const selectedItemIdSet = useMemo(() => new Set(selectedItemIds), [selectedItemIds]);

  const currentFolderPath = useMemo(() => {
    if (selectedFolderPath !== null) return selectedFolderPath;
    if (mode === "create-note") return parentPath(draft.path);
    if (draft.id) return parentPath(draft.path);
    return "";
  }, [draft.id, draft.path, mode, selectedFolderPath]);

  const currentFolderNode = useMemo(() => {
    let cursor = treeRoot;
    if (currentFolderPath) {
      const segments = currentFolderPath.split("/").filter(Boolean);
      for (const segment of segments) {
        const child = cursor.folders.get(segment);
        if (!child) return cursor;
        cursor = child;
      }
    }
    return cursor;
  }, [treeRoot, currentFolderPath]);

  const selectedItemSummary = useMemo(
    () => items.find((item) => item.id === selectedItemId) ?? null,
    [items, selectedItemId]
  );
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const draggingItem = useMemo(
    () => (draggingItemId ? items.find((item) => item.id === draggingItemId) ?? null : null),
    [draggingItemId, items]
  );

  const markdownEditorVisible = useMemo(() => {
    if (mode === "create-note") return true;
    if (draft.kind === "note") return true;
    return draft.kind === "file" && isMarkdownFilePath(draft.path);
  }, [draft.kind, draft.path, mode]);

  const canSave = useMemo(() => {
    if (!draft.title.trim()) return false;
    if (!draft.path.trim()) return false;
    return true;
  }, [draft.path, draft.title]);

  const hasDetailSelection = Boolean(selectedItemId || mode === "create-note");

  const contextMenuPosition = useMemo(() => {
    if (!contextMenu) return null;
    const menuWidth = 180;
    const menuHeight = 180;
    const margin = 8;
    const maxX = window.innerWidth - menuWidth - margin;
    const maxY = window.innerHeight - menuHeight - margin;
    return {
      left: Math.max(margin, Math.min(contextMenu.x, maxX)),
      top: Math.max(margin, Math.min(contextMenu.y, maxY))
    };
  }, [contextMenu]);

  const tableContextMenuPosition = useMemo(() => {
    if (!tableContextMenu) return null;
    const menuWidth = 220;
    const menuHeight = 220;
    const margin = 8;
    const maxX = window.innerWidth - menuWidth - margin;
    const maxY = window.innerHeight - menuHeight - margin;
    return {
      left: Math.max(margin, Math.min(tableContextMenu.x, maxX)),
      top: Math.max(margin, Math.min(tableContextMenu.y, maxY))
    };
  }, [tableContextMenu]);

  const contextDeleteCandidateIds = useMemo(() => {
    if (!contextMenu) {
      return [];
    }
    const target = contextMenu.target;
    if (selectedItemIds.length > 0) {
      return selectedItemIds;
    }
    if (target.type === "item") {
      return [target.item.id];
    }
    if (target.type === "folder") {
      const folder = items.find(
        (item) => item.kind === "folder" && normalizePath(item.path) === normalizePath(target.folderPath)
      );
      return folder ? [folder.id] : [];
    }
    return [];
  }, [contextMenu, items, selectedItemIds]);

  const resolveProjectFromFilter = (): ProjectOption => {
    if (projectFilter.trim()) {
      const found = projectOptions.find((project) => project.projectId === projectFilter.trim());
      return found ?? { projectId: projectFilter.trim() };
    }

    if (defaultProject) {
      return defaultProject;
    }

    if (projectOptions.length > 0) return projectOptions[0];
    return { projectId: "default", projectName: "default" };
  };

  const resolveProjectFromDraft = (): ProjectOption => {
    if (draft.projectId.trim()) {
      const found = projectOptions.find((project) => project.projectId === draft.projectId.trim());
      return found ?? { projectId: draft.projectId.trim(), projectName: draft.projectName.trim() || undefined };
    }

    return resolveProjectFromFilter();
  };

  const loadProjects = async () => {
    const defaultSelection = await projectsApi.getDefault().catch(() => null);
    const resolvedDefault: ProjectOption | null = defaultSelection
      ? { projectId: defaultSelection.project.id, projectName: defaultSelection.project.name }
      : null;
    setDefaultProject(resolvedDefault);

    try {
      const all: ProjectRecord[] = [];
      let cursor: string | undefined;

      for (let page = 0; page < 20; page += 1) {
        const result = await projectsApi.list(undefined, undefined, 100, cursor);
        all.push(...result.items);
        if (!result.nextCursor) {
          break;
        }
        cursor = result.nextCursor;
      }

      setProjectOptions(uniqueProjectOptions(all, resolvedDefault));
    } catch {
      // Fallback only when Projects service is unavailable.
      try {
        const fallback = await artifactsApi.projects();
        const fallbackOptions = fallback
          .map((project) => ({ projectId: project.projectId, projectName: project.projectName }))
          .sort((a, b) => (a.projectName || a.projectId).localeCompare(b.projectName || b.projectId));
        const merged = new Map<string, ProjectOption>();
        if (resolvedDefault?.projectId) {
          merged.set(resolvedDefault.projectId, resolvedDefault);
        }
        for (const option of fallbackOptions) {
          merged.set(option.projectId, option);
        }
        setProjectOptions([...merged.values()]);
      } catch {
        // Notification is handled globally.
      }
    }
  };

  const loadTree = async () => {
    setIsLoading(true);
    try {
      const treeItems = await artifactsApi.tree(projectFilter || undefined);
      setItems(treeItems);

      if (selectedItemId && !treeItems.some((item) => item.id === selectedItemId)) {
        setSelectedItemId(null);
        setSelectedItemIds([]);
        setSelectionAnchorId(null);
        const fallbackProject = resolveProjectFromFilter();
        setDraft({
          ...defaultDraft,
          projectId: fallbackProject.projectId,
          projectName: fallbackProject.projectName ?? ""
        });
        setMode("view");
      }
    } catch {
      // Notification is handled globally.
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadProjects();
  }, []);

  useEffect(() => {
    void loadTree();
  }, [projectFilter]);

  useEffect(() => {
    if (!requestedItemId) {
      return;
    }

    const target = items.find((item) => item.id === requestedItemId);
    if (!target || selectedItemId === requestedItemId) {
      return;
    }

    setSelectedItemId(target.id);
    setSelectedItemIds([target.id]);
    setSelectionAnchorId(target.id);
    setSelectedFolderPath(parentPath(target.path));
  }, [items, requestedItemId, selectedItemId]);

  useEffect(() => {
    if (!selectedItemId) {
      return;
    }

    let cancelled = false;
    void artifactsApi
      .getItem(selectedItemId)
      .then((item) => {
        if (cancelled) return;
        const nextDraft = itemToDraft(item);
        setDraft(nextDraft);
        setMode("view");
      })
      .catch(() => {
        // Notification is handled globally.
      });

    return () => {
      cancelled = true;
    };
  }, [selectedItemId]);

  useEffect(() => {
    if (!draft.id || draft.kind !== "file" || !isPdf(draft)) {
      if (pdfBlobUrl) {
        URL.revokeObjectURL(pdfBlobUrl);
      }
      setPdfBlobUrl(null);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;

    void artifactsApi
      .downloadFile(draft.id, false)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPdfBlobUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) {
          setPdfBlobUrl(null);
        }
      });

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [draft.id, draft.kind, draft.mimeType, draft.path]);

  useEffect(() => {
    if (!draft.id || draft.kind !== "file" || !isImage(draft)) {
      if (imageBlobUrl) URL.revokeObjectURL(imageBlobUrl);
      setImageBlobUrl(null);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;

    void artifactsApi
      .downloadFile(draft.id, false)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setImageBlobUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setImageBlobUrl(null);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [draft.id, draft.kind, draft.mimeType, draft.path]);

  useEffect(() => {
    if (notePreviewMode !== "live") {
      return;
    }
    const editor = notionEditorRef.current;
    if (!editor) return;

    const hasItemChanged = notionSyncRef.current.itemId !== draft.id;
    const hasMarkdownChanged = notionSyncRef.current.markdown !== draft.contentMarkdown;
    const isFocused = document.activeElement === editor;
    if (!hasItemChanged && !hasMarkdownChanged && isFocused) {
      return;
    }

    editor.innerHTML = markdownToNotionHtml(draft.contentMarkdown || "");
    if (editor.children.length === 0) {
      editor.appendChild(createNotionBlock("paragraph"));
    }
    notionSyncRef.current = { itemId: draft.id, markdown: draft.contentMarkdown };
  }, [draft.contentMarkdown, draft.id, notePreviewMode]);

  useEffect(() => {
    if (notePreviewMode !== "live") {
      tableSelectionDragRef.current = null;
      setTableSelection(null);
      setTableContextMenu(null);
      applyTableSelectionVisual(null);
      return;
    }
    applyTableSelectionVisual(tableSelection);
  }, [draft.contentMarkdown, draft.id, notePreviewMode, tableSelection]);

  useEffect(() => {
    if (!contextMenu && !tableContextMenu) return;

    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
        setTableContextMenu(null);
      }
    };
    const handleClose = () => {
      setContextMenu(null);
      setTableContextMenu(null);
    };

    window.addEventListener("keydown", handleEscape);
    window.addEventListener("resize", handleClose);
    window.addEventListener("scroll", handleClose, true);
    return () => {
      window.removeEventListener("keydown", handleEscape);
      window.removeEventListener("resize", handleClose);
      window.removeEventListener("scroll", handleClose, true);
    };
  }, [contextMenu, tableContextMenu]);

  useEffect(() => {
    const existingIds = new Set(items.map((item) => item.id));
    setSelectedItemIds((prev) => {
      const next = prev.filter((id) => existingIds.has(id));
      return next.length === prev.length ? prev : next;
    });
    setSelectionAnchorId((prev) => (prev && existingIds.has(prev) ? prev : null));
  }, [items]);

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      const { canSave: cs, isSaving: is, markdownEditorVisible: mev } = shortcutStateRef.current;
      // Ctrl+S: save
      if (e.ctrlKey && !e.shiftKey && e.key === "s") {
        e.preventDefault();
        if (cs && !is) void handleSaveRef.current();
        return;
      }
      // Ctrl+Shift+V: cycle edit/preview/live
      if (e.ctrlKey && e.shiftKey && e.key === "V") {
        if (mev) {
          e.preventDefault();
          setNotePreviewMode((prev) => (prev === "edit" ? "preview" : prev === "preview" ? "live" : "edit"));
        }
        return;
      }
      // Ctrl+Shift+↑: expand editor
      if (e.ctrlKey && e.shiftKey && e.key === "ArrowUp") {
        if (mev) {
          e.preventDefault();
          setEditorExpanded(true);
        }
        return;
      }
      // Ctrl+Shift+↓: shrink editor
      if (e.ctrlKey && e.shiftKey && e.key === "ArrowDown") {
        if (mev) {
          e.preventDefault();
          setEditorExpanded(false);
        }
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []); // stable: reads via refs, sets via stable setState

  const updateSelection = (itemId: string, shiftKey: boolean) => {
    if (shiftKey && selectionAnchorId) {
      const anchorIndex = visibleSelectableItemIds.indexOf(selectionAnchorId);
      const currentIndex = visibleSelectableItemIds.indexOf(itemId);
      if (anchorIndex >= 0 && currentIndex >= 0) {
        const start = Math.min(anchorIndex, currentIndex);
        const end = Math.max(anchorIndex, currentIndex);
        setSelectedItemIds(visibleSelectableItemIds.slice(start, end + 1));
        return;
      }
    }
    setSelectedItemIds([itemId]);
    setSelectionAnchorId(itemId);
  };

  const selectItem = (item: ArtifactItem, options?: { shiftKey?: boolean }) => {
    const withShift = Boolean(options?.shiftKey);
    setMobileTreeVisible(false);
    setSelectedItemId(item.id);
    updateSelection(item.id, withShift);
    setSelectedFolderPath(parentPath(item.path));
    setError(null);
    setTagInput("");
  };

  const toggleFolder = (folderPath: string) => {
    setCollapsedFolders((prev) => {
      const next = { ...prev };
      if (next[folderPath]) {
        delete next[folderPath];
      } else {
        next[folderPath] = true;
      }
      return next;
    });
  };

  const openContextMenu = (event: MouseEvent<HTMLButtonElement | HTMLElement>, target: TreeContextTarget) => {
    event.preventDefault();
    event.stopPropagation();
    setTableContextMenu(null);
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      target
    });
  };

  const resolveContextTargetPath = (target: TreeContextTarget): string => {
    if (target.type === "item") {
      return normalizePath(target.item.path);
    }
    return normalizePath(target.folderPath);
  };

  const copyTextToClipboard = async (value: string) => {
    const text = value || "/";
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
    } catch (copyError) {
      const message = copyError instanceof Error ? copyError.message : "Failed to copy path.";
      setError(message);
    }
  };

  const resolveTableCellFromTarget = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) {
      return null;
    }
    const cell = target.closest("th,td");
    if (!(cell instanceof HTMLTableCellElement)) {
      return null;
    }
    const table = cell.closest("table");
    if (!(table instanceof HTMLTableElement)) {
      return null;
    }
    const block = table.closest("[data-md-kind='table']");
    if (!(block instanceof HTMLElement)) {
      return null;
    }
    normalizeNotionBlockElement(block);
    const tableId = block.dataset.tableId;
    if (!tableId) {
      return null;
    }
    const rowElement = cell.parentElement;
    if (!(rowElement instanceof HTMLTableRowElement)) {
      return null;
    }
    const rows = getNotionTableRows(table);
    const rowIndex = rows.indexOf(rowElement);
    if (rowIndex < 0) {
      return null;
    }
    const colIndex = Array.from(rowElement.cells).indexOf(cell);
    if (colIndex < 0) {
      return null;
    }
    return {
      block,
      table,
      tableId,
      rowIndex,
      colIndex
    };
  };

  const isCellInTableSelection = (selection: TableSelectionState, row: number, col: number): boolean => {
    const bounds = normalizeTableSelectionBounds(selection);
    return row >= bounds.startRow && row <= bounds.endRow && col >= bounds.startCol && col <= bounds.endCol;
  };

  function applyTableSelectionVisual(selection: TableSelectionState | null): void {
    const editor = notionEditorRef.current;
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

  const setAndApplyTableSelection = (selection: TableSelectionState | null) => {
    setTableSelection(selection);
    applyTableSelectionVisual(selection);
  };

  const getSelectedTableContext = (selection: TableSelectionState | null) => {
    const editor = notionEditorRef.current;
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

  const applyTableOperation = (
    operation:
      | "insert-row-above"
      | "insert-row-below"
      | "insert-column-left"
      | "insert-column-right"
      | "delete-rows"
      | "delete-columns"
  ) => {
    const activeSelection = tableContextMenu?.selection ?? tableSelection;
    const context = getSelectedTableContext(activeSelection);
    if (!context) {
      return;
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

    const normalizedContext = getSelectedTableContext(nextSelection);
    const correctedSelection = normalizedContext
      ? {
          tableId: nextSelection!.tableId,
          start: { row: normalizedContext.bounds.startRow, col: normalizedContext.bounds.startCol },
          end: { row: normalizedContext.bounds.endRow, col: normalizedContext.bounds.endCol }
        }
      : nextSelection;
    setAndApplyTableSelection(correctedSelection);
    syncDraftFromNotionEditor();
  };

  const handleNotionEditorMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    const resolved = resolveTableCellFromTarget(event.target);
    if (!resolved) {
      tableSelectionDragRef.current = null;
      setAndApplyTableSelection(null);
      setTableContextMenu(null);
      return;
    }
    const selection: TableSelectionState = {
      tableId: resolved.tableId,
      start: { row: resolved.rowIndex, col: resolved.colIndex },
      end: { row: resolved.rowIndex, col: resolved.colIndex }
    };
    tableSelectionDragRef.current = selection;
    setAndApplyTableSelection(selection);
    setTableContextMenu(null);
  };

  const handleNotionEditorMouseOver = (event: MouseEvent<HTMLDivElement>) => {
    if (!tableSelectionDragRef.current || (event.buttons & 1) !== 1) {
      return;
    }
    const resolved = resolveTableCellFromTarget(event.target);
    if (!resolved || resolved.tableId !== tableSelectionDragRef.current.tableId) {
      return;
    }
    const nextSelection: TableSelectionState = {
      ...tableSelectionDragRef.current,
      end: { row: resolved.rowIndex, col: resolved.colIndex }
    };
    tableSelectionDragRef.current = nextSelection;
    setAndApplyTableSelection(nextSelection);
  };

  const handleNotionEditorMouseUp = () => {
    tableSelectionDragRef.current = null;
  };

  const handleNotionEditorContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const resolved = resolveTableCellFromTarget(event.target);
    if (!resolved) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const clicked = {
      tableId: resolved.tableId,
      start: { row: resolved.rowIndex, col: resolved.colIndex },
      end: { row: resolved.rowIndex, col: resolved.colIndex }
    };
    const activeSelection =
      tableSelection && tableSelection.tableId === resolved.tableId &&
        isCellInTableSelection(tableSelection, resolved.rowIndex, resolved.colIndex)
        ? tableSelection
        : clicked;
    setAndApplyTableSelection(activeSelection);
    setContextMenu(null);
    setTableContextMenu({
      x: event.clientX,
      y: event.clientY,
      selection: activeSelection
    });
  };

  const handleStartCreateNote = () => {
    const targetProject = resolveProjectFromFilter();

    const newPath = joinPath(currentFolderPath, "new-note.md") || "new-note.md";
    setMobileTreeVisible(false);
    setMode("create-note");
    setSelectedItemId(null);
    setSelectedItemIds([]);
    setSelectionAnchorId(null);
    setDraft({
      ...defaultDraft,
      kind: "note",
      title: "New Note",
      path: newPath,
      projectId: targetProject.projectId,
      projectName: targetProject.projectName ?? "",
      tags: [],
      contentMarkdown: ""
    });
    setError(null);
    setTagInput("");
    setNotePreviewMode("edit");
  };

  const handleCreateFolder = (baseFolderPath = currentFolderPath) => {
    setCreateFolderState({
      baseFolderPath: normalizePath(baseFolderPath)
    });
  };

  const handleCreateFolderConfirm = async (name: string) => {
    if (!createFolderState) {
      return;
    }
    const normalizedName = name.trim();
    if (!normalizedName) return;

    const activeProject = resolveProjectFromFilter();
    const folderPath = joinPath(createFolderState.baseFolderPath, normalizedName);
    setIsSaving(true);
    setError(null);

    try {
      const created = await artifactsApi.createFolder({
        projectId: activeProject.projectId,
        projectName: activeProject.projectName,
        path: folderPath,
        title: normalizedName
      });

      setSelectedFolderPath(created.path);
      await loadTree();
      setCreateFolderState(null);
    } catch (createError) {
      const message = createError instanceof Error ? createError.message : "Unable to create folder.";
      setError(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleUploadClick = () => {
    uploadInputRef.current?.click();
  };

  const handleUploadFiles = async (files: FileList | null, targetPath?: string) => {
    if (!files || files.length === 0) return;

    const activeProject = resolveProjectFromFilter();

    setIsSaving(true);
    setError(null);

    try {
      let lastUploadedId: string | null = null;
      for (const file of Array.from(files)) {
        const uploaded = await artifactsApi.uploadFile({
          projectId: activeProject.projectId,
          projectName: activeProject.projectName,
          directoryPath: targetPath ?? (currentFolderPath || undefined),
          file
        });
        lastUploadedId = uploaded.id;
      }

      await loadTree();
      if (lastUploadedId) {
        setSelectedItemId(lastUploadedId);
        setSelectedItemIds([lastUploadedId]);
        setSelectionAnchorId(lastUploadedId);
      }
    } catch (uploadError) {
      const message = uploadError instanceof Error ? uploadError.message : "Upload failed.";
      setError(message);
    } finally {
      setIsSaving(false);
      if (uploadInputRef.current) {
        uploadInputRef.current.value = "";
      }
    }
  };

  const handleEditorDrop = async (event: DragEvent<HTMLTextAreaElement>) => {
    const files = event.dataTransfer.files;
    if (!files || files.length === 0) return;
    event.preventDefault();

    const insertPos = event.currentTarget.selectionStart ?? draft.contentMarkdown.length;
    const uploadDir = parentPath(draft.path) || undefined;

    setIsSaving(true);
    setError(null);
    let insertedText = "";

    try {
      for (const file of Array.from(files)) {
        const uploaded = await artifactsApi.uploadFile({
          projectId: draft.projectId,
          projectName: draft.projectName || undefined,
          directoryPath: uploadDir,
          file
        });
        const rel = relativeArtifactPath(draft.path, uploaded.path);
        const isImage = /^image\//i.test(file.type) || /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(file.name);
        insertedText += isImage ? `![${file.name}](${rel})\n` : `[${file.name}](${rel})\n`;
      }
      await loadTree();
      setDraft((prev) => ({
        ...prev,
        contentMarkdown:
          prev.contentMarkdown.slice(0, insertPos) + insertedText + prev.contentMarkdown.slice(insertPos)
      }));
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Upload failed.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleEditorPaste = async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files).filter((f) => /^image\//i.test(f.type));
    if (files.length === 0) return;
    event.preventDefault();

    const insertPos = event.currentTarget.selectionStart ?? draft.contentMarkdown.length;
    const uploadDir = parentPath(draft.path) || undefined;

    setIsSaving(true);
    setError(null);
    let insertedText = "";

    try {
      for (const file of files) {
        // Give pasted images a timestamped filename if they lack one
        const name = file.name && file.name !== "image.png" ? file.name
          : `paste-${Date.now()}.${file.type.split("/")[1] ?? "png"}`;
        const namedFile = new File([file], name, { type: file.type });
        const uploaded = await artifactsApi.uploadFile({
          projectId: draft.projectId,
          projectName: draft.projectName || undefined,
          directoryPath: uploadDir,
          file: namedFile
        });
        const rel = relativeArtifactPath(draft.path, uploaded.path);
        insertedText += `![${name}](${rel})\n`;
      }
      await loadTree();
      setDraft((prev) => ({
        ...prev,
        contentMarkdown:
          prev.contentMarkdown.slice(0, insertPos) + insertedText + prev.contentMarkdown.slice(insertPos)
      }));
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Upload failed.");
    } finally {
      setIsSaving(false);
    }
  };

  const applyEditorTransform = (transform: EditorTextTransformResult) => {
    setDraft((prev) => ({
      ...prev,
      contentMarkdown: transform.nextText
    }));
    requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      editor.setSelectionRange(transform.nextSelectionStart, transform.nextSelectionEnd);
    });
  };

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const text = draft.contentMarkdown;
    const selectionStart = event.currentTarget.selectionStart ?? text.length;
    const selectionEnd = event.currentTarget.selectionEnd ?? text.length;
    const withCtrl = event.ctrlKey || event.metaKey;

    if (!withCtrl && !event.altKey && !event.shiftKey && event.key === "Enter") {
      const continued = transformEnterWithLevelContinuation(text, selectionStart, selectionEnd);
      if (continued) {
        event.preventDefault();
        applyEditorTransform(continued);
      }
      return;
    }

    if (!withCtrl) {
      return;
    }

    const lowerKey = event.key.toLowerCase();
    if (lowerKey === "b") {
      event.preventDefault();
      applyEditorTransform(transformBoldAtSelection(text, selectionStart, selectionEnd));
      return;
    }

    const isIncrease = event.key === ">" || (event.shiftKey && event.key === ".");
    if (isIncrease) {
      const transformed = transformSelectedLinesLevel(text, selectionStart, selectionEnd, 1);
      if (transformed) {
        event.preventDefault();
        applyEditorTransform(transformed);
      }
      return;
    }

    const isDecrease = event.key === "<" || (event.shiftKey && event.key === ",");
    if (isDecrease) {
      const transformed = transformSelectedLinesLevel(text, selectionStart, selectionEnd, -1);
      if (transformed) {
        event.preventDefault();
        applyEditorTransform(transformed);
      }
    }
  };

  const syncDraftFromNotionEditor = () => {
    const editor = notionEditorRef.current;
    if (!editor) return;
    // Keep only normalized notion blocks so serialization is stable.
    const children = Array.from(editor.children) as HTMLElement[];
    if (children.length === 0) {
      editor.appendChild(createNotionBlock("paragraph"));
    } else {
      for (const child of children) {
        normalizeNotionBlockElement(child);
      }
    }

    const markdown = notionEditorToMarkdown(editor);
    notionSyncRef.current = { itemId: draft.id, markdown };
    setDraft((prev) => (prev.contentMarkdown === markdown ? prev : { ...prev, contentMarkdown: markdown }));
  };

  const handleNotionEditorInput = () => {
    syncDraftFromNotionEditor();
  };

  const handleNotionEditorPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain");
    if (text) {
      document.execCommand("insertText", false, text);
      syncDraftFromNotionEditor();
    }
  };

  const handleNotionEditorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const editor = notionEditorRef.current;
    if (!editor) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const currentBlock = findNotionBlock(editor, range.startContainer);
    if (!currentBlock) return;

    const withCtrl = event.ctrlKey || event.metaKey;
    const isInsideTableCell =
      currentBlock.dataset.mdKind === "table" &&
      event.target instanceof HTMLElement &&
      event.target.closest("th,td") instanceof HTMLTableCellElement;

    if (withCtrl && event.key.toLowerCase() === "b") {
      event.preventDefault();
      document.execCommand("bold");
      syncDraftFromNotionEditor();
      return;
    }

    if (isInsideTableCell) {
      return;
    }

    if (withCtrl && (event.key === ">" || (event.shiftKey && event.key === "."))) {
      if (currentBlock.dataset.mdKind === "bullet" || currentBlock.dataset.mdKind === "heading") {
        event.preventDefault();
        const currentLevel = Number(currentBlock.dataset.mdLevel || "1");
        currentBlock.dataset.mdLevel = String(Math.min(3, currentLevel + 1));
        normalizeNotionBlockElement(currentBlock);
        syncDraftFromNotionEditor();
      }
      return;
    }

    if (withCtrl && (event.key === "<" || (event.shiftKey && event.key === ","))) {
      if (currentBlock.dataset.mdKind === "bullet" || currentBlock.dataset.mdKind === "heading") {
        event.preventDefault();
        const currentLevel = Number(currentBlock.dataset.mdLevel || "1");
        if (currentLevel <= 1) {
          currentBlock.dataset.mdKind = "paragraph";
          delete currentBlock.dataset.mdLevel;
        } else {
          currentBlock.dataset.mdLevel = String(currentLevel - 1);
        }
        normalizeNotionBlockElement(currentBlock);
        syncDraftFromNotionEditor();
      }
      return;
    }

    if (event.key === " " && range.collapsed) {
      const beforeRange = document.createRange();
      beforeRange.setStart(currentBlock, 0);
      beforeRange.setEnd(range.startContainer, range.startOffset);
      const prefix = beforeRange.toString().trim();
      const wholeText = (currentBlock.textContent ?? "").trim();
      if (/^-{1,3}$/.test(prefix) && prefix === wholeText) {
        event.preventDefault();
        currentBlock.dataset.mdKind = "bullet";
        currentBlock.dataset.mdLevel = String(Math.min(3, prefix.length));
        currentBlock.innerHTML = "<br>";
        normalizeNotionBlockElement(currentBlock);
        placeCaretAtBlockStart(currentBlock);
        syncDraftFromNotionEditor();
        return;
      }
      if (/^#{1,3}$/.test(prefix) && prefix === wholeText) {
        event.preventDefault();
        currentBlock.dataset.mdKind = "heading";
        currentBlock.dataset.mdLevel = String(Math.min(3, prefix.length));
        currentBlock.innerHTML = "<br>";
        normalizeNotionBlockElement(currentBlock);
        placeCaretAtBlockStart(currentBlock);
        syncDraftFromNotionEditor();
      }
      return;
    }

    if (event.key === "Enter" && range.collapsed) {
      event.preventDefault();
      const kind = currentBlock.dataset.mdKind === "bullet"
        ? "bullet"
        : currentBlock.dataset.mdKind === "heading"
          ? "heading"
          : "paragraph";
      const level = Number(currentBlock.dataset.mdLevel || "1");
      const blockText = (currentBlock.textContent ?? "").trim();

      if (kind === "bullet" && blockText.length === 0) {
        currentBlock.dataset.mdKind = "paragraph";
        delete currentBlock.dataset.mdLevel;
        normalizeNotionBlockElement(currentBlock);
        currentBlock.innerHTML = "<br>";
        placeCaretAtBlockStart(currentBlock);
        syncDraftFromNotionEditor();
        return;
      }

      const nextKind = kind === "bullet" ? "bullet" : "paragraph";
      const nextBlock = createNotionBlock(nextKind, level);
      if (currentBlock.nextSibling) {
        editor.insertBefore(nextBlock, currentBlock.nextSibling);
      } else {
        editor.appendChild(nextBlock);
      }
      placeCaretAtBlockStart(nextBlock);
      syncDraftFromNotionEditor();
    }
  };

  const handleSave = async () => {
    if (!canSave) {
      setError("Title, path は必須です。");
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      if (mode === "create-note" || !draft.id) {
        const activeProject = resolveProjectFromDraft();

        const created = await artifactsApi.createNote({
          projectId: activeProject.projectId,
          projectName: activeProject.projectName,
          path: draft.path.trim(),
          title: draft.title.trim(),
          tags: draft.tags,
          contentMarkdown: draft.contentMarkdown
        });

        await loadTree();
        setSelectedItemId(created.id);
        setSelectedItemIds([created.id]);
        setSelectionAnchorId(created.id);
        setMode("view");
      } else {
        const activeProject = resolveProjectFromDraft();
        const updated = await artifactsApi.updateItem(draft.id, {
          title: draft.title.trim(),
          path: draft.path.trim(),
          tags: draft.tags,
          contentMarkdown: markdownEditorVisible ? draft.contentMarkdown : undefined,
          projectName: activeProject.projectName
        });

        setDraft(itemToDraft(updated));
        await loadTree();
      }
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : "Save failed.";
      setError(message);
    } finally {
      setIsSaving(false);
    }
  };

  // Keep refs in sync for stable keyboard shortcut handler
  handleSaveRef.current = handleSave;
  shortcutStateRef.current = { canSave, isSaving, markdownEditorVisible };

  const createDeleteConfirmState = (ids: string[]): DeleteConfirmState | null => {
    const normalized = [...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0))];
    if (normalized.length === 0) {
      return null;
    }
    if (normalized.length === 1) {
      const item = itemsById.get(normalized[0]);
      return {
        ids: normalized,
        count: 1,
        title: item?.title || "selected item"
      };
    }
    return {
      ids: normalized,
      count: normalized.length
    };
  };

  const resolveBatchDeleteIds = (ids: string[]): string[] => {
    const selected = ids
      .map((id) => itemsById.get(id))
      .filter((item): item is ArtifactItem => Boolean(item));

    if (selected.length === 0) {
      return [];
    }

    const folderPaths = selected
      .filter((item) => item.kind === "folder")
      .map((item) => normalizePath(item.path));

    const filtered = selected.filter((item) => {
      const itemPath = normalizePath(item.path);
      return !folderPaths.some((folderPath) => folderPath !== itemPath && itemPath.startsWith(`${folderPath}/`));
    });

    return filtered
      .sort((a, b) => normalizePath(b.path).length - normalizePath(a.path).length)
      .map((item) => item.id);
  };

  const deleteItemsByIds = async (itemIds: string[]) => {
    const targets = resolveBatchDeleteIds(itemIds);
    if (targets.length === 0) {
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      let deletedCount = 0;
      for (const id of targets) {
        try {
          await artifactsApi.removeItem(id);
          deletedCount += 1;
        } catch {
          // Continue deleting remaining targets.
        }
      }

      const deletedIdSet = new Set(targets);
      if ((selectedItemId && deletedIdSet.has(selectedItemId)) || (draft.id && deletedIdSet.has(draft.id))) {
        setSelectedItemId(null);
        setDraft({ ...defaultDraft });
      }
      setSelectedItemIds((prev) => prev.filter((id) => !deletedIdSet.has(id)));
      setSelectionAnchorId((prev) => (prev && deletedIdSet.has(prev) ? null : prev));
      await loadTree();
      if (deletedCount < targets.length) {
        setError(`Deleted ${deletedCount}/${targets.length} items. Some items could not be deleted.`);
      }
    } catch (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : "Delete failed.";
      setError(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    const ids = selectedItemIds.length > 0 ? selectedItemIds : draft.id ? [draft.id] : [];
    const nextConfirm = createDeleteConfirmState(ids);
    if (!nextConfirm) {
      return;
    }
    setDeleteConfirm(nextConfirm);
  };

  const handleDownload = async () => {
    if (!draft.id || draft.kind !== "file") return;

    try {
      const blob = await artifactsApi.downloadFile(draft.id, true);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = draft.title || "artifact";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      // Global notification already shown.
    }
  };

  const handleTagInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      const normalized = tagInput.trim();
      if (!normalized) return;
      if (draft.tags.some((tag) => tag.toLowerCase() === normalized.toLowerCase())) {
        setTagInput("");
        return;
      }
      setDraft((prev) => ({ ...prev, tags: [...prev.tags, normalized] }));
      setTagInput("");
    }

    if (event.key === "Backspace" && !tagInput && draft.tags.length > 0) {
      setDraft((prev) => ({ ...prev, tags: prev.tags.slice(0, -1) }));
    }
  };

  const isInvalidFolderMove = (item: ArtifactItem, targetFolderPath: string): boolean => {
    if (item.kind !== "folder") {
      return false;
    }
    const normalizedTarget = normalizePath(targetFolderPath);
    const sourcePath = normalizePath(item.path);
    if (normalizedTarget === sourcePath) {
      return true;
    }
    return normalizedTarget.startsWith(`${sourcePath}/`);
  };

  const moveItemToFolder = async (item: ArtifactItem, destinationFolderPath: string) => {
    const normalizedDestination = normalizePath(destinationFolderPath);
    const nextPath = normalizePath(joinPath(normalizedDestination, leafPath(item.path)));
    if (!nextPath || nextPath === normalizePath(item.path)) {
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      const updated = await artifactsApi.updateItem(item.id, { path: nextPath });
      if (selectedItemId === item.id || draft.id === item.id) {
        setDraft(itemToDraft(updated));
        setSelectedFolderPath(parentPath(updated.path));
      }
      await loadTree();
    } catch (moveError) {
      const message = moveError instanceof Error ? moveError.message : "Move failed.";
      setError(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDragStart = (event: DragEvent<HTMLButtonElement>, item: ArtifactItem) => {
    setContextMenu(null);
    setDraggingItemId(item.id);
    draggingItemRef.current = item;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", item.id);
  };

  const handleDragEnd = () => {
    draggingItemRef.current = null;
    setDraggingItemId(null);
    setDropTargetPath(null);
  };

  const resolveDraggedItemFromEvent = (event: DragEvent<HTMLElement>): ArtifactItem | null => {
    const transferId = event.dataTransfer.getData("text/plain").trim();
    if (transferId) {
      const found = items.find((item) => item.id === transferId);
      if (found) {
        return found;
      }
    }
    if (draggingItemRef.current) {
      return draggingItemRef.current;
    }
    return draggingItem;
  };

  const handleFolderDragOver = (event: DragEvent<HTMLButtonElement>, targetFolderPath: string) => {
    const hasFiles = event.dataTransfer.types.includes("Files");
    const dragItem = resolveDraggedItemFromEvent(event);
    if (!dragItem && !hasFiles) {
      setDropTargetPath(null);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = hasFiles ? "copy" : "move";
    setDropTargetPath(normalizePath(targetFolderPath));
  };

  const handleRootDrop = (event: DragEvent<HTMLElement>) => {
    if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      setDropTargetPath(null);
      void handleUploadFiles(event.dataTransfer.files, ROOT_DROP_PATH);
      return;
    }
    event.preventDefault();
    const dragItem = resolveDraggedItemFromEvent(event);
    if (!dragItem) return;
    if (isInvalidFolderMove(dragItem, ROOT_DROP_PATH)) return;
    setDropTargetPath(null);
    void moveItemToFolder(dragItem, ROOT_DROP_PATH);
  };

  const handleFolderDrop = (event: DragEvent<HTMLButtonElement>, targetFolderPath: string) => {
    if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      setDropTargetPath(null);
      void handleUploadFiles(event.dataTransfer.files, targetFolderPath);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const dragItem = resolveDraggedItemFromEvent(event);
    if (!dragItem) return;
    if (isInvalidFolderMove(dragItem, targetFolderPath)) return;
    setDropTargetPath(null);
    void moveItemToFolder(dragItem, targetFolderPath);
  };

  const handleRootDragOver = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropTargetPath(ROOT_DROP_PATH);
  };

  const executeContextAction = (action: () => Promise<void> | void) => {
    setContextMenu(null);
    setTableContextMenu(null);
    void action();
  };

  const executeTableContextAction = (action: () => void) => {
    setTableContextMenu(null);
    void action();
  };

  const tableMenuContext = tableContextMenu ? getSelectedTableContext(tableContextMenu.selection) : null;
  const canDeleteTableRows = Boolean(tableMenuContext && tableMenuContext.bounds.endRow >= 1);
  const canDeleteTableColumns = Boolean(
    tableMenuContext &&
      tableMenuContext.colCount > (tableMenuContext.bounds.endCol - tableMenuContext.bounds.startCol + 1)
  );

  const renderDirectoryBrowser = (): ReactNode => {
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
                  setSelectedFolderPath(childFolder.path);
                  if (childFolder.folderItem) {
                    updateSelection(childFolder.folderItem.id, event.shiftKey);
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
                onClick={(event) => selectItem(item, { shiftKey: event.shiftKey })}
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
  };

  return (
    <section
      className="va-artifacts-page"
      onClick={() => {
        setContextMenu(null);
        setTableContextMenu(null);
      }}
    >
      <section className="va-shell panel">
        <header className="va-toolbar">
          <div className="va-toolbar-left">
            {hasDetailSelection ? (
              <button
                type="button"
                className="va-mobile-pane-toggle"
                onClick={() => setMobileTreeVisible((prev) => !prev)}
                aria-label={mobileTreeVisible ? "Show editor pane" : "Show tree pane"}
                title={mobileTreeVisible ? "Show Editor" : "Show Tree"}
              >
                {mobileTreeVisible ? <IcoFile /> : <IcoFolder />}
              </button>
            ) : null}
            <button
              type="button"
              className="va-home-icon-btn"
              onClick={() => setSelectedFolderPath("")}
              aria-label="Home"
              title="Root Directory"
            >
              <span className="va-home-icon" aria-hidden="true"><IcoHome /></span>
            </button>
            <strong>{currentFolderPath || "root"}</strong>
          </div>

          <div className="va-toolbar-right">
            <label className="va-project-select-wrap">
              <span>Project</span>
              <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}>
                <option value="">All</option>
                {projectOptions.map((project) => (
                  <option key={project.projectId} value={project.projectId}>
                    {normalizeProjectName(project.projectId, project.projectName)}
                  </option>
                ))}
              </select>
            </label>

            <button type="button" className="va-action-btn" onClick={handleUploadClick} disabled={isSaving}>
              <IcoUpload /> Upload
            </button>
            <button type="button" className="va-action-btn" onClick={() => void handleCreateFolder()} disabled={isSaving}>
              <IcoFolder /> New Folder
            </button>
            <button type="button" className="va-action-btn primary" onClick={handleStartCreateNote} disabled={isSaving}>
              + New Note
            </button>
          </div>
        </header>

        {error ? <p className="va-inline-error">{error}</p> : null}

        <div className={`va-main-grid ${hasDetailSelection && !mobileTreeVisible ? "viewer-active" : "browser-active"}`}>
          <aside
            className={[
              "va-tree-pane",
              dropTargetPath === ROOT_DROP_PATH ? "drop-target-root" : ""
            ]
              .filter(Boolean)
              .join(" ")}
            onContextMenu={(event) =>
              openContextMenu(event, {
                type: "background",
                folderPath: ""
              })
            }
            onDragEnter={handleRootDragOver}
            onDragOver={handleRootDragOver}
            onDrop={handleRootDrop}
          >
            {isLoading ? <div className="va-empty">Loading...</div> : renderDirectoryBrowser()}
            <footer className="va-tree-foot">
              <span>{selectedItemIds.length} selected</span>
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  setSelectedItemId(null);
                  setSelectedItemIds([]);
                  setSelectionAnchorId(null);
                }}
              >
                Clear
              </button>
            </footer>
          </aside>

          <main className="va-detail-pane">
            <header className="va-detail-head">
              <div className="va-detail-title-block">
                <span className="va-detail-path">{draft.path || "No item selected"}</span>
                {draft.version ? <small>v{draft.version}</small> : null}
              </div>

              <div className="va-detail-actions">
                <button
                  type="button"
                  className="va-icon-btn va-close-viewer-btn"
                  onClick={() => {
                    setMobileTreeVisible(true);
                    setSelectedItemId(null);
                    setSelectedItemIds([]);
                    setSelectionAnchorId(null);
                    setMode("view");
                  }}
                  aria-label="Close viewer"
                  title="Close"
                >
                  <IcoClose />
                </button>

                {draft.kind === "file" && draft.id ? (
                  <button type="button" className="va-action-btn" onClick={() => void handleDownload()}>
                    <IcoDownload /> Download
                  </button>
                ) : null}

                {draft.id ? (
                  <button
                    type="button"
                    className="va-icon-btn"
                    onClick={() => void handleDelete()}
                    disabled={isSaving}
                    aria-label="Delete item"
                    title="Delete"
                  >
                    <IcoTrash />
                  </button>
                ) : null}

                <button type="button" className="va-action-btn primary" onClick={() => void handleSave()} disabled={isSaving || !canSave}>
                  <IcoFloppy />
                </button>
              </div>
            </header>

            <section className={`va-form-grid${editorExpanded ? " editor-expanded" : ""}`}>
              <label className="span-2">
                <span className="va-field-label">Title *</span>
                <input
                  value={draft.title}
                  onChange={(event) => setDraft((prev) => ({ ...prev, title: event.target.value }))}
                  placeholder="Title"
                />
              </label>

              <label className="span-2">
                <span className="va-field-label">Path *</span>
                <input
                  value={draft.path}
                  onChange={(event) => setDraft((prev) => ({ ...prev, path: event.target.value }))}
                  placeholder="asset/notes/idea.md"
                />
              </label>

              {draft.kind === "file" ? (
                <div className="span-2 va-meta-strip">
                  <div>
                    <small>MIME</small>
                    <p>{draft.mimeType || "-"}</p>
                  </div>
                  <div>
                    <small>SIZE</small>
                    <p>{formatSize(draft.sizeBytes)}</p>
                  </div>
                  <div>
                    <small>UPDATED</small>
                    <p>{draft.updatedAt ? formatDateTime(draft.updatedAt) : "-"}</p>
                  </div>
                </div>
              ) : null}

              {markdownEditorVisible ? (
                <div className="span-2 va-content-section">
                  <div className="va-content-head">
                    <span className="va-field-label">Content (Markdown)</span>
                    <div className="va-content-head-right">
                      <div className="va-content-mode">
                        <button
                          type="button"
                          className={notePreviewMode === "edit" ? "active" : undefined}
                          onClick={() => setNotePreviewMode("edit")}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className={notePreviewMode === "preview" ? "active" : undefined}
                          onClick={() => setNotePreviewMode("preview")}
                        >
                          Preview
                        </button>
                        <button
                          type="button"
                          className={notePreviewMode === "live" ? "active" : undefined}
                          onClick={() => setNotePreviewMode("live")}
                        >
                          Live
                        </button>
                      </div>
                      <button
                        type="button"
                        className="va-icon-btn va-expand-btn"
                        onClick={() => setEditorExpanded((v) => !v)}
                        title={editorExpanded ? "Collapse (Ctrl+Shift+↓)" : "Expand (Ctrl+Shift+↑)"}
                        aria-label={editorExpanded ? "Collapse editor" : "Expand editor"}
                      >
                        {editorExpanded ? <IcoCompress /> : <IcoExpand />}
                      </button>
                    </div>
                  </div>

                  {notePreviewMode === "edit" ? (
                    <textarea
                      ref={editorRef}
                      rows={14}
                      value={draft.contentMarkdown}
                      onChange={(event) => setDraft((prev) => ({ ...prev, contentMarkdown: event.target.value }))}
                      onKeyDown={handleEditorKeyDown}
                      onDragOver={(event) => { event.preventDefault(); }}
                      onDrop={(event) => { void handleEditorDrop(event); }}
                      onPaste={(event) => { void handleEditorPaste(event); }}
                      placeholder="# note"
                    />
                  ) : notePreviewMode === "preview" ? (
                    <div className="va-markdown-preview">
                      <MarkdownRendererContext.Provider value={{ items, currentPath: draft.path, selectItem }}>
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                          {preprocessMarkdownBullets(draft.contentMarkdown || "_No content_")}
                        </ReactMarkdown>
                      </MarkdownRendererContext.Provider>
                    </div>
                  ) : (
                    <MarkdownRendererContext.Provider value={{ items, currentPath: draft.path, selectItem }}>
                      <div
                        ref={notionEditorRef}
                        className="va-notion-editor"
                        contentEditable
                        suppressContentEditableWarning
                        onInput={handleNotionEditorInput}
                        onKeyDown={handleNotionEditorKeyDown}
                        onMouseDown={handleNotionEditorMouseDown}
                        onMouseOver={handleNotionEditorMouseOver}
                        onMouseUp={handleNotionEditorMouseUp}
                        onContextMenu={handleNotionEditorContextMenu}
                        onPaste={handleNotionEditorPaste}
                        onBlur={syncDraftFromNotionEditor}
                        data-placeholder="Type markdown-like text. Use '- ' for bullet."
                      />
                    </MarkdownRendererContext.Provider>
                  )}
                </div>
              ) : null}

              {draft.kind === "file" && isImage(draft) ? (
                <div className="span-2 va-preview-section">
                  <span className="va-field-label">Preview</span>
                  {imageBlobUrl ? (
                    <img src={imageBlobUrl} alt={draft.title} className="va-image-preview" />
                  ) : (
                    <div className="va-empty">Loading image preview...</div>
                  )}
                </div>
              ) : null}

              {draft.kind === "file" && isPdf(draft) ? (
                <div className="span-2 va-preview-section">
                  <span className="va-field-label">Preview</span>
                  {pdfBlobUrl ? (
                    <iframe src={pdfBlobUrl} className="va-pdf-frame" title={draft.title} />
                  ) : (
                    <div className="va-empty">Loading PDF preview...</div>
                  )}
                </div>
              ) : null}

              <div className="span-2">
                <span className="va-field-label">Tags</span>
                <div className="va-tags-wrap" onClick={() => document.getElementById("va-artifact-tag-input")?.focus()}>
                  {draft.tags.map((tag) => (
                    <span key={tag} className="va-tag-chip">
                      {tag}
                      <button
                        type="button"
                        onClick={() => setDraft((prev) => ({ ...prev, tags: prev.tags.filter((value) => value !== tag) }))}
                        aria-label={`Remove ${tag}`}
                      >
                        x
                      </button>
                    </span>
                  ))}
                  <input
                    id="va-artifact-tag-input"
                    value={tagInput}
                    onChange={(event) => setTagInput(event.target.value)}
                    onKeyDown={handleTagInputKeyDown}
                    onBlur={() => {
                      const normalized = tagInput.trim();
                      if (!normalized) return;
                      if (!draft.tags.some((tag) => tag.toLowerCase() === normalized.toLowerCase())) {
                        setDraft((prev) => ({ ...prev, tags: [...prev.tags, normalized] }));
                      }
                      setTagInput("");
                    }}
                    placeholder="Add tag, press Enter"
                  />
                </div>
              </div>

              {(draft.createdAt || selectedItemSummary) ? (
                <div className="span-2 va-detail-meta">
                  {draft.createdAt ? <small>Created {formatDateTime(draft.createdAt)}</small> : null}
                  {draft.updatedAt ? <small>Updated {formatDateTime(draft.updatedAt)}</small> : null}
                  {selectedItemSummary ? (
                    <Link to={`/projects/${draft.projectId || selectedItemSummary.projectId}`}>Open Project View</Link>
                  ) : null}
                </div>
              ) : null}
            </section>
          </main>
        </div>
      </section>

      {contextMenu && contextMenuPosition ? (
        <div
          className="va-context-menu"
          style={{ left: contextMenuPosition.left, top: contextMenuPosition.top }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() =>
              executeContextAction(() => {
                if (contextMenu.target.type === "item") {
                  selectItem(contextMenu.target.item);
                  return;
                }
                if (contextMenu.target.type === "folder") {
                  setSelectedFolderPath(contextMenu.target.folderPath);
                  return;
                }
                setSelectedItemId(null);
                setSelectedItemIds([]);
                setSelectionAnchorId(null);
              })
            }
          >
            Open
          </button>
          <button
            type="button"
            onClick={() =>
              executeContextAction(async () => {
                await copyTextToClipboard(resolveContextTargetPath(contextMenu.target));
              })
            }
          >
            Copy Path
          </button>
          <button
            type="button"
            onClick={() =>
              executeContextAction(() => {
                const basePath =
                  contextMenu.target.type === "item"
                    ? parentPath(contextMenu.target.item.path)
                    : contextMenu.target.folderPath;
                handleCreateFolder(basePath);
              })
            }
          >
            New Folder
          </button>
          <button
            type="button"
            onClick={() =>
              executeContextAction(() => {
                const nextConfirm = createDeleteConfirmState(contextDeleteCandidateIds);
                if (!nextConfirm) return;
                setDeleteConfirm(nextConfirm);
              })
            }
            disabled={contextDeleteCandidateIds.length === 0}
          >
            {contextDeleteCandidateIds.length > 1
              ? "Delete Selected"
              : contextMenu.target.type === "item" && selectedItemIds.length === 0
                ? "Delete File"
                : "Delete Selected"}
          </button>
        </div>
      ) : null}

      {tableContextMenu && tableContextMenuPosition ? (
        <div
          className="va-context-menu va-table-context-menu"
          style={{ left: tableContextMenuPosition.left, top: tableContextMenuPosition.top }}
          onClick={(event) => event.stopPropagation()}
        >
          <button type="button" onClick={() => executeTableContextAction(() => applyTableOperation("insert-row-above"))}>
            Insert Row Above
          </button>
          <button type="button" onClick={() => executeTableContextAction(() => applyTableOperation("insert-row-below"))}>
            Insert Row Below
          </button>
          <button type="button" onClick={() => executeTableContextAction(() => applyTableOperation("insert-column-left"))}>
            Insert Column Left
          </button>
          <button type="button" onClick={() => executeTableContextAction(() => applyTableOperation("insert-column-right"))}>
            Insert Column Right
          </button>
          <button
            type="button"
            disabled={!canDeleteTableRows}
            onClick={() => executeTableContextAction(() => applyTableOperation("delete-rows"))}
          >
            Delete Selected Rows
          </button>
          <button
            type="button"
            disabled={!canDeleteTableColumns}
            onClick={() => executeTableContextAction(() => applyTableOperation("delete-columns"))}
          >
            Delete Selected Columns
          </button>
        </div>
      ) : null}

      <ConfirmDialog
        open={Boolean(deleteConfirm)}
        title={deleteConfirm?.count && deleteConfirm.count > 1 ? "Delete Items" : "Delete Item"}
        message={
          deleteConfirm?.count && deleteConfirm.count > 1
            ? `Delete ${deleteConfirm.count} selected items?`
            : `Delete "${deleteConfirm?.title || "selected item"}"?`
        }
        confirmLabel="Delete"
        confirmTone="danger"
        busy={isSaving}
        onCancel={() => setDeleteConfirm(null)}
        onConfirm={() => {
          if (!deleteConfirm) return;
          const target = deleteConfirm;
          setDeleteConfirm(null);
          void deleteItemsByIds(target.ids);
        }}
      />

      <TextInputDialog
        open={Boolean(createFolderState)}
        title="New Folder"
        message={createFolderState?.baseFolderPath ? `Create in "${createFolderState.baseFolderPath}"` : "Create in root"}
        label="Folder name"
        placeholder="New Folder"
        confirmLabel="Create"
        busy={isSaving}
        onCancel={() => setCreateFolderState(null)}
        onConfirm={(value) => {
          void handleCreateFolderConfirm(value);
        }}
      />

      <input
        ref={uploadInputRef}
        type="file"
        multiple
        className="va-hidden-upload"
        onChange={(event) => void handleUploadFiles(event.target.files)}
      />
    </section>
  );
}
