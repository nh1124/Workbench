import { orderWbsItems } from "./rollup.js";
import type {
  WbsDependencyRecord,
  WbsExportContent,
  WbsExportFormat,
  WbsItemRecord,
  WbsPlanRecord
} from "./types.js";

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

function csvCell(value: string | number | undefined): string {
  const text = value === undefined ? "" : String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function mdEscape(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function depthForCode(code: string): number {
  return code ? code.split(".").length - 1 : 0;
}

function renderMarkdown(plan: WbsPlanRecord, items: WbsItemRecord[], dependencies: WbsDependencyRecord[]): string {
  const orderedItems = orderWbsItems(items);
  const itemById = new Map(orderedItems.map((item) => [item.id, item]));
  const lines = [
    `# ${plan.title}`,
    "",
    "Source service: wbs",
    `Source plan id: ${plan.id}`,
    `Source version: ${plan.version}`,
    `Exported at: ${new Date().toISOString()}`,
    plan.projectName ? `Project: ${plan.projectName}` : undefined,
    plan.description ? `Description: ${plan.description}` : undefined,
    "",
    "## Work Breakdown Structure",
    ""
  ].filter((line): line is string => line !== undefined);

  for (const item of orderedItems) {
    const depth = depthForCode(item.code);
    const suffixParts = [
      item.ownerLabel ? `owner: ${item.ownerLabel}` : undefined,
      item.effortHours !== undefined ? `effort: ${item.effortHours}h` : undefined,
      `status: ${item.status}`,
      `progress: ${item.rollup?.progress ?? item.progress ?? 0}%`
    ].filter(Boolean);
    lines.push(`${"  ".repeat(depth)}- ${item.code} ${item.title}${suffixParts.length > 0 ? ` (${suffixParts.join(", ")})` : ""}`);
    if (item.description.trim()) {
      lines.push(`${"  ".repeat(depth + 1)}${item.description.trim().replace(/\n/g, `\n${"  ".repeat(depth + 1)}`)}`);
    }
  }

  if (dependencies.length > 0) {
    lines.push("", "## Dependencies", "");
    for (const dependency of dependencies) {
      const from = itemById.get(dependency.fromItemId);
      const to = itemById.get(dependency.toItemId);
      lines.push(
        `- ${from?.code ?? dependency.fromItemId} -> ${to?.code ?? dependency.toItemId} (${dependency.dependencyType}, lag ${dependency.lagDays}d)`
      );
    }
  }

  lines.push("");
  return lines.join("\n");
}

function renderCsv(items: WbsItemRecord[]): string {
  const orderedItems = orderWbsItems(items);
  const itemById = new Map(orderedItems.map((item) => [item.id, item]));
  const rows: Array<Array<string | number | undefined>> = [
    [
      "Code",
      "Title",
      "Parent Code",
      "Owner",
      "Status",
      "Start",
      "Due",
      "Effort Hours",
      "Progress",
      "Description"
    ]
  ];

  for (const item of orderedItems) {
    rows.push([
      item.code,
      item.title,
      item.parentId ? itemById.get(item.parentId)?.code ?? "" : "",
      item.ownerLabel ?? "",
      item.status,
      item.startDate ?? "",
      item.dueDate ?? "",
      item.rollup?.effortHours ?? item.effortHours ?? "",
      item.rollup?.progress ?? item.progress ?? "",
      item.description
    ]);
  }

  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function renderJson(plan: WbsPlanRecord, items: WbsItemRecord[], dependencies: WbsDependencyRecord[]): string {
  return JSON.stringify(
    {
      sourceService: "wbs",
      sourcePlanId: plan.id,
      sourceVersion: plan.version,
      exportedAt: new Date().toISOString(),
      plan,
      items: orderWbsItems(items),
      dependencies
    },
    null,
    2
  );
}

export function buildWbsExport(
  plan: WbsPlanRecord,
  items: WbsItemRecord[],
  dependencies: WbsDependencyRecord[],
  format: WbsExportFormat
): WbsExportContent {
  const basename = safeFilename(plan.title, "wbs-plan");
  const contentText =
    format === "json" ? renderJson(plan, items, dependencies) : format === "csv" ? renderCsv(items) : renderMarkdown(plan, items, dependencies);
  const extension = format === "json" ? "json" : format === "csv" ? "csv" : "md";
  const mimeType =
    format === "json"
      ? "application/json"
      : format === "csv"
        ? "text/csv; charset=utf-8"
        : "text/markdown; charset=utf-8";

  return {
    planId: plan.id,
    title: plan.title,
    projectId: plan.projectId,
    projectName: plan.projectName,
    sourceVersion: plan.version,
    format,
    filename: `${basename}.${extension}`,
    mimeType,
    contentText,
    contentBase64: Buffer.from(contentText, "utf8").toString("base64")
  };
}

export function renderWbsMarkdownForTest(
  plan: WbsPlanRecord,
  items: WbsItemRecord[],
  dependencies: WbsDependencyRecord[] = []
): string {
  return renderMarkdown(plan, items, dependencies);
}
