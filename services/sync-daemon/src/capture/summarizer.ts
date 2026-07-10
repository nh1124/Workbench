import { DEFAULT_CAPTURE_CATEGORY_MAP } from "./storage.js";
import type { CaptureFocusBlock, CaptureSample, CaptureSummaryMetrics } from "./types.js";

const FOCUS_BLOCK_MINIMUM_SECONDS = 15 * 60;

type CaptureSession = {
  startAt: string;
  lastSampledAt: string;
  lastTimestamp: number;
  app: string;
  title: string;
  activeSeconds: number;
};

type NormalizedSample = {
  sample: CaptureSample;
  app: string;
  title: string;
  timestamp: number;
  index: number;
};

export type CaptureSummaryAnalysis = {
  markdown: string;
  metrics: CaptureSummaryMetrics;
};

function increment(map: Map<string, number>, key: string, amount = 1): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function sortedCounts(map: Map<string, number>): Array<{ key: string; count: number }> {
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function sortedRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
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

function timestamp(sampledAt: string): number {
  const value = new Date(sampledAt).getTime();
  return Number.isNaN(value) ? Number.NaN : value;
}

function sampleApp(sample: CaptureSample): string {
  return sample.processName.trim() || "(unknown)";
}

function sampleTitle(sample: CaptureSample): string {
  return sample.windowTitle.trim() || "(untitled)";
}

function categoryForApp(app: string, categoryMap: Record<string, string>): string {
  const normalizedApp = app.trim().toLocaleLowerCase();
  for (const [processName, category] of Object.entries(categoryMap)) {
    if (processName.trim().toLocaleLowerCase() === normalizedApp) return category.trim() || "Other";
  }
  return "Other";
}

function formatTime(sampledAt: string): string {
  const date = new Date(sampledAt);
  if (Number.isNaN(date.getTime())) return sampledAt;
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

function sessionEndAt(session: CaptureSession, intervalSeconds: number): string {
  if (Number.isNaN(session.lastTimestamp)) return session.lastSampledAt;
  return new Date(session.lastTimestamp + intervalSeconds * 1000).toISOString();
}

function buildSessions(samples: NormalizedSample[], intervalSeconds: number): CaptureSession[] {
  const sessions: CaptureSession[] = [];
  let current: CaptureSession | undefined;
  const maximumGapMs = intervalSeconds * 2 * 1000;

  for (const entry of samples) {
    if (entry.sample.idle) {
      current = undefined;
      continue;
    }
    const gapMs = current ? entry.timestamp - current.lastTimestamp : Number.NaN;
    const canContinue = Boolean(
      current
      && current.app === entry.app
      && current.title === entry.title
      && !Number.isNaN(gapMs)
      && gapMs >= 0
      && gapMs <= maximumGapMs
    );
    if (canContinue && current) {
      current.lastSampledAt = entry.sample.sampledAt;
      current.lastTimestamp = entry.timestamp;
      current.activeSeconds += intervalSeconds;
      continue;
    }
    current = {
      startAt: entry.sample.sampledAt,
      lastSampledAt: entry.sample.sampledAt,
      lastTimestamp: entry.timestamp,
      app: entry.app,
      title: entry.title,
      activeSeconds: intervalSeconds
    };
    sessions.push(current);
  }
  return sessions;
}

function focusBlocksForSessions(sessions: CaptureSession[], intervalSeconds: number): CaptureFocusBlock[] {
  return sessions
    .filter((session) => session.activeSeconds >= FOCUS_BLOCK_MINIMUM_SECONDS)
    .map((session) => ({
      startAt: session.startAt,
      endAt: sessionEndAt(session, intervalSeconds),
      app: session.app,
      title: session.title,
      activeSeconds: session.activeSeconds
    }));
}

export function analyzeCaptureSummary(
  summaryDate: string,
  samples: CaptureSample[],
  intervalSeconds: number,
  categoryMap: Record<string, string> = DEFAULT_CAPTURE_CATEGORY_MAP
): CaptureSummaryAnalysis {
  const normalizedIntervalSeconds = Math.max(1, Math.floor(intervalSeconds));
  const normalizedSamples = samples
    .map((sample, index) => ({
      sample,
      app: sampleApp(sample),
      title: sampleTitle(sample),
      timestamp: timestamp(sample.sampledAt),
      index
    }))
    .sort((left, right) => {
      if (Number.isNaN(left.timestamp) || Number.isNaN(right.timestamp)) return left.index - right.index;
      return left.timestamp - right.timestamp || left.index - right.index;
    });
  const activeSamples = normalizedSamples.filter((entry) => !entry.sample.idle);
  const appCounts = new Map<string, number>();
  const appSeconds = new Map<string, number>();
  const categorySeconds = new Map<string, number>();
  const titleCounts = new Map<string, number>();
  const hourlyAppCounts = new Map<string, Map<string, number>>();
  let contextSwitches = 0;
  let previousApp: string | undefined;

  for (const entry of activeSamples) {
    increment(appCounts, entry.app);
    increment(appSeconds, entry.app, normalizedIntervalSeconds);
    increment(categorySeconds, categoryForApp(entry.app, categoryMap), normalizedIntervalSeconds);
    increment(titleCounts, entry.title);
    if (previousApp !== undefined && previousApp !== entry.app) contextSwitches += 1;
    previousApp = entry.app;

    const hour = hourKey(entry.sample.sampledAt);
    const hourMap = hourlyAppCounts.get(hour) ?? new Map<string, number>();
    increment(hourMap, entry.app);
    hourlyAppCounts.set(hour, hourMap);
  }

  const sessions = buildSessions(normalizedSamples, normalizedIntervalSeconds);
  const metrics: CaptureSummaryMetrics = {
    activeSeconds: activeSamples.length * normalizedIntervalSeconds,
    idleSeconds: (samples.length - activeSamples.length) * normalizedIntervalSeconds,
    contextSwitches,
    focusBlocks: focusBlocksForSessions(sessions, normalizedIntervalSeconds),
    categories: sortedRecord(categorySeconds),
    apps: sortedRecord(appSeconds)
  };

  if (samples.length === 0) {
    return {
      markdown: `# Capture Daily Summary ${summaryDate}\n\nNo samples recorded.\n`,
      metrics
    };
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
    lines.push(`| ${escapeCell(item.key)} | ${formatDuration(item.count * normalizedIntervalSeconds)} | ${item.count} |`);
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

  lines.push(
    "",
    "## Focus Blocks",
    "",
    "| Start - End | App | Window Title | Active Time |",
    "|---|---|---|---:|"
  );
  for (const focusBlock of metrics.focusBlocks) {
    lines.push(
      `| ${formatTime(focusBlock.startAt)} - ${formatTime(focusBlock.endAt)} | ${escapeCell(focusBlock.app)} | ${escapeCell(focusBlock.title)} | ${formatDuration(focusBlock.activeSeconds)} |`
    );
  }

  lines.push(
    "",
    "## Context Switches",
    "",
    String(metrics.contextSwitches),
    "",
    "## Categories",
    "",
    "| Category | Active Time |",
    "|---|---:|"
  );
  for (const item of sortedCounts(categorySeconds)) {
    lines.push(`| ${escapeCell(item.key)} | ${formatDuration(item.count)} |`);
  }

  lines.push(
    "",
    "## Idle Time",
    "",
    formatDuration(metrics.idleSeconds),
    ""
  );
  return { markdown: lines.join("\n"), metrics };
}

export function buildCaptureSummaryMarkdown(
  summaryDate: string,
  samples: CaptureSample[],
  intervalSeconds: number,
  categoryMap: Record<string, string> = DEFAULT_CAPTURE_CATEGORY_MAP
): string {
  return analyzeCaptureSummary(summaryDate, samples, intervalSeconds, categoryMap).markdown;
}
