import { statSync, watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import type { ServerCapturePolicy } from "./serverPolicy.js";
import type { CaptureLogger } from "./types.js";

export type LocalFileEvent = {
  eventType: "created" | "modified" | "deleted";
  root: string;
  relativePath: string;
  mtime?: string;
  size?: number;
  observedAt: string;
};

export function isLocalFilePathAllowed(
  root: string,
  relativePath: string,
  policy: Pick<ServerCapturePolicy, "localRootDeny" | "excludePatterns">,
  logger?: CaptureLogger
): boolean {
  const absolutePath = resolve(root, relativePath);
  const comparablePath = process.platform === "win32" ? absolutePath.toLowerCase() : absolutePath;
  if (policy.localRootDeny.some((entry) => {
    const deniedPath = resolve(entry);
    return comparablePath.startsWith(process.platform === "win32" ? deniedPath.toLowerCase() : deniedPath);
  })) return false;
  for (const pattern of policy.excludePatterns) {
    try {
      if (new RegExp(pattern, "i").test(relativePath)) return false;
    } catch (error) {
      logger?.warn("[capture] invalid local file exclude pattern ignored", {
        pattern,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return true;
}

export type FileWatcherOptions = {
  getPolicy: () => ServerCapturePolicy | null;
  getEnabled: () => boolean;
  logger?: CaptureLogger;
  maxBufferedEvents?: number;
  now?: () => Date;
  watchImpl?: typeof watch;
};

export class FileWatcher {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly buffer: LocalFileEvent[] = [];
  private readonly lastObservedAt = new Map<string, number>();
  private readonly maxBufferedEvents: number;
  private readonly now: () => Date;
  private readonly watchImpl: typeof watch;

  constructor(private readonly options: FileWatcherOptions) {
    this.maxBufferedEvents = Math.max(1, Math.trunc(options.maxBufferedEvents ?? 5000));
    this.now = options.now ?? (() => new Date());
    this.watchImpl = options.watchImpl ?? watch;
  }

  sync(): void {
    if (!this.options.getEnabled()) {
      this.stop();
      return;
    }
    const policy = this.options.getPolicy();
    const desiredRoots = new Set(policy?.localRootAllow ?? []);
    for (const [root, watcher] of this.watchers) {
      if (!desiredRoots.has(root)) {
        watcher.close();
        this.watchers.delete(root);
      }
    }
    for (const root of desiredRoots) {
      if (this.watchers.has(root)) continue;
      try {
        const watcher = this.watchImpl(root, { recursive: true }, (_eventType, filename) => {
          this.handleRawEvent(root, filename);
        });
        this.watchers.set(root, watcher);
        if (typeof (watcher as { on?: unknown }).on === "function") {
          watcher.on("error", (error) => {
            this.options.logger?.warn("[capture] file watcher error", {
              root,
              message: error instanceof Error ? error.message : String(error)
            });
            try {
              watcher.close();
            } catch {}
            this.watchers.delete(root);
          });
        }
      } catch (error) {
        this.options.logger?.warn("[capture] local file root could not be watched", {
          root,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  drain(): LocalFileEvent[] {
    const events = this.buffer.splice(0);
    this.lastObservedAt.clear();
    return events;
  }

  requeue(events: LocalFileEvent[]): void {
    if (events.length === 0) return;
    this.buffer.unshift(...events);
    if (this.buffer.length > this.maxBufferedEvents) {
      this.buffer.splice(0, this.buffer.length - this.maxBufferedEvents);
    }
  }

  stop(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.buffer.splice(0);
    this.lastObservedAt.clear();
  }

  private handleRawEvent(root: string, filename: string | Buffer | null): void {
    if (!filename || !this.options.getEnabled()) return;
    const policy = this.options.getPolicy();
    if (!policy?.localRootAllow.includes(root)) return;
    const relativePath = filename.toString();
    if (!relativePath || !isLocalFilePathAllowed(root, relativePath, policy, this.options.logger)) return;
    let eventType: LocalFileEvent["eventType"] = "modified";
    let mtime: string | undefined;
    let size: number | undefined;
    try {
      const stat = statSync(resolve(root, relativePath));
      mtime = stat.mtime.toISOString();
      size = stat.size;
    } catch {
      eventType = "deleted";
    }
    const observed = this.now();
    const event: LocalFileEvent = {
      eventType,
      root,
      relativePath,
      ...(mtime ? { mtime } : {}),
      ...(size === undefined ? {} : { size }),
      observedAt: observed.toISOString()
    };
    const key = `${root}\0${relativePath}`;
    const previousAt = this.lastObservedAt.get(key);
    if (previousAt !== undefined && observed.getTime() - previousAt <= 500) {
      for (let index = this.buffer.length - 1; index >= 0; index -= 1) {
        const candidate = this.buffer[index];
        if (candidate.root === root && candidate.relativePath === relativePath) {
          this.buffer[index] = event;
          this.lastObservedAt.set(key, observed.getTime());
          return;
        }
      }
    }
    this.buffer.push(event);
    this.lastObservedAt.set(key, observed.getTime());
    if (this.buffer.length > this.maxBufferedEvents) this.buffer.shift();
  }
}
