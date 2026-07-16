# Workbench Local Client / Sync Daemon Implementation Plan

Last updated: 2026-06-18

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

- `[implemented]` Sync event store was added in `services/workbench-core/src/syncStore.ts`.
- `[implemented]` Core sync endpoints were added.
  - `GET /api/sync/snapshot`
  - `GET /api/sync/pull`
  - `GET /api/sync/blobs/:blobId`
  - `PUT /api/sync/blobs/:blobId`
  - `POST /api/sync/push`
- `[implemented]` Sync endpoints accept either normal bearer auth or daemon local-client credentials.
- `[implemented]` `GET /api/sync/snapshot` accepts `cursor` and `limit`; Projects, Notes, and Tasks snapshots forward cursor pagination to their domain services.
- `[implemented]` Core facade writes best-effort sync events for representative Projects, Notes, Artifacts, and Tasks mutations.
- `[implemented]` Delete sync events include tombstone metadata in pull responses and resource-version listings.
  - `deleted`
  - `deletedAt`
  - `resourceDeletedAt`
- `[implemented]` Core task relation mutations now emit best-effort sync events for occurrence, subtask, Today, and schedule item paths handled through Core.
- `[implemented]` `GET /api/sync/blobs/:blobId` supports:
  - `artifact:<artifactItemId>`
  - `task-attachment:<taskId>:<attachmentId>`
- `[implemented]` `POST /api/sync/push` applies representative Notes and Artifacts operations.
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
  - persist local client identity under `.workbench/client-identity.json` by default,
  - persist standalone local client identity in OS-backed secure storage when `WORKBENCH_SECURE_CLIENT_IDENTITY=auto|required` is set,
  - run without writing `.workbench/client-identity.json` when `WORKBENCH_PERSIST_CLIENT_IDENTITY=0` or `WORKBENCH_LOCAL_CLIENT_IDENTITY_FILE=0` is set,
  - heartbeat to Core,
  - claim local jobs,
  - download job blobs through Core,
  - save files only into configured `downloads` or `sync-folder`,
  - complete/fail jobs,
  - persist local sync state under `.workbench/manifest.sqlite`,
  - write `.workbench/manifest.json` as a compatibility/debug snapshot,
  - scan the sync folder for local file/folder create/update/delete,
  - watch the sync folder and debounce local changes before scanning,
  - keep manifest resource mappings and SQLite outbox entries,
  - write sync rejection records under `.workbench/conflicts`,
  - track conflict lifecycle in `.workbench/manifest.sqlite`,
  - persist sync error metadata on outbox/conflict records (`errorCode`, `errorCategory`, `retryable`),
  - push local outbox changes to Core through `POST /api/sync/push`,
  - expose local status at `http://127.0.0.1:<port>/status`.
  - expose local conflict list/resolve endpoints under `http://127.0.0.1:<port>/conflicts`.
  - expose opt-in local job confirmation endpoints under `http://127.0.0.1:<port>/api/local-jobs/pending-confirmations`.
  - recover stale local outbox entries when files are changed, removed, or restored before a pending sync push finishes.
  - reuse a memory-held local client identity during the daemon process lifetime when plaintext identity persistence is disabled.
  - pull remote snapshot/incremental events before local scan/push,
  - persist remote sync/artifact cursors and last remote pull timestamp in manifest meta,
  - apply clean remote artifact note/file/folder changes into the sync folder,
  - cache remote Projects, Notes, and Tasks state in SQLite for local-first reads,
  - fetch small remote artifact file blobs through Core,
  - create conflicts instead of overwriting dirty local artifact files or folders,
  - apply remote folder deletes only when tracked local contents are clean,
  - reject unsafe remote paths under `.workbench` or outside the sync root.
  - expose classified daemon runtime errors in `/status` through `lastErrorCode`, `lastErrorCategory`, and `lastErrorRetryable`.
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
- `[implemented]` Settings account page displays local daemon jobs waiting for approval.
- `[implemented]` Settings account page can approve or reject pending local daemon jobs.
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
  - Covers queuing empty folder creates discovered by sync scans.
  - Covers queuing one cloud folder delete when a tracked local folder tree is removed.
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
  - Covers checksum mismatch rejection for sync blob downloads before local file materialization.
- `[implemented]` Sync daemon route coverage tests were added in `services/sync-daemon/src/__tests__/routeCoverage.test.ts`.
  - Audits that Tasks UI Local Mode routes in `ui/src/lib/api.ts` are mirrored by daemon loopback routes.
  - Audits that Core sync endpoints, sync event-store contracts, supported blob ids, and checksum response contracts remain wired.
- `[implemented]` Sync daemon local client identity tests were added.
  - Covers optional no-plaintext identity persistence.
  - Covers in-memory identity reuse while no-plaintext persistence is enabled.
  - Covers backward-compatible identity file persistence with restrictive file mode where the OS supports it.
  - Covers opt-in secure identity storage modes.
  - Covers secure backend persistence, auto fallback, required secure-storage failure, and plaintext-file migration into secure storage.
  - Covers clearing secure identity storage through the shared identity storage abstraction.
- `[implemented]` Sync daemon sync error classification tests were added.
  - Covers version conflict, network failure, and path rejection classification.
  - Covers SQLite persistence of outbox/conflict `errorCode`, `errorCategory`, and `retryable`.
- `[implemented]` Sync daemon local job confirmation policy tests were added.
  - Covers `off`, `downloads`, `outside-sync-folder`, and `all` policy parsing.
  - Covers target-based confirmation decisions.
  - Covers queuing downloads jobs for approval without downloading bytes.
- `[implemented]` Core-origin mutation guard audit tests were added in `services/tasks/src/__tests__/coreMutationGuardAudit.test.ts`.
  - Covers Notes, Projects, Artifacts, and Tasks service HTTP route ordering.
  - Fails if a user-facing `POST` / `PUT` / `PATCH` / `DELETE` route is mounted before `requireCoreMutationOriginMiddleware`.
  - Keeps `/internal/*` routes on the existing internal API key path.

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
- `[implemented]` Add recovery behavior when manifest and files disagree.
  - Removes ignored or ID-less resource entries when their local file no longer exists.
  - Supersedes stale pending create/update outbox entries when files are removed before push.
  - Supersedes pending delete outbox entries when files reappear before push.
  - Supersedes stale pending create/update outbox entries when files change again before push.
  - Queues exact clean local rename/move matches as resource updates instead of delete/create pairs.
  - Queues tracked folder tree deletion as a single folder delete instead of emitting child deletes first.
  - Auto-resolves open conflict records tied to superseded outbox entries.
- `[implemented]` Remote snapshot/incremental pull reconciliation exists.
  - Bootstrap reads `/api/sync/snapshot?domains=projects,notes,artifacts,tasks`.
  - If all-domain snapshot is unavailable, daemon falls back to artifact-only bootstrap so file sync keeps running.
  - Projects, Notes, and Tasks bootstrap follows per-domain `nextCursor` with `/api/sync/snapshot?domains=<domain>&cursor=...&limit=100`.
  - Incremental pull reads `/api/sync/pull` from the stored cursor.
  - Clean remote artifact changes are materialized locally before local scan/push.
  - Remote Projects, Notes, and Tasks are stored under `.workbench/manifest.sqlite` `remote_resources`.
  - Metadata-only relation events merge into existing cached domain payloads instead of erasing richer snapshot data.
  - Dirty local state or open outbox work creates `.workbench/conflicts` records instead of overwriting local files.
- `[implemented]` Remote reconciliation for Projects, Notes, and Tasks is implemented as daemon SQLite cache.
  - These domains are not materialized into human-readable sync-folder files in this phase.
  - Projects, Notes, core Tasks, and the main Task relations can now be queued through daemon outbox.
  - Task import/export/history are served from the daemon cache in Local Mode.

### Sync Folder Watcher

- `[implemented]` Polling scanner detects local file create/update/delete and folder create/delete.
- `[implemented]` Scanner ignores `.workbench`.
- `[implemented]` Add native file watcher for sync folder changes with interval-scan fallback.
- `[implemented]` Ignore temp files, lock files, partial writes, and reserved Windows device names.
- `[implemented]` Debounce and wait for file size/checksum stability before enqueueing changes.
- `[implemented]` Detect clean tracked local file rename/move as update instead of delete/create when there is an exact unambiguous checksum/size match.
- `[implemented]` Map local files back to domain resources through manifest entries.
- `[implemented]` Add conflict/rejection JSON file creation under `.workbench/conflicts`.
- `[implemented]` Add daemon MCP and loopback HTTP flows to list conflicts and mark them retry/ignore/close.

### Unified Sync Push / Pull

- `[implemented]` `snapshot` and `pull` endpoints exist.
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
- `[implemented]` Return applied/rejected operations with stable error codes for implemented domains.
  - Core sync-push rejections include `code` and `message`.
  - Daemon maps rejection codes and runtime failures into `network`, `version_conflict`, `path_rejection`, `validation`, `checksum`, `unsupported`, `local_conflict`, `auth`, `capability`, `server`, or `unknown`.
  - Settings displays local conflict category/code/retryability.
- `[implemented]` Server-side clientOpId idempotency for sync push replays.
  - Sync events carrying a `clientOpId` record it in `sync_applied_client_ops` inside the same transaction (covers both sync-push applies and Core REST mutations sending `x-workbench-client-op-id`).
  - `POST /api/sync/push` skips ops whose `clientOpId` was already applied and returns them in `applied` with `deduplicated: true`; `serverCursor` uses the owner's latest cursor so deduplicated entries cannot rewind the daemon.
- `[implemented]` Server-side tombstone event metadata exists in the Core sync event/version store.
  - Underlying domain services may still hard-delete their own records; sync tombstone retention is handled by `sync_events` and `sync_resource_versions`.
- `[implemented]` Core facade mutations now cover the main Projects, Notes, Artifacts, and Tasks paths, including task relation changes.
  - Static route/audit tests guard the current route surface and direct-service mutation path as new routes are added.
- `[implemented]` Add an opt-in Core-origin guard for direct internal service mutations outside Core.
  - `workbench-core` attaches `x-workbench-core-mutation: 1` to non-read internal service calls.
  - If `WORKBENCH_CORE_MUTATION_TOKEN` is configured, Core also attaches `x-workbench-core-mutation-token`.
  - Notes, Artifacts, Tasks, and Projects services reject user-facing `POST` / `PUT` / `PATCH` / `DELETE` requests unless the Core-origin header is present when `WORKBENCH_REQUIRE_CORE_MUTATION_ORIGIN=true`.
  - `/internal/*` routes remain governed by their existing internal API key checks.
  - `services/tasks/src/__tests__/coreMutationGuardAudit.test.ts` audits current Notes, Projects, Artifacts, and Tasks mutation route ordering so newly added direct write routes cannot silently bypass the guard.

### Blob Upload / Replacement

- `[implemented]` Blob download exists for artifact and task attachment ids.
- `[implemented]` Implement `PUT /api/sync/blobs/:blobId`.
  - Artifact file blobs are supported via `artifact:<id>`.
  - Task attachment replacement blobs are supported via `task-attachment:<taskId>:<attachmentId>`.
- `[implemented]` Add artifact file replacement endpoint with expected version.
- `[implemented]` Add task attachment upload/update/delete operation through sync push.
- `[implemented]` Add checksum validation on upload and download completion.
  - Artifact and task attachment blob PUT / sync push validate optional `sha256:<hex>` checksums.
  - Local job download proxy returns `X-Workbench-Content-Checksum: sha256:<hex>`.
  - Daemon validates the proxy checksum before writing downloaded job files locally.
  - `GET /api/sync/blobs/:blobId` returns `X-Workbench-Content-Checksum: sha256:<hex>`.
  - Daemon validates sync blob checksums before materializing remote artifact files locally.
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
- `[implemented]` Serve local-first reads from daemon SQLite when offline.
  - Artifact tree/item reads are served from `.workbench/manifest.sqlite` plus files in the sync folder.
  - Projects, Notes, and Tasks list/item reads are served from `remote_resources` cache.
- `[implemented]` Queue local UI writes into daemon outbox.
  - Added `POST /api/artifacts/notes` for local Markdown note creation.
  - Added `PATCH /api/artifacts/items/:id` for local Markdown note content/path/title updates.
  - Added `DELETE /api/artifacts/items/:id` for local note/file deletion.
  - Added `POST /api/artifacts/upload` for local file upload.
  - Added `POST /api/artifacts/folders` for sync-root folder creation and cloud folder outbox queueing.
  - Added content patch and note section patch routes.
  - Empty folders discovered by scanner are queued as standalone cloud artifact folder resources.
  - Added `POST /api/projects`, `PATCH /api/projects/:id`, `DELETE /api/projects/:id`, and `PUT /api/projects/default` for Projects cache/outbox writes.
  - Added `POST /api/notes`, `PATCH /api/notes/:id`, and `DELETE /api/notes/:id` for Notes cache/outbox writes.
  - Added `POST /api/tasks`, `PATCH /api/tasks/:id`, `DELETE /api/tasks/:id`, and `PUT /api/tasks/:id/pin` for core Tasks cache/outbox writes.
  - Added Task relation cache/outbox routes for Today, schedule items, occurrences, and subtasks.
  - Added Task attachment list/upload/download/delete cache/outbox routes for Local Mode.
  - Added Task CSV import/export and local history routes.
- `[implemented]` Make artifact UI use the daemon loopback URL when Local Mode is enabled.
  - Tree, item read, note create/update/delete, folder create, file upload, and file download route through the daemon.
  - Existing Core route remains active when Local Mode is disabled.
- `[implemented]` Make Projects UI use the daemon loopback URL when Local Mode is enabled.
  - Project list/item/default reads and project create/update/delete/default selection route through the daemon.
  - Existing Core route remains active when Local Mode is disabled.
- `[implemented]` Make Notes UI use the daemon loopback URL when Local Mode is enabled.
  - Note list/item/project reads and note create/update/delete route through the daemon.
  - Existing Core route remains active when Local Mode is disabled.
- `[implemented]` Make Tasks UI use the daemon loopback URL when Local Mode is enabled.
  - Task list/item/project/pin reads and task create/update/delete/pin route through the daemon.
  - Today, schedule, occurrence, subtask, and attachment routes route through the daemon.
  - Import, export, and history routes route through the daemon.
  - Existing Core route remains active when Local Mode is disabled.
- `[implemented]` Add automatic routing mode for supported local-first routes.
  - `Core` mode always uses Core.
  - `Local` mode always uses the daemon.
  - `Auto` mode uses Core while the browser reports online and uses the daemon while offline.
  - `Auto` also falls back to the daemon on Core connection failures, but not on normal Core HTTP/API errors.
  - Offline and fallback routing covers reads plus a strict allowlist of daemon-backed writes; unsupported mutations remain Core-only.
  - A successful allowlisted local write keeps `Auto` on the daemon for read-your-writes until Core succeeds again.
  - The offline-save notice ("Saved locally...") is shown only in `Auto` mode; explicit `Local` mode stays silent.
  - The Tauri desktop shell defaults to `Auto` routing when no mode is stored; the web build keeps `Core` (stored mode > legacy local flag > platform default).
  - Facade writes send `x-workbench-client-op-id` (one UUID per logical mutation, reused across the Core attempt and any daemon fallback); the daemon threads it into outbox items and answers duplicate writes with the first result instead of double-enqueueing.
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
  - Settings can persist per-user Sync Folder and Downloads Folder selections.
  - Desktop-managed daemon startup injects the saved folders as `WORKBENCH_SYNC_ROOT` and `WORKBENCH_DOWNLOADS_DIR`.
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
  - Sidecar bundling rewrites both `manifestStore` and `identityStorage` imports/re-exports so the standalone executable includes secure identity storage.
- `[implemented]` Add optional auto-start.
  - Desktop Settings exposes an Auto-start Daemon toggle.
  - Preference is stored in Tauri app config as `daemon-preferences.json`.
  - On desktop startup, the native shell starts the daemon if auto-start is enabled.
- `[implemented]` Store local client token in OS-backed secure storage instead of plain `.workbench/client-identity.json` when enabled.
  - Windows native secure storage now has a separate `Workbench.LocalDaemonClient` target for daemon `localClientId` / `localClientToken`, distinct from `Workbench.Session`.
  - Tauri-managed daemon startup injects stored credentials as `WORKBENCH_LOCAL_CLIENT_ID` and `WORKBENCH_LOCAL_CLIENT_TOKEN` when neither env var is already set.
  - Native commands can save, inspect non-secret status, and clear the secure daemon client credential.
  - Desktop-managed daemon startup now migrates an existing `.workbench/client-identity.json` from the configured sync folder into OS secure storage when secure storage is supported.
  - After secure credential injection or successful migration, desktop-managed startup sets `WORKBENCH_PERSIST_CLIENT_IDENTITY=0` for the daemon unless the parent env already overrides it.
  - Standalone daemon secure identity storage is opt-in with `WORKBENCH_SECURE_CLIENT_IDENTITY=auto|required` or `WORKBENCH_LOCAL_CLIENT_SECURE_STORAGE=auto|required`.
  - Standalone Windows daemon storage uses DPAPI-protected `.workbench/client-identity.dpapi`.
  - Standalone macOS daemon storage uses the `security` Keychain CLI.
  - Standalone Linux daemon storage uses `secret-tool` / libsecret when available.
  - `required` fails instead of writing plaintext when secure storage is unavailable; `auto` uses secure storage when available and falls back to the identity file.
  - Enabling standalone secure storage migrates an existing `.workbench/client-identity.json` into the secure backend and removes the plaintext file when the secure write succeeds.
  - `clearIdentity` removes plaintext identity files and secure backend entries for smoke tests and cleanup.
  - `npm run secure-identity:smoke --workspace services/sync-daemon` builds the daemon and verifies write/read/cleanup against the current OS secure backend.
  - Windows DPAPI smoke coverage has been verified locally; the same script is available for macOS Keychain and Linux `secret-tool` validation on those OSes.
  - Standalone daemon identity file persistence can be disabled with `WORKBENCH_PERSIST_CLIENT_IDENTITY=0` or `WORKBENCH_LOCAL_CLIENT_IDENTITY_FILE=0`.
  - Persisted standalone identity files are written with restrictive permissions where the OS supports it.
  - Non-desktop standalone daemon startup and first registration still use `.workbench/client-identity.json` by default for backward compatibility unless secure identity storage is explicitly enabled.

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
- `[implemented]` Avoid returning local client tokens from the daemon MCP `workbench.local.clients.current` tool.
  - The tool reports whether a token is present and whether identity came from env or file.
  - It no longer includes the raw `localClientToken`.
- `[implemented]` Add per-job user confirmation policy for downloads outside sync folder.
  - Default remains `off` for backward compatibility.
  - `WORKBENCH_LOCAL_JOB_CONFIRMATION=downloads` or `outside-sync-folder` queues `downloads` target jobs for approval before any bytes are written.
  - `WORKBENCH_LOCAL_JOB_CONFIRMATION=all` queues both `downloads` and `sync-folder` jobs for approval.
  - Pending jobs are visible through `GET /api/local-jobs/pending-confirmations`.
  - Local callers can approve with `POST /api/local-jobs/:jobId/approve`.
  - Local callers can reject with `POST /api/local-jobs/:jobId/reject`, which reports the job as failed to Core.
  - Settings displays pending confirmations and exposes approve/reject actions.
  - `/status` includes `localJobConfirmationPolicy` and `localJobConfirmationsPending`.

## Recommended Next Implementation Order

1. Decide whether packaged standalone daemon builds should default `WORKBENCH_SECURE_CLIENT_IDENTITY=auto` after macOS/Linux smoke runs.
2. Add CI or release-check execution for `secure-identity:smoke` on macOS and Linux runners with unlocked secure storage.
3. Keep the Core-origin mutation guard audit updated when new domain services or route registration files are introduced.

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
If desktop-managed startup finds an existing `.workbench/client-identity.json` and secure storage is supported, it migrates that identity into secure storage, removes the plaintext file, injects env credentials, and disables further daemon identity-file persistence for that process.
Set `WORKBENCH_PERSIST_CLIENT_IDENTITY=0` to keep the registered identity only in memory for the current daemon process; on restart, provide secure env credentials or a normal access token for re-registration.
Set `WORKBENCH_SECURE_CLIENT_IDENTITY=required` to make standalone daemon registration fail rather than writing a plaintext identity file when secure storage is unavailable.
Set `WORKBENCH_SECURE_CLIENT_IDENTITY=auto` to use standalone secure storage when available and fall back to `.workbench/client-identity.json` otherwise.
Run `npm run secure-identity:smoke --workspace services/sync-daemon` to verify the active OS secure identity backend.
Set `WORKBENCH_LOCAL_JOB_CONFIRMATION=downloads` to require local approval before daemon jobs write to the configured downloads folder.
Set `WORKBENCH_LOCAL_JOB_CONFIRMATION=all` to require approval for both downloads and sync-folder materialization jobs.

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
