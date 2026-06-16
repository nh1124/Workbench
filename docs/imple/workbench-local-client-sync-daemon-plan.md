# Workbench Local Client / Sync Daemon Implementation Plan

Last updated: 2026-06-17

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
- `[implemented]` `GET /api/sync/snapshot` accepts `cursor` and `limit`; Projects snapshot forwards cursor pagination to the Projects service.
- `[partial]` Core facade writes best-effort sync events for representative Projects, Notes, Artifacts, and Tasks mutations.
- `[implemented]` Delete sync events include tombstone metadata in pull responses and resource-version listings.
  - `deleted`
  - `deletedAt`
  - `resourceDeletedAt`
- `[implemented]` Core task relation mutations now emit best-effort sync events for occurrence, subtask, Today, and schedule item paths handled through Core.
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
- `[implemented]` Successful sync-push events include applied `resource` payloads for Projects, Notes, Artifacts, and non-relation Tasks so other daemons can update remote caches without waiting for a full snapshot.
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
  - pull remote snapshot/incremental events before local scan/push,
  - persist remote sync/artifact cursors and last remote pull timestamp in manifest meta,
  - apply clean remote artifact note/file/folder changes into the sync folder,
  - cache remote Projects, Notes, and Tasks state in SQLite for local-first reads,
  - fetch small remote artifact file blobs through Core,
  - create conflicts instead of overwriting dirty local artifact files or folders,
  - apply remote folder deletes only when tracked local contents are clean,
  - reject unsafe remote paths under `.workbench` or outside the sync root.
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
- `[implemented]` Sync daemon path safety tests were added.
  - Covers traversal, absolute paths, encoded local ids, `.workbench`, temp/partial files, reserved Windows names, and hostile download filenames.
- `[implemented]` Sync daemon remote artifact pull tests were added.
  - Covers snapshot bootstrap, incremental note updates, blob fetch, dirty-local conflicts, clean folder deletes, untracked-folder conflicts, and metadata path rejection.
  - Covers Projects/Notes/Tasks remote cache bootstrap and incremental non-artifact event reconciliation.

## Pending / Partial Work

### Production-Grade Local Client Management

- `[implemented]` Explicit token revoke endpoint exists.
- `[implemented]` Local client deletion endpoint exists.
- `[implemented]` Archival/soft-delete option exists for audit-preserving local client removal.
  - `POST /api/local-clients/:id/archive` disables the client, revokes active tokens, clears default selection, and records an `archived` audit event.
  - `GET /api/local-clients` hides archived clients by default; `includeArchived=true` includes them.
- `[implemented]` Add audit trail for local client registration, update, enable/disable, default change, token revoke, archive, delete, job lifecycle, expiry, and capability denial.
  - `local_client_audit_events` stores user/client/actor/detail metadata.
  - `GET /api/local-clients/audit-events` exposes owner-visible audit history.
  - Settings displays recent local client audit events.
- `[implemented]` Persist OAuth dynamic client registration so MCP clients can re-authorize after Core restarts.
  - `oauth_dynamic_clients` stores public DCR client metadata.
  - `/oauth/register` writes registrations to DB instead of process memory.
  - `/authorize` resolves non-URL dynamic `client_id` values from the persisted store.
- `[implemented]` Add scoped local client capabilities enforcement beyond simple enabled/disabled checks.
  - Capabilities normalize to explicit `scopes`.
  - Supported scopes are `local_jobs.claim`, `local_jobs.download`, `sync.pull`, `sync.push`, `sync.blobs.read`, and `sync.blobs.write`.
  - Existing daemon-style `localJobs`, `downloads`, `sync`, and `syncFolder` booleans are accepted as compatibility aliases.
  - Daemon-authenticated local job and sync routes enforce the relevant scope.

### Local Job Robustness

- `[implemented]` Claim/complete/fail exists.
- `[implemented]` Add retry scheduling with `next_attempt_at`.
- `[implemented]` Add expired job cleanup and terminal status handling.
- `[implemented]` Add idempotency keys for job creation from MCP calls and HTTP job creation.
- `[implemented]` Add job event log/history table.
  - `local_job_events` records create, claim, complete, fail, retry schedule, and expiry.
  - `GET /api/local-jobs/:jobId/events` exposes owner-visible event history.
- `[implemented]` Task attachment MCP local-client download tools were added.
  - `tasks.attachments.download.to_client`
  - `tasks.attachments.download.to_client.status`
- `[implemented]` Local job list/filter API exists for recent UI history.
- `[implemented]` UI job history and result path display exists.
- `[implemented]` Owner-facing local job APIs and MCP status redact `result.localPath` by default.
  - `includeLocalPaths=true` on HTTP APIs or `includeLocalPath: true` on MCP status explicitly returns the path for authorized owner calls.
  - Daemon-authenticated completion responses keep the full path for the reporting local client.

### Sync Daemon Persistence

- `[implemented]` The daemon now uses `.workbench/manifest.sqlite` as the primary local manifest.
- `[implemented]` `.workbench/manifest.json` remains as a compatibility/debug snapshot.
- `[implemented]` SQLite manifest tables exist for:
  - `resources`
  - `remote_resources`
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
  - Queues exact clean local rename/move matches as resource updates instead of delete/create pairs.
  - Auto-resolves open conflict records tied to superseded outbox entries.
- `[implemented]` Remote snapshot/incremental pull reconciliation exists.
  - Bootstrap reads `/api/sync/snapshot?domains=projects,notes,artifacts,tasks`.
  - If all-domain snapshot is unavailable, daemon falls back to artifact-only bootstrap so file sync keeps running.
  - Projects bootstrap follows `nextCursor` with `/api/sync/snapshot?domains=projects&cursor=...&limit=100`.
  - Incremental pull reads `/api/sync/pull` from the stored cursor.
  - Clean remote artifact changes are materialized locally before local scan/push.
  - Remote Projects, Notes, and Tasks are stored under `.workbench/manifest.sqlite` `remote_resources`.
  - Metadata-only relation events merge into existing cached domain payloads instead of erasing richer snapshot data.
  - Dirty local state or open outbox work creates `.workbench/conflicts` records instead of overwriting local files.
- `[implemented]` Remote reconciliation for Projects, Notes, and Tasks is implemented as daemon SQLite cache.
  - These domains are not materialized into human-readable sync-folder files in this phase.
  - Local writes for these domains are not queued through daemon outbox yet.

### Sync Folder Watcher

- `[partial]` Polling scanner detects local create/update/delete.
- `[implemented]` Scanner ignores `.workbench`.
- `[implemented]` Add native file watcher for sync folder changes with interval-scan fallback.
- `[implemented]` Ignore temp files, lock files, partial writes, and reserved Windows device names.
- `[implemented]` Debounce and wait for file size/checksum stability before enqueueing changes.
- `[implemented]` Detect clean tracked local file rename/move as update instead of delete/create when there is an exact unambiguous checksum/size match.
- `[partial]` Map local files back to domain resources through manifest entries.
- `[implemented]` Add conflict/rejection JSON file creation under `.workbench/conflicts`.
- `[implemented]` Add daemon MCP and loopback HTTP flows to list conflicts and mark them retry/ignore/close.

### Unified Sync Push / Pull

- `[partial]` `snapshot` and `pull` endpoints exist.
- `[implemented]` Pull events for deletes include tombstone metadata.
- `[implemented]` `sync_resource_versions` can be listed internally with `deletedAt` for tombstones.
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
- `[partial]` Server-side tombstone event metadata exists, but underlying domain services still hard-delete their own records.
- `[partial]` Core facade mutations now cover the main Projects, Notes, Artifacts, and Tasks paths, including task relation changes. Continue auditing new or direct mutation routes as they are added.
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
  - Local job download proxy returns `X-Workbench-Content-Checksum: sha256:<hex>`.
  - Daemon validates the proxy checksum before writing downloaded job files locally.
  - Download completion checksum reporting remains bare hex for daemon manifest compatibility.

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
  - Projects, Notes, and Tasks list/item reads are served from `remote_resources` cache.
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
- `[implemented]` The UI can invoke the native daemon commands from Settings.
  - Folder open/status commands are functional in Tauri.
  - Start/stop now manage a background daemon process.
  - `WORKBENCH_DAEMON_COMMAND` and `WORKBENCH_DAEMON_ARGS` can override the default command.
  - `WORKBENCH_DAEMON_SIDECAR_PATH` and `WORKBENCH_DAEMON_SIDECAR_ARGS` can point the desktop app at a production daemon executable.
  - Packaged sidecars are discovered from Tauri resource/executable/current directories as `workbench-sync-daemon` or `workbench-sync-daemon.exe`, including `sidecars/` and `binaries/` subdirectories.
  - Default development command is `npm run dev --workspace services/sync-daemon` from the inferred repo root.
- `[implemented]` Add managed background process support for development/desktop.
- `[implemented]` Package daemon as a production Tauri sidecar binary.
  - `WORKBENCH_DAEMON_EXTERNAL_BIN` can add one or more external binaries to generated `tauri.conf.json`.
  - `NATIVE_BUNDLE_ACTIVE` can explicitly enable or disable Tauri bundle generation.
  - The runtime launcher prefers explicit command override, explicit sidecar path, packaged sidecar, then development npm fallback.
  - `npm run sidecar:build --workspace services/sync-daemon` builds TypeScript, creates a Node SEA sidecar executable at `services/sync-daemon/dist/tauri-sidecar/workbench-sync-daemon-$TARGET_TRIPLE(.exe)`, and writes a sidecar manifest.
  - `npm run tauri:build --workspace native/desktop` runs the sidecar build before Tauri packaging.
  - `prepare-tauri-config.mjs` still honors explicit `WORKBENCH_DAEMON_EXTERNAL_BIN`; when it is unset, it reads the generated sidecar manifest and emits the Tauri `bundle.externalBin` base path.
- `[implemented]` Add optional auto-start.
  - Desktop Settings exposes an Auto-start Daemon toggle.
  - Preference is stored in Tauri app config as `daemon-preferences.json`.
  - On desktop startup, the native shell starts the daemon if auto-start is enabled.
- `[partial]` Store local client token in OS secure storage instead of plain `.workbench/client-identity.json`.
  - Windows native secure storage now has a separate `Workbench.LocalDaemonClient` target for daemon `localClientId` / `localClientToken`, distinct from `Workbench.Session`.
  - Tauri-managed daemon startup injects stored credentials as `WORKBENCH_LOCAL_CLIENT_ID` and `WORKBENCH_LOCAL_CLIENT_TOKEN` when neither env var is already set.
  - Native commands can save, inspect non-secret status, and clear the secure daemon client credential.
  - Standalone daemon startup and first registration still use `.workbench/client-identity.json` as a fallback, so full post-registration migration away from the plain file remains incomplete.

### Security Hardening

- `[implemented]` Daemon writes only to configured downloads or sync folder.
- `[implemented]` Daemon loopback API restricts CORS to local browser origins by default.
  - Auth headers are allowed for local daemon token use.
  - `WORKBENCH_DAEMON_ALLOWED_ORIGINS` or `WORKBENCH_LOCAL_DAEMON_ALLOWED_ORIGINS` can override the allowlist.
  - Explicit `*` is still supported for development, but is no longer the default.
- `[implemented]` Add path allowlist tests for Windows/macOS/Linux edge cases covered by Node path handling.
  - Rejects absolute paths, drive-prefixed paths, UNC-style roots, `..` traversal, `.workbench`, temp/partial files, and reserved Windows device names.
- `[implemented]` Add optional local daemon loopback token for status/API endpoints.
  - `WORKBENCH_DAEMON_API_TOKEN` or `WORKBENCH_LOCAL_DAEMON_TOKEN` enables token enforcement.
  - UI stores/sends the token via `x-workbench-daemon-token`.
  - `/health` remains unauthenticated and returns only a minimal `{ status: "ok" }` payload.
- `[implemented]` Avoid returning sensitive local paths to non-local callers unless explicitly requested and authorized.
  - Owner-facing local job HTTP APIs redact `result.localPath` unless `includeLocalPaths=true`.
  - MCP local job status tools redact `result.localPath` unless `includeLocalPath: true`.
- `[pending]` Add per-job user confirmation policy for downloads outside sync folder if that behavior is later allowed.

## Recommended Next Implementation Order

1. Decide whether empty local folders should become first-class cloud folder resources immediately or remain local until they contain synced files.
2. Decide and implement the policy for direct internal service mutations outside Core.
3. Add cursor-based full snapshot refresh for Notes/Tasks if those services gain cursor pagination.
4. Design local outbox write facades for Projects/Notes/Tasks after the read cache has been exercised.

## Current Daemon Usage

First registration requires a normal Workbench access token.

```powershell
$env:WORKBENCH_CORE_URL="http://localhost:4100"
$env:WORKBENCH_ACCESS_TOKEN="<access token>"
$env:WORKBENCH_SYNC_ROOT="$HOME\WorkbenchSync"
$env:WORKBENCH_DAEMON_API_TOKEN="<optional loopback token>"
npm run dev --workspace services/sync-daemon
```

After registration, the standalone daemon reuses `.workbench/client-identity.json` unless `WORKBENCH_LOCAL_CLIENT_ID` and `WORKBENCH_LOCAL_CLIENT_TOKEN` are provided.
Desktop-managed startup can also inject the local client ID/token from Windows Credential Manager when saved through the native secure daemon client commands.

Desktop `start_daemon` now launches a managed background process. By default it runs:

```powershell
npm run dev --workspace services/sync-daemon
```

Override with `WORKBENCH_DAEMON_COMMAND` and optional `WORKBENCH_DAEMON_ARGS` when using a packaged daemon.
For sidecar-style packaging, run:

```powershell
npm run sidecar:build --workspace services/sync-daemon
npm run tauri:prepare --workspace native/desktop
```

The sidecar build writes `services/sync-daemon/dist/tauri-sidecar/sidecar-manifest.json`, and `tauri:prepare`
uses that manifest when `WORKBENCH_DAEMON_EXTERNAL_BIN` is unset. Explicit `WORKBENCH_DAEMON_EXTERNAL_BIN`
still overrides the manifest, and `WORKBENCH_DAEMON_SIDECAR_PATH` can still point the desktop app at a specific executable.
