# Workbench Local Client / Sync Daemon Implementation Plan

Last updated: 2026-06-15

## Status Legend

- `[implemented]`: Code exists and builds.
- `[partial]`: Skeleton or first usable path exists, but production behavior is incomplete.
- `[pending]`: Not implemented yet.

## Implemented

### Local Client Identity

- `[implemented]` Core DB tables were added in `services/workbench-core/src/db.ts`.
  - `local_clients`
  - `local_client_tokens`
  - `local_client_heartbeats`
  - `local_jobs`
  - `sync_resource_versions`
  - `sync_events`
- `[implemented]` Local client store was added in `services/workbench-core/src/localClientsStore.ts`.
  - Register local daemon clients.
  - Store hashed local client tokens.
  - Verify daemon credentials via `x-workbench-local-client-id` and `x-workbench-local-client-token`.
  - List/update local clients.
  - Revoke local client tokens.
  - Delete local clients.
  - Record heartbeat.
  - Create/claim/complete/fail local jobs.
  - List local jobs for UI history.
- `[implemented]` Core HTTP APIs were added.
  - `POST /api/local-clients/register`
  - `GET /api/local-clients`
  - `PATCH /api/local-clients/:id`
  - `POST /api/local-clients/:id/revoke`
  - `DELETE /api/local-clients/:id`
  - `POST /api/local-clients/:id/heartbeat`
  - `GET /api/local-jobs`
  - `POST /api/local-jobs`
  - `GET /api/local-jobs/:jobId`
  - `POST /api/local-jobs/claim`
  - `POST /api/local-jobs/:jobId/complete`
  - `POST /api/local-jobs/:jobId/fail`
  - `GET /api/local-jobs/:jobId/download`

### MCP Local Client Download

- `[implemented]` Cloud HTTP MCP keeps existing base64 artifact download/upload tools.
- `[implemented]` Artifact local-client download tools were added.
  - `artifacts.download.to_client`
  - `artifacts.download.to_client.status`
- `[implemented]` `artifacts.download.to_client` creates a daemon-pulled local job instead of sending file bytes through MCP.
- `[implemented]` `workbench-core` stdio MCP no longer crashes from missing tool context when no token is present.
  - Without `WORKBENCH_MCP_ACCESS_TOKEN`, only login is registered.
  - With `WORKBENCH_MCP_ACCESS_TOKEN`, cloud tools are registered with context.

### Sync API Scaffold

- `[partial]` Sync event store was added in `services/workbench-core/src/syncStore.ts`.
- `[partial]` Core sync endpoints were added.
  - `GET /api/sync/snapshot`
  - `GET /api/sync/pull`
  - `GET /api/sync/blobs/:blobId`
  - `PUT /api/sync/blobs/:blobId`
  - `POST /api/sync/push`
- `[implemented]` Sync endpoints accept either normal bearer auth or daemon local-client credentials.
- `[partial]` Core facade writes best-effort sync events for representative Projects, Notes, Artifacts, and Tasks mutations.
- `[partial]` `GET /api/sync/blobs/:blobId` supports:
  - `artifact:<artifactItemId>`
  - `task-attachment:<taskId>:<attachmentId>`
- `[partial]` `POST /api/sync/push` applies representative Notes and Artifacts operations.
  - Notes create/update/delete/upsert.
  - Artifacts folder create.
  - Artifacts note create/update/delete/upsert.
  - Artifacts file create/upload.
  - Artifacts item delete by resource id.
  - Artifact file content replacement is still not supported.
- `[partial]` `PUT /api/sync/blobs/:blobId` currently returns `501`.

### Sync Daemon Service

- `[implemented]` New workspace was added: `services/sync-daemon`.
- `[implemented]` The daemon can:
  - read config from env vars,
  - create sync/download folders,
  - register itself with Core when `WORKBENCH_ACCESS_TOKEN` is provided,
  - persist local client identity under `.workbench/client-identity.json`,
  - heartbeat to Core,
  - claim local jobs,
  - download job blobs through Core,
  - save files only into configured `downloads` or `sync-folder`,
  - complete/fail jobs,
  - persist local sync state under `.workbench/manifest.sqlite`,
  - write `.workbench/manifest.json` as a compatibility/debug snapshot,
  - scan the sync folder for local file create/update/delete,
  - watch the sync folder and debounce local changes before scanning,
  - keep manifest resource mappings and SQLite outbox entries,
  - write sync rejection records under `.workbench/conflicts`,
  - track conflict lifecycle in `.workbench/manifest.sqlite`,
  - push local outbox changes to Core through `POST /api/sync/push`,
  - expose local status at `http://127.0.0.1:<port>/status`.
  - expose local conflict list/resolve endpoints under `http://127.0.0.1:<port>/conflicts`.
  - recover stale local outbox entries when files are changed, removed, or restored before a pending sync push finishes.
- `[implemented]` Daemon MCP tools were added in `services/sync-daemon/src/mcpServer.ts`.
  - `workbench.local.clients.current`
  - `workbench.local.path.resolve`
  - `workbench.local.materialize`
  - `workbench.local.import`
  - `workbench.local.job.claim`
  - `workbench.sync.status`
  - `workbench.sync.conflicts.list`
  - `workbench.sync.conflicts.resolve`

### Settings UI

- `[implemented]` Settings account page displays registered local clients.
- `[implemented]` UI supports:
  - refresh local clients,
  - set default client,
  - enable/disable local client,
  - revoke local client token,
  - delete local client,
  - online/offline/default display.
- `[implemented]` Settings account page displays recent local job history and result paths.
- `[implemented]` Settings account page displays local daemon status and open sync conflicts.
- `[implemented]` Settings account page can resolve local conflicts with retry, ignore, or close.
- `[implemented]` Settings can open the Account tab and Sync Daemon section from `/settings?tab=account&section=sync-daemon`.

### Main App Shell

- `[implemented]` The topbar displays local sync status from the daemon loopback API.
  - Shows checking, offline, watcher off, synced, pending, failed, or conflict state.
  - Polls periodically and refreshes when the configured daemon URL changes.
  - Clicking the indicator opens the Sync Daemon section in Settings.

### Verification

- `[implemented]` Full workspace build passes with:

```powershell
npm run build
```

- `[implemented]` Core local client/job store tests were added in `services/workbench-core/src/__tests__/localClientsStore.test.ts`.
  - Covers registration, token verification, heartbeat, disable/re-enable, revoke/re-register, default online selection, ambiguous client rejection, claim idempotency, completion, failure, and cross-client job isolation.
  - Tests run against the configured Core DB when reachable, and skip quickly when the local DB is offline.
- `[implemented]` Core local client/job HTTP API tests were added in `services/workbench-core/src/__tests__/localClientHttpApi.test.ts`.
  - Covers bearer-authenticated local client register/list/patch/revoke/delete.
  - Covers daemon-authenticated heartbeat, job claim, job completion, and revoked-token rejection.
  - Covers daemon-authenticated sync pull/snapshot/push/blob-upload-placeholder endpoints and unauthenticated sync rejection.
  - `httpServer.ts` now exports the Express app and starts listening only when executed directly, so HTTP routes can be tested on an ephemeral port.
- `[implemented]` Sync daemon recovery tests were added in `services/sync-daemon/src/__tests__/syncFolderRecovery.test.ts`.
  - Covers cancelling ghost creates when local files disappear before push.
  - Covers superseding pending deletes when local files reappear.
  - Covers replacing stale pending updates when files are edited again before push.
  - Covers auto-resolving open conflicts when their failed outbox items are superseded.

## Pending / Partial Work

### Production-Grade Local Client Management

- `[implemented]` Explicit token revoke endpoint exists.
- `[implemented]` Local client deletion endpoint exists.
- `[pending]` Add archival/soft-delete option if hard deletion is too aggressive for audit requirements.
- `[pending]` Add audit trail for local client registration, disable, default change, job claim, and job completion.
- `[pending]` Persist OAuth dynamic client registration if HTTPS MCP client continuity is needed across Core restarts.
- `[pending]` Add scoped local client capabilities enforcement beyond simple enabled/disabled checks.

### Local Job Robustness

- `[partial]` Claim/complete/fail exists, but retry policy is minimal.
- `[pending]` Add retry scheduling with `next_attempt_at`.
- `[pending]` Add expired job cleanup and terminal status handling.
- `[pending]` Add idempotency keys for job creation from MCP calls.
- `[pending]` Add job event log/history table.
- `[pending]` Add task attachment MCP convenience tool, for example `tasks.attachment.download.to_client`.
- `[implemented]` Local job list/filter API exists for recent UI history.
- `[implemented]` UI job history and result path display exists.

### Sync Daemon Persistence

- `[implemented]` The daemon now uses `.workbench/manifest.sqlite` as the primary local manifest.
- `[implemented]` `.workbench/manifest.json` remains as a compatibility/debug snapshot.
- `[implemented]` SQLite manifest tables exist for:
  - `resources`
  - `outbox`
  - `local_jobs`
  - `conflicts`
- `[implemented]` `sync_state` is represented by the `meta` table.
- `[implemented]` Add dedicated `conflicts` table.
- `[implemented]` Store checksum, resource id, local path, domain, dirty state, and last sync error in SQLite resources/outbox.
- `[implemented]` Add durable SQLite outbox for offline local changes.
- `[implemented]` Migrate legacy `.workbench/manifest.json` into SQLite when the DB is empty.
- `[partial]` Add recovery behavior when manifest and files disagree.
  - Removes ignored or ID-less resource entries when their local file no longer exists.
  - Supersedes stale pending create/update outbox entries when files are removed before push.
  - Supersedes pending delete outbox entries when files reappear before push.
  - Supersedes stale pending create/update outbox entries when files change again before push.
  - Auto-resolves open conflict records tied to superseded outbox entries.
  - Still needs remote snapshot reconciliation when the cloud changed while the daemon was offline.

### Sync Folder Watcher

- `[partial]` Polling scanner detects local create/update/delete.
- `[implemented]` Scanner ignores `.workbench`.
- `[implemented]` Add native file watcher for sync folder changes with interval-scan fallback.
- `[partial]` Ignore temp files, lock files, and partial writes.
- `[implemented]` Debounce and wait for file size/checksum stability before enqueueing changes.
- `[pending]` Detect local rename as rename instead of delete/create.
- `[partial]` Map local files back to domain resources through manifest entries.
- `[implemented]` Add conflict/rejection JSON file creation under `.workbench/conflicts`.
- `[implemented]` Add daemon MCP and loopback HTTP flows to list conflicts and mark them retry/ignore/close.

### Unified Sync Push / Pull

- `[partial]` `snapshot` and `pull` endpoints exist.
- `[partial]` `POST /api/sync/push` operation application exists for:
  - Projects create/update/delete/upsert.
  - Notes create/update/delete/upsert.
  - Artifacts folder create.
  - Artifacts note create/update/delete/upsert.
  - Artifacts file create/upload.
  - Artifacts item delete by resource id.
  - Tasks create/update/delete/upsert.
  - Tasks pin update/upsert.
- `[pending]` Extend `POST /api/sync/push` to:
  - Projects default selection.
  - Artifact file replacement/update.
  - Tasks occurrence/subtask/schedule operations.
- `[implemented]` Add optional `baseVersion` conflict checks before applying sync push operations.
- `[partial]` Return applied/rejected operations with stable-ish error codes for implemented domains.
- `[pending]` Add server-side tombstone semantics for domains that still hard-delete.
- `[pending]` Ensure all Core facade mutations record sync events consistently.
- `[pending]` Decide and implement how direct internal service changes outside Core are handled.

### Blob Upload / Replacement

- `[partial]` Blob download exists for artifact and task attachment ids.
- `[pending]` Implement `PUT /api/sync/blobs/:blobId`.
- `[pending]` Add artifact file replacement endpoint with expected version.
- `[pending]` Add task attachment upload/update operation through sync push.
- `[pending]` Add checksum validation on upload and download completion.

### Local UI Through Daemon

- `[pending]` Add daemon HTTP facade compatible with selected `/api/*` routes.
- `[pending]` Serve local-first reads from daemon SQLite when offline.
- `[pending]` Queue local UI writes into daemon outbox.
- `[pending]` Make desktop UI point to daemon loopback URL when local mode is enabled.
- `[implemented]` Add Settings UI display/actions for daemon status and open conflicts.
- `[implemented]` Add offline/sync/conflict status display in the main app shell.

### Desktop / OS Integration

- `[pending]` Add Tauri commands for:
  - choose sync folder,
  - open sync folder,
  - open downloads folder,
  - start/stop daemon,
  - read daemon status.
- `[pending]` Package daemon as Tauri sidecar or managed background process.
- `[pending]` Add optional auto-start.
- `[pending]` Store local client token in OS secure storage instead of plain `.workbench/client-identity.json`.

### Security Hardening

- `[partial]` Daemon writes only to configured downloads or sync folder.
- `[partial]` Daemon loopback API allows browser UI access with permissive local CORS.
- `[pending]` Add path allowlist tests for Windows/macOS/Linux edge cases.
- `[pending]` Add local daemon loopback token for status/API endpoints.
- `[pending]` Avoid returning sensitive local paths to non-local callers unless explicitly requested and authorized.
- `[pending]` Add per-job user confirmation policy for downloads outside sync folder if that behavior is later allowed.

## Recommended Next Implementation Order

1. Extend `POST /api/sync/push` to task occurrence/subtask/schedule operations and project default selection.
2. Implement artifact file replacement and `PUT /api/sync/blobs/:blobId`.
3. Add daemon local API facade for offline UI reads/writes.
4. Add Tauri integration for sync folder selection, open folder, and daemon lifecycle.

## Current Daemon Usage

First registration requires a normal Workbench access token.

```powershell
$env:WORKBENCH_CORE_URL="http://localhost:4100"
$env:WORKBENCH_ACCESS_TOKEN="<access token>"
$env:WORKBENCH_SYNC_ROOT="$HOME\WorkbenchSync"
npm run dev --workspace services/sync-daemon
```

After registration, the daemon reuses `.workbench/client-identity.json` unless `WORKBENCH_LOCAL_CLIENT_ID` and `WORKBENCH_LOCAL_CLIENT_TOKEN` are provided.
