// Workbench shared logger (LG-D1..D3, docs/imple/logging-foundation-plan.md).
// Zero-dependency plain ESM so it can be consumed as-is by tsx dev processes,
// tsc-built services, and the artifacts Docker image without a build step.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const DEFAULT_RETENTION_DAYS = 14;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

function envLevel() {
  const raw = (process.env.LOG_LEVEL || "").toLowerCase();
  return LEVELS[raw] ? raw : "info";
}

function consoleMirrorEnabled() {
  return process.env.WORKBENCH_LOG_CONSOLE !== "0";
}

// Repo root = nearest ancestor whose package.json declares npm workspaces.
// Services run with cwd at their own workspace dir; root scripts run at repo root.
function findRepoRoot(startDir) {
  let dir = startDir;
  for (;;) {
    const pkgPath = path.join(dir, "package.json");
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg && pkg.workspaces) return dir;
    } catch {
      // no package.json here or unreadable — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
}

function resolveLogDir(explicitDir) {
  if (explicitDir) return explicitDir;
  if (process.env.WORKBENCH_LOG_DIR) return process.env.WORKBENCH_LOG_DIR;
  return path.join(findRepoRoot(process.cwd()), "logs");
}

function dateStamp(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function serializeValue(value) {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function serializeFields(fields) {
  if (!fields) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = serializeValue(value);
  }
  return out;
}

// Logging must never take the service down (LG-D1): every fs interaction is
// wrapped, and on failure the writer disables itself after one stderr warning.
class LogFileWriter {
  constructor(dir, service, retentionDays) {
    this.dir = dir;
    this.service = service;
    this.retentionDays = retentionDays;
    this.stream = null;
    this.streamDate = null;
    this.disabled = false;
    this.cleanup();
    const timer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    if (typeof timer.unref === "function") timer.unref();
  }

  filePath(stamp) {
    return path.join(this.dir, `${this.service}-${stamp}.jsonl`);
  }

  disable(error) {
    if (this.disabled) return;
    this.disabled = true;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[workbench-logging] file output disabled for "${this.service}" (${message}); continuing with console mirror only\n`
    );
  }

  ensureStream() {
    const stamp = dateStamp();
    if (this.stream && this.streamDate === stamp) return this.stream;
    try {
      if (this.stream) this.stream.end();
      fs.mkdirSync(this.dir, { recursive: true });
      this.stream = fs.createWriteStream(this.filePath(stamp), { flags: "a" });
      this.stream.on("error", (error) => this.disable(error));
      this.streamDate = stamp;
      this.cleanup();
      return this.stream;
    } catch (error) {
      this.disable(error);
      return null;
    }
  }

  write(line) {
    if (this.disabled) return;
    const stream = this.ensureStream();
    if (stream) stream.write(line + "\n");
  }

  // Fatal path: bypass the async stream so the record survives process death.
  writeSync(line) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.filePath(dateStamp()), line + "\n");
    } catch {
      // stderr still gets the mirror line; nothing else we can do
    }
  }

  cleanup() {
    try {
      const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
      const pattern = new RegExp(
        `^${this.service.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d{4}-\\d{2}-\\d{2})\\.jsonl$`
      );
      for (const entry of fs.readdirSync(this.dir)) {
        const match = pattern.exec(entry);
        if (!match) continue;
        if (new Date(`${match[1]}T00:00:00Z`).getTime() < cutoff) {
          fs.rmSync(path.join(this.dir, entry), { force: true });
        }
      }
    } catch {
      // logs dir may not exist yet; retention is best-effort
    }
  }
}

function mirrorLine(record) {
  const time = record.ts.slice(11, 23);
  const extras = { ...record };
  delete extras.ts;
  delete extras.level;
  delete extras.service;
  delete extras.msg;
  const suffix = Object.keys(extras).length > 0 ? ` ${JSON.stringify(extras)}` : "";
  return `${time} ${record.level.toUpperCase().padEnd(5)} [${record.service}] ${record.msg}${suffix}\n`;
}

function makeLogger(service, writer, bindings, options) {
  const threshold = LEVELS[options.level];

  function emit(level, msg, fields, sync) {
    if (LEVELS[level] < threshold) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      service,
      msg,
      ...bindings,
      ...serializeFields(fields)
    };
    const line = JSON.stringify(record);
    if (sync) writer.writeSync(line);
    else writer.write(line);
    if (options.console) {
      // stderr, never stdout: workbench-core also runs as an MCP stdio server
      // and stdout must stay protocol-clean.
      process.stderr.write(mirrorLine(record));
    }
  }

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    errorSync: (msg, fields) => emit("error", msg, fields, true),
    child: (childBindings) =>
      makeLogger(service, writer, { ...bindings, ...serializeFields(childBindings) }, options)
  };
}

export function createLogger(service, options = {}) {
  const retentionDays =
    options.retentionDays ??
    (Number.parseInt(process.env.WORKBENCH_LOG_RETENTION_DAYS || "", 10) || DEFAULT_RETENTION_DAYS);
  const writer = new LogFileWriter(resolveLogDir(options.dir), service, retentionDays);
  return makeLogger(service, writer, {}, {
    level: options.level && LEVELS[options.level] ? options.level : envLevel(),
    console: options.console ?? consoleMirrorEnabled()
  });
}

// LG-D2: record fatal events durably, then preserve Node's default outcome
// (exit on uncaughtException, crash on unhandledRejection).
export function installProcessHandlers(logger) {
  process.on("uncaughtException", (error) => {
    logger.errorSync("uncaughtException", { err: error });
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.errorSync("unhandledRejection", {
      err: reason instanceof Error ? reason : new Error(String(reason))
    });
    throw reason;
  });
}

// LG-D3: Express-compatible access log. Structurally typed so consumers do not
// need @types/express to typecheck.
export function requestLogger(logger, options = {}) {
  const ignorePaths = new Set(options.ignorePaths ?? ["/health", "/healthz"]);
  return (req, res, next) => {
    if (ignorePaths.has(req.path ?? req.url)) return next();
    const start = Date.now();
    const headerId = req.headers?.["x-request-id"];
    const requestId =
      (typeof headerId === "string" && headerId.trim()) || crypto.randomUUID();
    if (res.locals) {
      res.locals.requestId = requestId;
      res.locals.log = logger.child({ requestId });
    }
    res.on("finish", () => {
      logger.info("http", {
        method: req.method,
        path: req.originalUrl ?? req.url,
        status: res.statusCode,
        durationMs: Date.now() - start,
        requestId
      });
    });
    next();
  };
}
