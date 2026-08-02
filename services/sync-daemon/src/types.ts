import type { FSWatcher } from "node:fs";
import type { LeaseRegistry } from "./leases.js";
import type { CaptureManager } from "./capture/manager.js";
import type { CaptureServerPolicyProvider } from "./capture/serverPolicy.js";
import type { CaptureUploader } from "./capture/uploader.js";
import type { DaemonConfig } from "./config.js";
import type { ClientIdentity } from "./identityStorage.js";
import type { ManifestStore, RemoteResourceDomain, SyncErrorCategory } from "./manifestStore.js";

/**
 * Shared daemon types.
 *
 * These lived in index.ts, which meant any module that needed DaemonState had
 * to import index.ts and form a cycle — that is what blocked the domain logic
 * from being extracted. Keeping them here lets the domain modules depend on the
 * shape without depending on the entry point.
 */

/**
 * Decides when a sync tick runs. Declared here rather than beside its factory
 * so DaemonState can name it without the two files importing each other.
 */
export interface TickScheduler {
  /** Run a tick after `delayMs`, replacing any tick already pending. */
  schedule(delayMs?: number): void;
  /** Run a tick now, coalescing with one already in flight. */
  run(): Promise<void>;
}

export type LocalJob = {
  id: string;
  kind: "download_artifact" | "download_task_attachment" | "materialize_resource";
  target: "downloads" | "sync-folder";
  payload: Record<string, unknown>;
  status: string;
};

export type PendingLocalJobConfirmation = {
  job: LocalJob;
  requestedAt: string;
  reason: string;
};

export type LocalArtifactItem = {
  id: string;
  projectId: string;
  projectName?: string;
  kind: "folder" | "note" | "file";
  title: string;
  path: string;
  parentPath: string;
  scope: "private";
  tags: string[];
  mimeType?: string;
  sizeBytes?: number;
  version: number;
  contentMarkdown?: string;
  createdAt: string;
  updatedAt: string;
};

export type SyncPushResponse = {
  applied?: Array<{
    index: number;
    domain?: RemoteResourceDomain;
    action?: "create" | "update" | "delete";
    resourceId?: string;
    version?: number;
    deduplicated?: boolean;
    result?: unknown;
  }>;
  rejected?: Array<{
    index: number;
    code?: string;
    message?: string;
  }>;
  serverCursor?: string;
};

export type RemoteArtifactKind = "folder" | "note" | "file";

export type RemoteArtifactItem = {
  id: string;
  kind: RemoteArtifactKind;
  title?: string;
  path?: string;
  parentPath?: string;
  mimeType?: string;
  sizeBytes?: number;
  version?: number;
  updatedAt?: string;
  contentMarkdown?: string;
  contentBase64?: string;
};

export type RemoteSyncEvent = {
  cursor?: string;
  domain?: string;
  resourceId?: string;
  action?: string;
  version?: number;
  payload?: Record<string, unknown>;
  createdAt?: string;
};

export type SyncPullResponse = {
  events?: RemoteSyncEvent[];
  nextCursor?: string;
};

export type SyncSnapshotResponse = {
  generatedAt?: string;
  baselineCursor?: string;
  supportedDomains?: string[];
  domains?: Partial<Record<RemoteResourceDomain, unknown>>;
};

export type DaemonState = {
  config: DaemonConfig;
  /** Which desktop apps currently depend on this daemon. See leases.ts. */
  leases: LeaseRegistry;
  /** Set once a clean shutdown is under way, so nothing schedules more work. */
  shuttingDown?: boolean;
  manifestStore: ManifestStore;
  capture?: CaptureManager;
  captureUploader?: CaptureUploader;
  capturePolicy?: CaptureServerPolicyProvider;
  captureUploadIdentityWarned?: boolean;
  captureFileUploadWarned?: boolean;
  identity?: ClientIdentity;
  lastHeartbeatAt?: string;
  lastClaimAt?: string;
  lastScanAt?: string;
  lastPushAt?: string;
  lastRemotePullAt?: string;
  remoteArtifactCursor?: string;
  lastError?: string;
  lastErrorCode?: string;
  lastErrorCategory?: SyncErrorCategory;
  lastErrorRetryable?: boolean;
  lastLoggedError?: string;
  processedJobs: number;
  outboxPending: number;
  outboxFailed: number;
  conflictsOpen: number;
  watcherActive: boolean;
  tickRunning: boolean;
  tickQueued: boolean;
  tickTimer?: ReturnType<typeof setTimeout>;
  /** Wired by the daemon at startup; absent in fixtures that never tick. */
  ticker?: TickScheduler;
  watcher?: FSWatcher;
  pendingJobConfirmations?: Map<string, PendingLocalJobConfirmation>;
};
