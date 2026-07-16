# Project Context Offline Writes (E2) Implementation Plan

Continues `project-context-sync-export-plan.md` (E1). E1 froze the daemon context cache as read-only (D-E1-002) and deferred offline writes (D-E1-007). Two E1 prerequisites are now resolved: server-side `clientOpId` deduplication landed with the Phase 2 offline-write work (`sync_applied_client_ops`, commit f25e342); outbox OCC semantics are defined here.

## Status Legend

- `[implemented]`: Code exists and builds.
- `[partial]`: Skeleton or first usable path exists, but production behavior is incomplete.
- `[pending]`: Not implemented yet.

## 1. Scope

In scope — offline (Auto fallback / Local mode) writes for the three context entities the E1 cache already serves as local reads:

- Project brief update (`PUT /api/projects/:id/brief`)
- Project memory append / update / archive (`POST /api/projects/:id/memories`, `PATCH /api/project-memories/:id`)
- Project relation create / update / delete (`POST /api/projects/:id/relations`, `PATCH|DELETE /api/project-relations/:id`)

Out of scope:

- Project links and Artifact project membership: E1 does not cache their read state (D-E1-002). Queuing writes without local reads would break read-your-writes, so they stay on the daemon 503 guard until an E3 cache extension.
- Index rebuild and context-summary refresh: server-side recomputations; permanently Core-only.
- Offline chaining onto offline-created entities, conflict merge UI, relation ID remapping (still deferred, D-E1-007).

## 2. Decisions

### D-E2-001 Sync push op contract

Daemon outbox ops use the `project_context` domain with a `relation` discriminator. `resourceId` is always the project id.

```json
{ "domain": "project_context", "action": "update", "relation": "brief",    "resourceId": "<projectId>", "payload": { "contentMarkdown": "...", "expectedVersion": 3 } }
{ "domain": "project_context", "action": "create", "relation": "memory",   "resourceId": "<projectId>", "payload": { "kind": "decision", "bodyMarkdown": "..." } }
{ "domain": "project_context", "action": "update", "relation": "memory",   "resourceId": "<projectId>", "payload": { "memoryId": "...", "patch": { } } }
{ "domain": "project_context", "action": "create", "relation": "relation", "resourceId": "<projectId>", "payload": { "targetProjectId": "...", "relationType": "..." } }
{ "domain": "project_context", "action": "update", "relation": "relation", "resourceId": "<projectId>", "payload": { "relationId": "...", "patch": { } } }
{ "domain": "project_context", "action": "delete", "relation": "relation", "resourceId": "<projectId>", "payload": { "relationId": "..." } }
```

Core `POST /api/sync/push` applies these with the same internal Projects client calls as the REST facade (`updateBrief` with `updatedByKind: "user"`, `appendMemory`, `updateMemory`, `createRelation`, `updateRelation`, `removeRelation`) and emits invalidations through the shared adapter (`invalidateProjectContextFromApi` / `recordProjectContextInvalidationsBestEffort`) — never legacy `projects`-domain context events (D-E1-001 preserved). Relation mutations invalidate both endpoint projects, mirroring the REST handlers.

`clientOpId` idempotency: the push path must guarantee that a successfully applied op lands in `sync_applied_client_ops` before the response is returned (synchronous invalidation recording on this path, or a direct ledger insert), so a replayed op is answered with `deduplicated: true` and never re-applied.

### D-E2-002 OCC / conflict semantics

- Brief: the daemon enqueues `expectedVersion` captured from the cached brief at write time. A replay `409` version conflict becomes a daemon conflict record (existing `version_conflict` classification); no silent overwrite.
- Memory append: no OCC (append-only); duplicate protection is `clientOpId`.
- Memory update/archive and relation update/delete: allowed only for server-known ids that exist in the local cache at enqueue time; last-writer-wins on replay; a replay `404` becomes a `validation` conflict record.
- Entities created offline receive local temp ids (`local-<uuid>`) in the optimistic cache. Further offline mutations referencing a temp id are rejected with `409 LOCAL_PENDING_RESOURCE` — no offline op chaining in E2.

### D-E2-003 Daemon optimistic cache echo

After enqueueing, the daemon applies the user's own pending write to the cached context item (brief content, appended memory with temp id, relation with temp id), marks the item as having pending local ops, and answers the loopback request with the optimistic entity. D-E1-003 (invalidate + refetch is authoritative) still governs convergence: once the op is applied and the invalidation arrives, the refetched pack replaces the optimistic state. The local echo exists only for read-your-writes of the user's own queued ops.

### D-E2-004 UI allowlist additions

`LOCAL_DAEMON_WRITE_ROUTES` gains: `PUT /api/projects/:id/brief`, `POST /api/projects/:id/memories`, `PATCH /api/project-memories/:id`, `POST /api/projects/:id/relations`, `PATCH|DELETE /api/project-relations/:id`. Links, membership, index rebuild, and context-summary stay excluded (daemon 503 guard narrows accordingly — it must keep rejecting only what remains unsupported).

## 3. Slices / Progress

- `[implemented]` S1 Core: `project_context` push apply branch (brief/memory/relation), synchronous invalidation + `clientOpId` ledger guarantee, applied/rejected mapping with stable error codes, tests (apply, replay dedupe, version conflict, unknown relation rejection). (commit f58b183)
- `[implemented]` S2 Daemon: outbox writes + optimistic cache echo for the supported routes, temp-id rules, replay conflict classification, narrowed 503 guard; pushOutbox skips remote-resource upserts for applied `project_context` ops. (commit a5e0a7d)
- `[implemented]` S3 UI: six context-write allowlist entries + routing tests; links/membership/index/summary remain Core-only.

## 4. Verification

```powershell
npx tsc --noEmit   # in services/workbench-core, services/sync-daemon, ui
npm test --workspace services/workbench-core   # requires workbench-core-db container
npm test --workspace services/sync-daemon
npx vitest run     # in ui
```
