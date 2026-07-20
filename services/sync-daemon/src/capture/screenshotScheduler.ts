import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CaptureConfig, CaptureLogger, CaptureSample } from "./types.js";
import { WINDOWS_SCREENSHOT_SCRIPT } from "./windowsScreenshotScript.js";

type SpawnImpl = typeof spawn;

export type ScreenshotSchedulerOptions = {
  platform?: NodeJS.Platform;
  logger?: CaptureLogger;
  spawnImpl?: SpawnImpl;
  scriptPath?: string;
  screenshotsDir: string;
  getConfig: () => CaptureConfig;
  getLastForeground: () => CaptureSample | undefined;
  onCaptured: (input: { capturedAt: string; filePath: string; processName: string; windowTitle: string }) => void;
};

function moduleDirname(): string | undefined {
  try { return typeof import.meta.url === "string" ? dirname(fileURLToPath(import.meta.url)) : undefined; } catch { return undefined; }
}

function scriptPath(explicit?: string): string {
  const ownDir = moduleDirname();
  const candidates = [explicit, ownDir ? join(ownDir, "windowsScreenshot.ps1") : undefined, ownDir ? resolve(ownDir, "../../src/capture/windowsScreenshot.ps1") : undefined, resolve(process.cwd(), "src/capture/windowsScreenshot.ps1"), resolve(process.cwd(), "services/sync-daemon/src/capture/windowsScreenshot.ps1")];
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  const fallback = join(tmpdir(), "workbench-capture-windowsScreenshot.ps1");
  writeFileSync(fallback, WINDOWS_SCREENSHOT_SCRIPT, "utf8");
  return fallback;
}

export function shouldCaptureScreenshot(config: CaptureConfig, foreground?: CaptureSample, logger?: CaptureLogger): boolean {
  if (!config.enabled || !config.screenshotsEnabled || !foreground) return false;
  const target = `${foreground.processName}\n${foreground.windowTitle}`;
  return !config.excludePatterns.some((source) => {
    try { return new RegExp(source, "i").test(target); } catch (error) { logger?.warn("[capture] ignoring invalid exclude pattern", { pattern: source, message: error instanceof Error ? error.message : String(error) }); return false; }
  });
}

export class ScreenshotScheduler {
  private readonly options: ScreenshotSchedulerOptions;
  private timer?: ReturnType<typeof setInterval>;
  private child?: ChildProcess;

  constructor(options: ScreenshotSchedulerOptions) { this.options = options; }

  get active(): boolean {
    return Boolean(this.timer);
  }

  start(): void {
    this.stop();
    const config = this.options.getConfig();
    if ((this.options.platform ?? process.platform) !== "win32" || !config.enabled || !config.screenshotsEnabled) return;
    this.timer = setInterval(() => { void this.captureOnce(); }, config.screenshotIntervalSeconds * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.child) { try { this.child.kill(); } catch { /* process may already have exited */ } }
    this.child = undefined;
  }

  async captureOnce(now = new Date()): Promise<boolean> {
    if (this.child) return false;
    const config = this.options.getConfig();
    const foreground = this.options.getLastForeground();
    if (!shouldCaptureScreenshot(config, foreground, this.options.logger) || !foreground) return false;
    const capturedAt = now.toISOString();
    const dayDir = join(this.options.screenshotsDir, capturedAt.slice(0, 10));
    mkdirSync(dayDir, { recursive: true });
    const filePath = join(dayDir, `${capturedAt.slice(11, 19).replaceAll(":", "")}.png`);
    return await new Promise<boolean>((resolveResult) => {
      const child = this.options.spawnImpl?.("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath(this.options.scriptPath), filePath], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true })
        ?? spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath(this.options.scriptPath), filePath], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      this.child = child;
      child.stderr?.on("data", (chunk) => this.options.logger?.warn("[capture] screenshot stderr", { message: String(chunk).trim() }));
      child.on("error", (error) => { this.options.logger?.warn("[capture] screenshot process error", { message: error.message }); });
      child.on("close", (code) => {
        this.child = undefined;
        if (code === 0 && existsSync(filePath)) {
          this.options.onCaptured({ capturedAt, filePath, processName: foreground.processName, windowTitle: foreground.windowTitle });
          resolveResult(true);
        } else { resolveResult(false); }
      });
    });
  }
}
