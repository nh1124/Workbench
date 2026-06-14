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
  - Record heartbeat.
  - Create/claim/complete/fail local jobs.
- `[implemented]` Core HTTP APIs were added.
  - `POST /api/local-clients/register`
  - `GET /api/local-clients`
  - `PATCH /api/local-clients/:id`
  - `POST /api/local-clients/:id/heartbeat`
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
- `[partial]` Core facade writes best-effort sync events for representative Projects, Notes, Artifacts, and Tasks mutations.
- `[partial]` `GET /api/sync/blobs/:blobId` supports:
  - `artifact:<artifactItemId>`
  - `task-attachment:<taskId>:<attachmentId>`
- `[partial]` `POST /api/sync/push` currently validates input and returns rejected operations with `SYNC_PUSH_NOT_IMPLEMENTED`.
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
  - write a lightweight `.workbench/manifest.json`,
  - expose local status at `http://127.0.0.1:<port>/status`.
- `[implemented]` Daemon MCP tools were added in `services/sync-daemon/src/mcpServer.ts`.
  - `workbench.local.clients.current`
  - `workbench.local.path.resolve`
  - `workbench.local.materialize`
  - `workbench.local.import`
  - `workbench.local.job.claim`
  - `workbench.sync.status`

### Settings UI

- `[implemented]` Settings account page displays registered local clients.
- `[implemented]` UI supports:
  - refresh local clients,
  - set default client,
  - enable/disable local client,
  - online/offline/default display.

### Verification

- `[implemented]` Full workspace build passes with:

```powershell
npm run build
```

## Pending / Partial Work

### Production-Grade Local Client Management

- `[pending]` Add explicit token revoke/delete endpoint.
- `[pending]` Add local client deletion or archival.
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
- `[pending]` Add local job list/filter API for UI job history.
- `[pending]` Add UI job history and result path display.

### Sync Daemon Persistence

- `[partial]` The daemon currently uses `.workbench/manifest.json`.
- `[pending]` Replace lightweight JSON manifest with SQLite.
  - `resources`
  - `outbox`
  - `sync_state`
  - `conflicts`
  - `local_jobs`
  - `client_identity`
- `[pending]` Store checksum, resource id, local path, domain, version, dirty state, and last sync error per resource.
- `[pending]` Add durable outbox for offline local changes.
- `[pending]` Add recovery behavior when manifest and files disagree.

### Sync Folder Watcher

- `[pending]` Add file watcher for sync folder changes.
- `[pending]` Ignore `.workbench`, temp files, lock files, and daemon-written files.
- `[pending]` Debounce and wait for file size/checksum stability before enqueueing changes.
- `[pending]` Detect local create/update/delete/rename.
- `[pending]` Map local files back to domain resources through manifest entries.
- `[pending]` Add conflict file creation under `.workbench/conflicts`.

### Unified Sync Push / Pull

- `[partial]` `snapshot` and `pull` endpoints exist.
- `[pending]` Implement `POST /api/sync/push` operation application.
  - Projects create/update/delete/default selection.
  - Notes create/update/delete.
  - Artifacts folder/note/file create/update/delete.
  - Tasks create/update/delete/pin/occurrence/subtask/schedule operations.
- `[pending]` Add `baseVersion` conflict checks.
- `[pending]` Return applied/rejected operations with stable error codes.
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
- `[pending]` Add offline/sync/conflict status display in the main app shell.

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
- `[pending]` Add path allowlist tests for Windows/macOS/Linux edge cases.
- `[pending]` Add local daemon loopback token for status/API endpoints.
- `[pending]` Avoid returning sensitive local paths to non-local callers unless explicitly requested and authorized.
- `[pending]` Add per-job user confirmation policy for downloads outside sync folder if that behavior is later allowed.

## Recommended Next Implementation Order

1. Add tests for local client registration, heartbeat, token verification, disable/re-enable, and job claim/complete/fail.
2. Add local job history/list UI and API so users can inspect completed downloads.
3. Implement daemon SQLite manifest and move `.workbench/manifest.json` to a compatibility/debug artifact.
4. Implement sync folder watcher and durable outbox.
5. Implement `POST /api/sync/push` for one domain first, preferably Artifacts, then extend to Notes, Projects, and Tasks.
6. Implement artifact file replacement and `PUT /api/sync/blobs/:blobId`.
7. Add daemon local API facade for offline UI reads/writes.
8. Add Tauri integration for sync folder selection, open folder, and daemon lifecycle.

## Current Daemon Usage

First registration requires a normal Workbench access token.

```powershell
$env:WORKBENCH_CORE_URL="http://localhost:4100"
$env:WORKBENCH_ACCESS_TOKEN="<access token>"
$env:WORKBENCH_SYNC_ROOT="$HOME\WorkbenchSync"
npm run dev --workspace services/sync-daemon
```

After registration, the daemon reuses `.workbench/client-identity.json` unless `WORKBENCH_LOCAL_CLIENT_ID` and `WORKBENCH_LOCAL_CLIENT_TOKEN` are provided.

