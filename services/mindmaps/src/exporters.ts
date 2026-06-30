import type {
  MindmapDocumentBody,
  MindmapDocumentRecord,
  MindmapExportContent,
  MindmapExportFormat,
  MindmapNode
} from "./types.js";

type PositionedNode = {
  node: MindmapNode;
  depth: number;
  x: number;
  y: number;
  parentId?: string;
};

function safeFilename(value: string, fallback: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || fallback
  );
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function flattenTree(root: MindmapNode): PositionedNode[] {
  const positioned: PositionedNode[] = [];
  let row = 0;

  function walk(current: MindmapNode, depth: number, parentId?: string): void {
    const children = current.children ?? [];
    const startRow = row;
    if (children.length === 0 || current.collapsed) {
      row += 1;
    } else {
      for (const child of children) {
        walk(child, depth + 1, current.id);
      }
    }
    const endRow = Math.max(row - 1, startRow);
    positioned.push({
      node: current,
      depth,
      parentId,
      x: 40 + depth * 230,
      y: 48 + ((startRow + endRow) / 2) * 88
    });
  }

  walk(root, 0);
  return positioned;
}

function renderMarkdownNode(node: MindmapNode, depth: number): string[] {
  const prefix = `${"  ".repeat(depth)}- `;
  const lines = [`${prefix}${node.title}`];
  if (node.note?.trim()) {
    lines.push(`${"  ".repeat(depth + 1)}${node.note.trim().replace(/\n/g, `\n${"  ".repeat(depth + 1)}`)}`);
  }
  for (const child of node.children ?? []) {
    lines.push(...renderMarkdownNode(child, depth + 1));
  }
  return lines;
}

function exportMarkdown(document: MindmapDocumentRecord): string {
  const modeLabel = document.mode === "logical_tree" ? "Logical Tree" : "Mindmap";
  const lines = [
    `# ${document.title}`,
    "",
    `Mode: ${modeLabel}`,
    document.description ? `Description: ${document.description}` : undefined,
    document.projectName ? `Project: ${document.projectName}` : undefined,
    "",
    ...renderMarkdownNode(document.body.root, 0),
    ""
  ].filter((line): line is string => line !== undefined);
  return lines.join("\n");
}

function exportJson(document: MindmapDocumentRecord): string {
  return JSON.stringify(
    {
      id: document.id,
      title: document.title,
      description: document.description,
      mode: document.mode,
      projectId: document.projectId,
      projectName: document.projectName,
      body: document.body,
      tags: document.tags,
      version: document.version,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt
    },
    null,
    2
  );
}

function exportSvgBody(body: MindmapDocumentBody, title: string): string {
  const nodes = flattenTree(body.root);
  const width = Math.max(900, ...nodes.map((item) => item.x + 210));
  const height = Math.max(480, ...nodes.map((item) => item.y + 70));
  const accentColor = body.theme?.accentColor ?? "#2563eb";
  const byId = new Map(nodes.map((item) => [item.node.id, item]));
  const lines = nodes
    .filter((item) => item.parentId)
    .map((item) => {
      const parent = byId.get(item.parentId!);
      if (!parent) return "";
      return `<path d="M${parent.x + 150} ${parent.y} C${parent.x + 190} ${parent.y}, ${item.x - 40} ${item.y}, ${item.x} ${item.y}" fill="none" stroke="#94a3b8" stroke-width="2"/>`;
    })
    .filter(Boolean)
    .join("\n");

  const cards = nodes
    .map((item) => {
      const isRoot = item.depth === 0;
      const widthValue = isRoot ? 170 : 190;
      const heightValue = item.node.note ? 70 : 50;
      const fill = isRoot ? accentColor : "#ffffff";
      const stroke = isRoot ? accentColor : "#cbd5e1";
      const textColor = isRoot ? "#ffffff" : "#0f172a";
      const titleText = escapeXml(item.node.title.length > 32 ? `${item.node.title.slice(0, 29)}...` : item.node.title);
      const noteText = item.node.note
        ? `<text x="${item.x + 16}" y="${item.y + 42}" fill="#64748b" font-family="Inter, Segoe UI, sans-serif" font-size="11">${escapeXml(
            item.node.note.length > 36 ? `${item.node.note.slice(0, 33)}...` : item.node.note
          )}</text>`
        : "";
      return `<g>
  <rect x="${item.x}" y="${item.y - 24}" width="${widthValue}" height="${heightValue}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>
  <text x="${item.x + 16}" y="${item.y + 5}" fill="${textColor}" font-family="Inter, Segoe UI, sans-serif" font-size="${isRoot ? 15 : 13}" font-weight="${isRoot ? 700 : 600}">${titleText}</text>
  ${noteText}
</g>`;
    })
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">
  <rect width="100%" height="100%" fill="#f8fafc"/>
  ${lines}
  ${cards}
</svg>`;
}

export function buildMindmapExport(document: MindmapDocumentRecord, format: MindmapExportFormat): MindmapExportContent {
  const basename = safeFilename(document.title, document.mode === "logical_tree" ? "logical-tree" : "mindmap");
  const contentText =
    format === "json" ? exportJson(document) : format === "svg" ? exportSvgBody(document.body, document.title) : exportMarkdown(document);
  const extension = format === "json" ? "json" : format === "svg" ? "svg" : "md";
  const mimeType =
    format === "json" ? "application/json" : format === "svg" ? "image/svg+xml" : "text/markdown; charset=utf-8";

  return {
    documentId: document.id,
    title: document.title,
    mode: document.mode,
    projectId: document.projectId,
    projectName: document.projectName,
    sourceVersion: document.version,
    format,
    filename: `${basename}.${extension}`,
    mimeType,
    contentText,
    contentBase64: Buffer.from(contentText, "utf8").toString("base64")
  };
}
