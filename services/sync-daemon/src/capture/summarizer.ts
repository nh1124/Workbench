import type { CaptureSample } from "./types.js";

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sortedCounts(map: Map<string, number>): Array<{ key: string; count: number }> {
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
  parts.push(`${remainingSeconds}s`);
  return parts.join(" ");
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim() || "(untitled)";
}

function hourKey(sampledAt: string): string {
  const date = new Date(sampledAt);
  if (Number.isNaN(date.getTime())) return sampledAt.slice(0, 13).padEnd(13, "0").slice(11, 13) || "00";
  return String(date.getUTCHours()).padStart(2, "0");
}

export function buildCaptureSummaryMarkdown(
  summaryDate: string,
  samples: CaptureSample[],
  intervalSeconds: number
): string {
  if (samples.length === 0) {
    return `# Capture Daily Summary ${summaryDate}\n\nNo samples recorded.\n`;
  }

  const appCounts = new Map<string, number>();
  const titleCounts = new Map<string, number>();
  const hourlyAppCounts = new Map<string, Map<string, number>>();

  for (const sample of samples) {
    const app = sample.processName.trim() || "(unknown)";
    const title = sample.windowTitle.trim() || "(untitled)";
    increment(appCounts, app);
    increment(titleCounts, title);

    const hour = hourKey(sample.sampledAt);
    const hourMap = hourlyAppCounts.get(hour) ?? new Map<string, number>();
    increment(hourMap, app);
    hourlyAppCounts.set(hour, hourMap);
  }

  const lines: string[] = [
    `# Capture Daily Summary ${summaryDate}`,
    "",
    "## App Activity",
    "",
    "| App | Active Time | Samples |",
    "|---|---:|---:|"
  ];

  for (const item of sortedCounts(appCounts)) {
    lines.push(`| ${escapeCell(item.key)} | ${formatDuration(item.count * intervalSeconds)} | ${item.count} |`);
  }

  lines.push(
    "",
    "## Top Window Titles",
    "",
    "| Window Title | Count |",
    "|---|---:|"
  );
  for (const item of sortedCounts(titleCounts).slice(0, 10)) {
    lines.push(`| ${escapeCell(item.key)} | ${item.count} |`);
  }

  lines.push(
    "",
    "## Timeline",
    "",
    "| Hour | Primary App | Samples |",
    "|---|---|---:|"
  );
  for (const hour of [...hourlyAppCounts.keys()].sort()) {
    const primary = sortedCounts(hourlyAppCounts.get(hour) ?? new Map())[0];
    if (!primary) continue;
    lines.push(`| ${hour}:00 | ${escapeCell(primary.key)} | ${primary.count} |`);
  }

  lines.push("");
  return lines.join("\n");
}

