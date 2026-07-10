import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { CaptureConfig, CaptureLogger, CaptureSample } from "./types.js";
import { DEFAULT_CAPTURE_IDLE_THRESHOLD_SECONDS } from "./storage.js";
import { WINDOWS_SAMPLER_SCRIPT } from "./windowsSamplerScript.js";

type SpawnImpl = typeof spawn;

export type CaptureSupervisorOptions = {
  platform?: NodeJS.Platform;
  logger?: CaptureLogger;
  spawnImpl?: SpawnImpl;
  samplerScriptPath?: string;
  onSample: (sample: CaptureSample) => void | Promise<void>;
};

export class CaptureError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "CAPTURE_ERROR"
  ) {
    super(message);
  }
}

function moduleDirname(): string | undefined {
  // In the bundled CJS/SEA sidecar import.meta.url is unavailable; fall back
  // to the embedded sampler script instead of crashing at module load.
  try {
    if (typeof import.meta.url === "string" && import.meta.url.length > 0) {
      return dirname(fileURLToPath(import.meta.url));
    }
  } catch {
    // ignore and use the embedded fallback
  }
  return undefined;
}

function resolveBundledSamplerPath(explicitPath?: string): string {
  const ownDir = moduleDirname();
  const candidates = [
    explicitPath,
    ownDir ? join(ownDir, "windowsSampler.ps1") : undefined,
    ownDir ? resolve(ownDir, "../../src/capture/windowsSampler.ps1") : undefined,
    resolve(process.cwd(), "src/capture/windowsSampler.ps1"),
    resolve(process.cwd(), "services/sync-daemon/src/capture/windowsSampler.ps1")
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  const fallback = join(tmpdir(), "workbench-capture-windowsSampler.ps1");
  writeFileSync(fallback, WINDOWS_SAMPLER_SCRIPT, "utf8");
  return fallback;
}

function parseSamplerRecord(value: unknown, idleThresholdSeconds: number): CaptureSample | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.sampledAt !== "string") return undefined;
  if (typeof record.processName !== "string") return undefined;
  if (typeof record.windowTitle !== "string") return undefined;
  const idleSeconds = typeof record.idleSeconds === "number" && Number.isFinite(record.idleSeconds) && record.idleSeconds >= 0
    ? record.idleSeconds
    : 0;
  return {
    sampledAt: record.sampledAt,
    processName: record.processName,
    windowTitle: record.windowTitle,
    idle: idleSeconds >= idleThresholdSeconds
  };
}

export async function ingestSamplerLine(
  line: string,
  onSample: (sample: CaptureSample) => void | Promise<void>,
  logger?: CaptureLogger,
  idleThresholdSeconds = DEFAULT_CAPTURE_IDLE_THRESHOLD_SECONDS
): Promise<boolean> {
  const trimmed = line.trim();
  if (!trimmed) return false;
  try {
    const sample = parseSamplerRecord(JSON.parse(trimmed) as unknown, idleThresholdSeconds);
    if (!sample) {
      logger?.warn("[capture] skipped malformed sampler record");
      return false;
    }
    await onSample(sample);
    return true;
  } catch (error) {
    logger?.warn("[capture] skipped malformed sampler line", {
      message: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}

export function decodeSamplerStdoutChunk(decoder: StringDecoder, chunk: Buffer | string): string {
  return typeof chunk === "string" ? chunk : decoder.write(chunk);
}

export class CaptureSupervisor {
  private readonly platform: NodeJS.Platform;
  private readonly logger?: CaptureLogger;
  private readonly spawnImpl: SpawnImpl;
  private readonly samplerScriptPath?: string;
  private readonly onSample: (sample: CaptureSample) => void | Promise<void>;
  private child?: ChildProcess;
  private stdoutBuffer = "";
  private stdoutDecoder = new StringDecoder("utf8");
  private stopping = false;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private restartDelayMs = 5000;
  private config?: CaptureConfig;

  constructor(options: CaptureSupervisorOptions) {
    this.platform = options.platform ?? process.platform;
    this.logger = options.logger;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.samplerScriptPath = options.samplerScriptPath;
    this.onSample = options.onSample;
  }

  get alive(): boolean {
    return Boolean(this.child && !this.child.killed);
  }

  async start(config: CaptureConfig): Promise<void> {
    if (this.platform !== "win32") {
      throw new CaptureError("Capture collector is only supported on Windows in this release.", 400, "CAPTURE_UNSUPPORTED_OS");
    }
    this.config = config;
    this.stopping = false;
    if (this.child) return;
    this.spawnCollector();
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    const child = this.child;
    this.child = undefined;
    this.stdoutBuffer = "";
    this.stdoutDecoder = new StringDecoder("utf8");
    if (!child) return;
    try {
      child.kill();
    } catch (error) {
      this.logger?.warn("[capture] failed to stop sampler", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async restart(config: CaptureConfig): Promise<void> {
    this.stop();
    await this.start(config);
  }

  private spawnCollector(): void {
    const config = this.config;
    if (!config) return;
    const scriptPath = resolveBundledSamplerPath(this.samplerScriptPath);
    this.stdoutBuffer = "";
    this.stdoutDecoder = new StringDecoder("utf8");
    const child = this.spawnImpl(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        String(config.intervalSeconds)
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    this.child = child;
    this.restartDelayMs = 5000;

    child.stdout?.on("data", (chunk: Buffer | string) => {
      this.handleStdoutChunk(decodeSamplerStdoutChunk(this.stdoutDecoder, chunk));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (text.trim()) this.logger?.warn("[capture] sampler stderr", { message: text.trim() });
    });
    child.on("error", (error) => {
      this.logger?.warn("[capture] sampler process error", {
        message: error instanceof Error ? error.message : String(error)
      });
    });
    child.on("close", () => {
      const remainingStdout = this.stdoutDecoder.end();
      if (remainingStdout) this.handleStdoutChunk(remainingStdout);
      this.stdoutBuffer = "";
      this.stdoutDecoder = new StringDecoder("utf8");
      this.child = undefined;
      if (!this.stopping && this.config?.enabled) {
        this.scheduleRestart();
      }
    });
  }

  private scheduleRestart(): void {
    if (this.restartTimer || !this.config) return;
    const delay = this.restartDelayMs;
    this.restartDelayMs = Math.min(this.restartDelayMs * 2, 60000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      try {
        if (!this.stopping && this.config?.enabled) {
          this.spawnCollector();
        }
      } catch (error) {
        this.logger?.warn("[capture] sampler restart failed", {
          message: error instanceof Error ? error.message : String(error)
        });
        this.scheduleRestart();
      }
    }, delay);
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newlineIndex = this.stdoutBuffer.search(/\r?\n/);
      if (newlineIndex === -1) break;
      const line = this.stdoutBuffer.slice(0, newlineIndex);
      const newlineLength = this.stdoutBuffer[newlineIndex] === "\r" && this.stdoutBuffer[newlineIndex + 1] === "\n" ? 2 : 1;
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + newlineLength);
      void ingestSamplerLine(line, this.onSample, this.logger, this.config?.idleThresholdSeconds).catch((error) => {
        this.logger?.warn("[capture] sampler line handling failed", {
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }
  }
}

