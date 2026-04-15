import type { ParsedMarkdownTable, TableSelectionBounds, TableSelectionState } from "../types";
import { extractYoutubeId } from "./file";

/** Legacy hook kept for compatibility; no preprocessing is applied now. */
export function preprocessMarkdownBullets(md: string): string {
  return md;
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
    .replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, '<img class="va-md-img va-md-img-loading" data-md-src="$2" alt="$1" />')
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");
}

function parseLineAsMarkdownLink(line: string): { label: string; href: string } | null {
  const match = line.trim().match(/^\[([^\]\n]*)\]\(([^)\s]+)\)$/);
  if (!match) {
    return null;
  }
  return { label: match[1] ?? "", href: match[2] ?? "" };
}

function parseYoutubeSourceFromLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const link = parseLineAsMarkdownLink(trimmed);
  if (link?.href && extractYoutubeId(link.href)) {
    return link.href;
  }

  if (/^https?:\/\/\S+$/i.test(trimmed) && extractYoutubeId(trimmed)) {
    return trimmed;
  }

  return null;
}

function youtubeEmbedBlockToHtml(source: string): string {
  const videoId = extractYoutubeId(source);
  if (!videoId) {
    return `<p class="va-notion-block" data-md-kind="paragraph">${markdownInlineToHtml(source)}</p>`;
  }
  const escapedSource = escapeHtml(source);
  const embedUrl = `https://www.youtube.com/embed/${videoId}`;
  return `<div class="va-notion-block va-md-embed-block" data-md-kind="paragraph" data-md-embed-kind="youtube" data-md-src="${escapedSource}"><iframe class="va-md-youtube" src="${embedUrl}" title="YouTube video preview" loading="lazy" allowfullscreen></iframe></div>`;
}

function ensureNotionYoutubeEmbedBlockStructure(block: HTMLElement): void {
  const source = block.dataset.mdSrc?.trim() ?? "";
  const videoId = source ? extractYoutubeId(source) : null;
  if (!videoId) {
    delete block.dataset.mdEmbedKind;
    return;
  }

  block.classList.add("va-md-embed-block");
  let frame = block.querySelector("iframe") as HTMLIFrameElement | null;
  if (!frame) {
    frame = document.createElement("iframe");
    block.innerHTML = "";
    block.appendChild(frame);
  }

  frame.className = "va-md-youtube";
  frame.src = `https://www.youtube.com/embed/${videoId}`;
  frame.title = "YouTube video preview";
  frame.loading = "lazy";
  frame.allowFullscreen = true;
  frame.setAttribute("contenteditable", "false");
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

function countListIndentWidth(indent: string): number {
  return indent.replace(/\t/g, "  ").length;
}

function listIndentToLevel(indent: string): number {
  return Math.max(1, Math.floor(countListIndentWidth(indent) / 2) + 1);
}

function levelToListIndent(level: number): string {
  return "  ".repeat(Math.max(1, level) - 1);
}

function parseUnorderedListLine(line: string): { level: number; content: string } | null {
  const match = line.match(/^(\s*)-\s+(.*)$/);
  if (!match) {
    return null;
  }
  return {
    level: listIndentToLevel(match[1] ?? ""),
    content: match[2] ?? ""
  };
}

function parseOrderedListLine(line: string): { level: number; marker: number; content: string } | null {
  const match = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
  if (!match) {
    return null;
  }
  const markerRaw = Number(match[2] ?? "1");
  return {
    level: listIndentToLevel(match[1] ?? ""),
    marker: Number.isFinite(markerRaw) ? Math.max(1, Math.floor(markerRaw)) : 1,
    content: match[3] ?? ""
  };
}

function parseHeadingLine(line: string): { level: number; content: string } | null {
  const match = line.match(/^(#{1,6})\s+(.*)$/);
  if (!match) {
    return null;
  }
  return {
    level: match[1]?.length ?? 1,
    content: match[2] ?? ""
  };
}

function isHorizontalRuleLine(line: string): boolean {
  const trimmed = line.trim();
  return /^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed);
}

function parseFencedCodeBlock(
  lines: string[],
  startIndex: number
): { language: string; code: string; nextIndex: number } | null {
  const opening = lines[startIndex]?.match(/^\s*```([^\s`]*)\s*$/);
  if (!opening) {
    return null;
  }
  const language = opening[1] ?? "";
  const codeLines: string[] = [];
  let cursor = startIndex + 1;
  while (cursor < lines.length) {
    if (/^\s*```\s*$/.test(lines[cursor] ?? "")) {
      return {
        language,
        code: codeLines.join("\n"),
        nextIndex: cursor + 1
      };
    }
    codeLines.push(lines[cursor] ?? "");
    cursor += 1;
  }
  return {
    language,
    code: codeLines.join("\n"),
    nextIndex: lines.length
  };
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
    const fencedCode = parseFencedCodeBlock(lines, i);
    if (fencedCode) {
      const codeHtml = fencedCode.code ? escapeHtml(fencedCode.code) : "<br>";
      const languageAttr = escapeHtml(fencedCode.language);
      blocks.push(
        `<pre class="va-notion-block va-notion-code" data-md-kind="code" data-md-lang="${languageAttr}"><code>${codeHtml}</code></pre>`
      );
      i = fencedCode.nextIndex - 1;
      continue;
    }

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
    if (isHorizontalRuleLine(line)) {
      blocks.push(`<div class="va-notion-block va-notion-hr" data-md-kind="hr"><hr></div>`);
      continue;
    }

    const youtubeSource = parseYoutubeSourceFromLine(line);
    if (youtubeSource) {
      blocks.push(youtubeEmbedBlockToHtml(youtubeSource));
      continue;
    }

    const heading = parseHeadingLine(line);
    if (heading) {
      const level = heading.level;
      const content = heading.content ? markdownInlineToHtml(heading.content) : "<br>";
      blocks.push(`<p class="va-notion-block va-notion-heading level-${level}" data-md-kind="heading" data-md-level="${level}">${content}</p>`);
      continue;
    }

    const unordered = parseUnorderedListLine(line);
    if (unordered) {
      const level = unordered.level;
      const content = unordered.content ? markdownInlineToHtml(unordered.content) : "<br>";
      blocks.push(`<p class="va-notion-block va-notion-bullet level-${level}" data-md-kind="bullet" data-md-level="${level}">${content}</p>`);
      continue;
    }

    const ordered = parseOrderedListLine(line);
    if (ordered) {
      const level = ordered.level;
      const marker = ordered.marker;
      const content = ordered.content ? markdownInlineToHtml(ordered.content) : "<br>";
      blocks.push(
        `<p class="va-notion-block va-notion-ordered level-${level}" data-md-kind="ordered" data-md-level="${level}" data-md-marker="${marker}">${content}</p>`
      );
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
  if (element.tagName === "IMG") {
    const source = (element.getAttribute("data-md-src") ?? element.getAttribute("src") ?? "").trim();
    if (!source) {
      return "";
    }
    const alt = (element.getAttribute("alt") ?? "").replaceAll("]", "\\]");
    return `![${alt}](${source})`;
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
    const embedKind = (block.dataset.mdEmbedKind ?? "").trim();
    if (embedKind === "youtube") {
      const source = (block.dataset.mdSrc ?? "").trim();
      if (source) {
        parts.push(source);
        continue;
      }
    }

    const kind = block.dataset.mdKind === "table"
      ? "table"
      : block.dataset.mdKind === "code"
      ? "code"
      : block.dataset.mdKind === "hr"
      ? "hr"
      : block.dataset.mdKind === "bullet"
      ? "bullet"
      : block.dataset.mdKind === "ordered"
      ? "ordered"
      : block.dataset.mdKind === "heading"
        ? "heading"
        : "paragraph";
    if (kind === "table") {
      parts.push(tableBlockToMarkdown(block));
      continue;
    }
    if (kind === "code") {
      const language = (block.dataset.mdLang ?? "").trim();
      const codeElement = block.querySelector("code");
      const codeText = (codeElement?.textContent ?? block.textContent ?? "").replace(/\u00a0/g, " ");
      parts.push(`\`\`\`${language}\n${codeText}\n\`\`\``);
      continue;
    }
    if (kind === "hr") {
      parts.push("---");
      continue;
    }

    const levelRaw = Number(block.dataset.mdLevel || "1");
    const level = Number.isFinite(levelRaw) ? Math.max(1, Math.min(6, Math.floor(levelRaw))) : 1;
    const inline = Array.from(block.childNodes).map((node) => inlineNodeToMarkdown(node)).join("");
    const content = inline.replace(/\n+$/g, "");
    if (kind === "bullet") {
      const indent = levelToListIndent(level);
      parts.push(`${indent}- ${content}`.trimEnd());
    } else if (kind === "ordered") {
      const indent = levelToListIndent(level);
      const markerRaw = Number(block.dataset.mdMarker || "1");
      const marker = Number.isFinite(markerRaw) ? Math.max(1, Math.floor(markerRaw)) : 1;
      parts.push(`${indent}${marker}. ${content}`.trimEnd());
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
    : block.dataset.mdKind === "code" || block.classList.contains("va-notion-code")
    ? "code"
    : block.dataset.mdKind === "hr" || block.classList.contains("va-notion-hr")
    ? "hr"
    : block.dataset.mdKind === "bullet"
    ? "bullet"
    : block.dataset.mdKind === "ordered"
    ? "ordered"
    : block.dataset.mdKind === "heading"
      ? "heading"
      : "paragraph";
  const levelRaw = Number(block.dataset.mdLevel || "1");
  const level = Number.isFinite(levelRaw) ? Math.max(1, Math.min(6, Math.floor(levelRaw))) : 1;
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
  if (kind === "code") {
    delete block.dataset.mdLevel;
    block.className = "va-notion-block va-notion-code";
    let code = block.querySelector("code");
    if (!code) {
      code = document.createElement("code");
      code.textContent = block.textContent ?? "";
      block.innerHTML = "";
      block.appendChild(code);
    }
    return;
  }
  if (kind === "hr") {
    delete block.dataset.mdLevel;
    block.className = "va-notion-block va-notion-hr";
    block.innerHTML = "<hr>";
    return;
  }
  block.className = "va-notion-block";
  const embedKind = (block.dataset.mdEmbedKind ?? "").trim();
  if (kind === "paragraph" && embedKind === "youtube") {
    ensureNotionYoutubeEmbedBlockStructure(block);
    return;
  }
  if (kind === "bullet") {
    block.dataset.mdLevel = String(level);
    block.classList.add("va-notion-bullet", `level-${level}`);
    block.style.setProperty("--va-list-level", String(level));
  } else if (kind === "ordered") {
    const markerRaw = Number(block.dataset.mdMarker || "1");
    const marker = Number.isFinite(markerRaw) ? Math.max(1, Math.floor(markerRaw)) : 1;
    block.dataset.mdLevel = String(level);
    block.dataset.mdMarker = String(marker);
    block.classList.add("va-notion-ordered", `level-${level}`);
    block.style.setProperty("--va-list-level", String(level));
    block.style.setProperty("--va-order-marker", `"${marker}."`);
  } else if (kind === "heading") {
    block.dataset.mdLevel = String(level);
    block.classList.add("va-notion-heading", `level-${level}`);
    block.style.removeProperty("--va-list-level");
    block.style.removeProperty("--va-order-marker");
  } else {
    delete block.dataset.mdLevel;
    delete block.dataset.mdMarker;
    block.style.removeProperty("--va-list-level");
    block.style.removeProperty("--va-order-marker");
  }
}

export function createNotionBlock(kind: "paragraph" | "bullet" | "ordered" | "heading", level = 1, marker = 1): HTMLParagraphElement {
  const block = document.createElement("p");
  block.dataset.mdKind = kind;
  if (kind === "bullet" || kind === "ordered" || kind === "heading") {
    block.dataset.mdLevel = String(Math.max(1, Math.min(6, Math.floor(level))));
  }
  if (kind === "ordered") {
    block.dataset.mdMarker = String(Math.max(1, Math.floor(marker)));
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
