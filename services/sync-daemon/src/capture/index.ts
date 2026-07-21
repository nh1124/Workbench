export type {
  CaptureConfig,
  CaptureConfigPatch,
  CaptureLogger,
  CaptureSample,
  CaptureSampleInput,
  CaptureScreenshotRecord,
  CaptureStatus
} from "./types.js";
export {
  CaptureStorage,
  DEFAULT_CAPTURE_CONFIG,
  DEFAULT_CAPTURE_CATEGORY_MAP,
  DEFAULT_CAPTURE_IDLE_THRESHOLD_SECONDS,
  DEFAULT_CAPTURE_INTERVAL_SECONDS,
  DEFAULT_CAPTURE_RETENTION_DAYS,
  DEFAULT_SCREENSHOT_INTERVAL_SECONDS,
  DEFAULT_SCREENSHOT_RETENTION_DAYS,
  assertCaptureDbPathAllowed,
  defaultCaptureDbPath,
  readCaptureStatusSnapshot,
  resolveCaptureDbPath,
  validateCaptureConfigPatch
} from "./storage.js";
export type { CaptureSampleUploadCursor, CaptureStoredSample } from "./storage.js";
export { CaptureError, CaptureManager } from "./manager.js";
export { CaptureSupervisor, decodeSamplerStdoutChunk, ingestSamplerLine } from "./supervisor.js";
export { ScreenshotScheduler, shouldCaptureScreenshot } from "./screenshotScheduler.js";
export { FileWatcher, isLocalFilePathAllowed, type FileWatcherOptions, type LocalFileEvent } from "./fileWatcher.js";
export { CAPTURE_UPLOAD_META_KEYS, CaptureUploader, type CaptureGetJson, type CapturePostJson, type CaptureUploaderOptions } from "./uploader.js";
export { CaptureServerPolicyProvider, normalizeServerCapturePolicy, type ServerCapturePolicy } from "./serverPolicy.js";

