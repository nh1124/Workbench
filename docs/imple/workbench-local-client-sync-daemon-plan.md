# Workbench Local Client / Sync Daemon Implementation Plan

Last updated: 2026-06-16

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
  - Artifacts file replacement/update through `contentBase64`.
  - Artifacts item delete by resource id.
- `[implemented]` `POST /api/sync/push` applies representative Projects and Tasks operations.
  - Projects create/update/delete/upsert.
  - Project default selection through relation `default`.
  - Tasks create/update/delete/upsert.
  - Tasks pin update/upsert.
  - Tasks attachment create/update/delete through relation `attachment`.
  - Tasks occurrence complete/move/skipException through relation `occurrence`.
  - Tasks subtask create/update/delete/upsert through relation `subtask`.
  - Tasks Today add/remove through relation `today`.
  - Tasks schedule item create/update/delete/upsert through relation `scheduleItem`.
- `[implemented]` `PUT /api/sync/blobs/:blobId` supports artifact file and task attachment replacement.
  - `artifact:<artifactItemId>`
  - `task-attachment:<taskId>:<attachmentId>`

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
- `[implemented]` Settings account page has a Local Mode toggle that routes supported artifact reads/writes to the daemon.
- `[implemented]` Desktop Settings can call native daemon commands to choose/open folders, read daemon status, and request start/stop.
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
- `[implemented]` Sync daemon artifact facade tests were extended.
  - Covers local folder creation.
  - Covers local file upload outbox writes.
  - Covers local Markdown content patch and section updates.

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
- `[implemented]` `POST /api/sync/push` operation application exists for:
  - Projects create/update/delete/upsert.
  - Projects default selection.
  - Notes create/update/delete/upsert.
  - Artifacts folder create.
  - Artifacts note create/update/delete/upsert.
  - Artifacts file create/upload.
  - Artifacts file replacement/update through `contentBase64`.
  - Artifacts item delete by resource id.
  - Tasks create/update/delete/upsert.
  - Tasks pin update/upsert.
  - Tasks attachment create/update/delete through relation `attachment`.
  - Tasks occurrence complete/move/skipException through relation `occurrence`.
  - Tasks subtask create/update/delete/upsert through relation `subtask`.
  - Tasks Today add/remove through relation `today`.
  - Tasks schedule item create/update/delete/upsert through relation `scheduleItem`.
- `[implemented]` Add optional `baseVersion` conflict checks before applying sync push operations.
- `[partial]` Return applied/rejected operations with stable-ish error codes for implemented domains.
- `[pending]` Add server-side tombstone semantics for domains that still hard-delete.
- `[pending]` Ensure all Core facade mutations record sync events consistently.
- `[pending]` Decide and implement how direct internal service changes outside Core are handled.

### Blob Upload / Replacement

- `[partial]` Blob download exists for artifact and task attachment ids.
- `[implemented]` Implement `PUT /api/sync/blobs/:blobId`.
  - Artifact file blobs are supported via `artifact:<id>`.
  - Task attachment replacement blobs are supported via `task-attachment:<taskId>:<attachmentId>`.
- `[implemented]` Add artifact file replacement endpoint with expected version.
- `[implemented]` Add task attachment upload/update/delete operation through sync push.
- `[partial]` Add checksum validation on upload and download completion.
  - Artifact and task attachment blob PUT / sync push validate optional `sha256:<hex>` checksums.
  - Download completion checksum reporting remains job/daemon-side only.

### Local UI Through Daemon

- `[implemented]` Add daemon HTTP facade compatible with selected artifact `/api/*` routes.
  - Added `GET /api/sync/status`.
  - Added local artifact read facade for `GET /api/sync/snapshot`, `GET /api/artifacts/tree`, `GET /api/artifacts/tree/list`, `GET /api/artifacts/items/:id`, and artifact download.
  - Added `POST /api/artifacts/folders`.
  - Added `POST /api/artifacts/upload`.
  - Added `POST /api/artifacts/notes`.
  - Added `PATCH /api/artifacts/items/:id`.
  - Added `PATCH /api/artifacts/items/:id/content-patch`.
  - Added `PATCH /api/artifacts/items/:id/section`.
  - Added `DELETE /api/artifacts/items/:id`.
- `[partial]` Serve local-first reads from daemon SQLite when offline.
  - Artifact tree/item reads are served from `.workbench/manifest.sqlite` plus files in the sync folder.
- `[partial]` Queue local UI writes into daemon outbox.
  - Added `POST /api/artifacts/notes` for local Markdown note creation.
  - Added `PATCH /api/artifacts/items/:id` for local Markdown note content/path/title updates.
  - Added `DELETE /api/artifacts/items/:id` for local note/file deletion.
  - Added `POST /api/artifacts/upload` for local file upload.
  - Added `POST /api/artifacts/folders` for sync-root folder creation.
  - Added content patch and note section patch routes.
  - Empty folders are local filesystem directories and are not yet synced as standalone cloud folder resources until they contain files.
- `[implemented]` Make artifact UI use the daemon loopback URL when Local Mode is enabled.
  - Tree, item read, note create/update/delete, folder create, file upload, and file download route through the daemon.
  - Existing Core route remains active when Local Mode is disabled.
- `[implemented]` Add Settings UI display/actions for daemon status and open conflicts.
- `[implemented]` Add offline/sync/conflict status display in the main app shell.

### Desktop / OS Integration

- `[implemented]` Add Tauri commands for:
  - choose sync folder,
  - open sync folder,
  - open downloads folder,
  - start/stop daemon,
  - read daemon status.
- `[partial]` The UI can invoke the native daemon commands from Settings.
  - Folder open/status commands are functional in Tauri.
  - Start/stop currently return explicit sidecar-not-configured errors.
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

1. Package `services/sync-daemon` as a Tauri sidecar or managed background process, then replace the current start/stop error skeletons.
2. Add loopback API authentication for daemon HTTP endpoints and wire the token into the desktop UI.
3. Add local job retry scheduling, expiry cleanup, idempotency keys, and job event history/audit rows.
4. Add remote snapshot reconciliation so daemon startup can merge cloud changes made while the PC was offline.
5. Add tombstone semantics and consistent sync event recording for all remaining Core mutation paths.
6. Decide whether empty local folders should become first-class cloud folder resources immediately or remain local until they contain synced files.

## Current Daemon Usage

First registration requires a normal Workbench access token.

```powershell
$env:WORKBENCH_CORE_URL="http://localhost:4100"
$env:WORKBENCH_ACCESS_TOKEN="<access token>"
$env:WORKBENCH_SYNC_ROOT="$HOME\WorkbenchSync"
npm run dev --workspace services/sync-daemon
```

After registration, the daemon reuses `.workbench/client-identity.json` unless `WORKBENCH_LOCAL_CLIENT_ID` and `WORKBENCH_LOCAL_CLIENT_TOKEN` are provided.
