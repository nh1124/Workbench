export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Synchronous write for fatal paths (survives immediate process exit). */
  errorSync(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export interface CreateLoggerOptions {
  /** Explicit log directory. Defaults to WORKBENCH_LOG_DIR or <repo root>/logs. */
  dir?: string;
  /** Minimum level. Defaults to LOG_LEVEL env or "info". */
  level?: LogLevel;
  /** Mirror records to stderr. Defaults to WORKBENCH_LOG_CONSOLE !== "0". */
  console?: boolean;
  /** Days to keep dated files. Defaults to WORKBENCH_LOG_RETENTION_DAYS or 14. */
  retentionDays?: number;
}

export function createLogger(service: string, options?: CreateLoggerOptions): Logger;

/** Log uncaughtException / unhandledRejection durably, preserving default crash behavior. */
export function installProcessHandlers(logger: Logger): void;

export interface RequestLoggerOptions {
  /** Paths to skip. Defaults to ["/health", "/healthz"]. */
  ignorePaths?: string[];
}

interface MinimalRequest {
  method?: string;
  url?: string;
  path?: string;
  originalUrl?: string;
  headers?: Record<string, unknown>;
}

interface MinimalResponse {
  statusCode?: number;
  locals?: Record<string, unknown>;
  on(event: "finish", listener: () => void): unknown;
}

export function requestLogger(
  logger: Logger,
  options?: RequestLoggerOptions
): (req: MinimalRequest, res: MinimalResponse, next: (err?: unknown) => void) => void;
