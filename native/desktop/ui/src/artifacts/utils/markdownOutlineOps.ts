import type { MarkdownOutlineItem } from "./markdownOutline";

type OutlineInsertKind = "text" | "heading" | "bullet";

interface OutlineOperationResult {
  markdown: string;
  cursorOffset: number;
}

const HEADING_LINE_RE = /^(#{1,6})([ \t]+)(.*)$/;

function clampLevel(level: number): number {
  return Math.max(1, Math.min(6, Math.trunc(level || 1)));
}

function normalizeNewline(markdown: string): string {
  return markdown.replace(/\r\n/g, "\n");
}

function splitLines(markdown: string): string[] {
  return normalizeNewline(markdown).split("\n");
}

function joinLines(lines: string[]): string {
  return lines.join("\n");
}

function findEntryIndex(entries: MarkdownOutlineItem[], entryId: string): number {
  return entries.findIndex((entry) => entry.id === entryId);
}

function findSectionEndLine(entries: MarkdownOutlineItem[], entryIndex: number, totalLines: number): number {
  const current = entries[entryIndex];
  if (!current) {
    return totalLines - 1;
  }

  const currentLine = current.line - 1;
  const currentLevel = current.level;

  for (let i = entryIndex + 1; i < entries.length; i += 1) {
    const candidate = entries[i];
    if (!candidate) continue;
    if (candidate.level <= currentLevel) {
      return Math.max(currentLine, candidate.line - 2);
    }
  }

  return totalLines - 1;
}

function lineStartOffset(lines: string[], lineIndex: number): number {
  const boundedLine = Math.max(0, Math.min(lineIndex, lines.length));
  let offset = 0;
  for (let i = 0; i < boundedLine; i += 1) {
    offset += lines[i]?.length ?? 0;
    if (i < lines.length - 1) {
      offset += 1;
    }
  }
  return offset;
}

function rewriteHeadingLevel(line: string, delta: number): string {
  if (!delta) return line;
  const match = line.match(HEADING_LINE_RE);
  if (!match) {
    return line;
  }

  const currentLevel = clampLevel(match[1]?.length ?? 1);
  const nextLevel = clampLevel(currentLevel + delta);
  return `${"#".repeat(nextLevel)}${match[2] ?? " "}${match[3] ?? ""}`;
}

export function moveOutlineSection(options: {
  markdown: string;
  entries: MarkdownOutlineItem[];
  draggedId: string;
  targetId: string;
  targetLevel: number;
}): string {
  const { markdown, entries, draggedId, targetId, targetLevel } = options;
  const normalized = normalizeNewline(markdown);
  if (!normalized.trim()) return markdown;

  const dragIndex = findEntryIndex(entries, draggedId);
  const targetIndex = findEntryIndex(entries, targetId);
  if (dragIndex < 0 || targetIndex < 0) {
    return markdown;
  }

  const lines = splitLines(normalized);
  if (lines.length === 0) {
    return markdown;
  }

  const dragStart = entries[dragIndex]!.line - 1;
  const dragEnd = findSectionEndLine(entries, dragIndex, lines.length);
  const sectionLength = dragEnd - dragStart + 1;
  if (sectionLength <= 0) {
    return markdown;
  }

  const targetStart = entries[targetIndex]!.line - 1;
  const targetEnd = findSectionEndLine(entries, targetIndex, lines.length);
  const desiredLevel = clampLevel(targetLevel);

  const currentLevel = entries[dragIndex]!.level;
  const levelDelta = desiredLevel - currentLevel;
  const section = lines.slice(dragStart, dragEnd + 1);
  if (section.length > 0 && levelDelta !== 0) {
    // Change only the dragged heading line level.
    section[0] = rewriteHeadingLevel(section[0]!, levelDelta);
  }

  if (draggedId === targetId) {
    return joinLines([...lines.slice(0, dragStart), ...section, ...lines.slice(dragEnd + 1)]);
  }

  if (targetStart >= dragStart && targetStart <= dragEnd) {
    return markdown;
  }

  const remaining = [...lines.slice(0, dragStart), ...lines.slice(dragEnd + 1)];
  let insertAt = targetEnd + 1;
  if (insertAt > dragStart) {
    insertAt -= sectionLength;
  }
  insertAt = Math.max(0, Math.min(insertAt, remaining.length));

  const nextLines = [...remaining.slice(0, insertAt), ...section, ...remaining.slice(insertAt)];
  return joinLines(nextLines);
}

export function insertBelowOutlineEntry(options: {
  markdown: string;
  entries: MarkdownOutlineItem[];
  entryId: string;
  kind: OutlineInsertKind;
}): OutlineOperationResult {
  const { markdown, entries, entryId, kind } = options;
  const normalized = normalizeNewline(markdown);
  const lines = splitLines(normalized);

  const entryIndex = findEntryIndex(entries, entryId);
  if (entryIndex < 0 || lines.length === 0) {
    const fallback = normalized;
    return { markdown: fallback, cursorOffset: fallback.length };
  }

  const entry = entries[entryIndex]!;
  const sectionEnd = findSectionEndLine(entries, entryIndex, lines.length);
  const insertAt = Math.max(0, Math.min(sectionEnd + 1, lines.length));

  const insertedLine =
    kind === "text"
      ? "# New heading"
      : kind === "heading"
      ? `${"#".repeat(clampLevel(entry.level))} New heading`
      : kind === "bullet"
        ? "- New item"
        : "New content";

  const insertion = ["", insertedLine];
  const nextLines = [...lines.slice(0, insertAt), ...insertion, ...lines.slice(insertAt)];

  const cursorLineIndex = insertAt + 1;
  const cursorOffset = lineStartOffset(nextLines, cursorLineIndex);
  return {
    markdown: joinLines(nextLines),
    cursorOffset
  };
}
