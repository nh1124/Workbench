export interface MarkdownOutlineItem {
  id: string;
  level: number;
  title: string;
  line: number;
  startOffset: number;
  headingIndex: number;
}

const HEADING_RE = /^(#{1,6})[ \t]+(.+?)\s*#*\s*$/;

export function parseMarkdownOutline(markdown: string): MarkdownOutlineItem[] {
  if (!markdown.trim()) {
    return [];
  }

  const lines = markdown.split("\n");
  const outline: MarkdownOutlineItem[] = [];
  let cursor = 0;
  let headingIndex = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(HEADING_RE);
    if (match) {
      const level = match[1]?.length ?? 1;
      const rawTitle = (match[2] ?? "").trim();
      const title = rawTitle || "(Untitled heading)";
      outline.push({
        id: `${i}-${cursor}-${level}`,
        level,
        title,
        line: i + 1,
        startOffset: cursor,
        headingIndex
      });
      headingIndex += 1;
    }

    cursor += line.length;
    if (i < lines.length - 1) {
      cursor += 1;
    }
  }

  return outline;
}
