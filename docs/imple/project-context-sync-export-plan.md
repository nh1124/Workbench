# Project Context Local Sync / Export Implementation Plan

Status: Gate 0 approved; implementation in progress
Last updated: 2026-06-21

Related documents:

- [Project Agent Context design](../project-agent-context-design.md)
- [Project Agent Context implementation result](project-agent-context-implementation-plan.md)
- [Local client / sync daemon plan](workbench-local-client-sync-daemon-plan.md)

## 1. Scope

This phase adds a read-only local Project context cache and an explicit one-way `.workbench` export. It does not add offline Project context mutations, import, or file watching.

Implementation order:

```text
sync safety fixes
  -> project_context contract
  -> Core snapshot/invalidation producer
  -> daemon read-only cache/facade
  -> explicit live-Core export
```

## 2. Decisions

### D-E1-001 Separate sync domain

Project brief, memory, relation, link, summary, index state, and Artifact membership invalidation must never be written to the existing `projects` sync domain. `projects` remains the cache of Project records only.

The new sync domain is `project_context`.

### D-E1-002 Read-only local cache

The E1 daemon cache exposes Project context reads only. Missing write capabilities return `503 LOCAL_PROJECT_CONTEXT_READ_ONLY`; they must not queue ambiguous outbox operations.

The first cached read model contains:

- Project record
- Project brief
- active memory entries
- incident Project relations
- truncation/freshness metadata

Index entries, Project links, generated summary, and secondary membership are not cached in E1. Their changes may invalidate future cache versions but are not silently represented as complete local state.

The sync source is not the existing budgeted context assembler: that read model discards section pagination. Projects provides a dedicated snapshot that fully drains active memory and incident relations. A cache item is accepted only with `complete: true`; row/byte limit overflow fails with `413 PROJECT_CONTEXT_SYNC_LIMIT_EXCEEDED` and never masquerades as character-budget truncation.

### D-E1-003 Invalidation plus refetch

Incremental events are small invalidations. The daemon refetches the authoritative bounded pack from Core rather than reconstructing context from partial mutation payloads.

```json
{
  "domain": "project_context",
  "resourceId": "<projectId>",
  "action": "update",
  "payload": {
    "schemaVersion": 1,
    "kind": "invalidate",
    "projectId": "<projectId>",
    "changed": ["brief"],
    "entityType": "brief",
    "entityId": "<projectId>",
    "source": "core-api"
  }
}
```

Allowed `changed` values are `project`, `brief`, `memory`, `relation`, `link`, `summary`, `index`, and `membership`. Relation mutations emit one invalidation event for each affected Project. Project deletion emits a `project_context` delete event keyed by the Project ID.

Unknown fields are ignored for forward compatibility. Unknown schema versions are not applied; they trigger a full context rescan request.

### D-E1-004 Snapshot and detail contract

Projects internal routes are frozen as:

```text
GET /projects/:projectId/sync-context
GET /projects/:projectId/context-export
GET /project-relations/:relationId
```

`sync-context` returns `{ projectId, complete, counts, project, brief, memories, relations }`. `context-export` returns the export response fixture below and may include internal `ownerAccountId`; Core removes it. Relation lookup is owner-scoped and returns the full relation or `404`.

Core exposes local-client-authenticated, owner-scoped reads:

```text
GET /api/sync/project-context/:projectId
GET /api/sync/snapshot?domains=project_context&cursor=&limit=
```

The detail response is:

```json
{
  "schemaVersion": 1,
  "projectId": "project-id",
  "fetchedAt": "ISO-8601",
  "baselineCursor": "12345",
  "complete": true,
  "counts": {
    "memories": 12,
    "relations": 3
  },
  "context": {
    "project": {},
    "brief": {},
    "memories": [],
    "relations": []
  }
}
```

The snapshot response adds capability and watermark metadata:

```json
{
  "generatedAt": "ISO-8601",
  "baselineCursor": "12345",
  "supportedDomains": ["projects", "notes", "artifacts", "tasks", "project_context"],
  "domains": {
    "project_context": {
      "items": [],
      "nextCursor": "project-list-cursor"
    }
  }
}
```

Every item has the same data shape as the detail response and the snapshot-level `baselineCursor`. Core captures `baselineCursor` before reading cross-service snapshot data; the daemon applies the snapshot and then drains events strictly after that cursor. Duplicate invalidations are safe because refetch is authoritative.

For a paged bootstrap, the daemon retains the first page's `baselineCursor`, passes it back as `baselineCursor` on every subsequent snapshot page, ignores later recaptured values, and drains from the retained first-page cursor only after all pages are applied. Core echoes a supplied baseline unchanged. This prevents changes after page 1 from falling behind a later page watermark.

Project pagination drives snapshot pagination. Owner isolation uses the local client's owning user and `sync.pull` capability. The Projects internal snapshot uses one `REPEATABLE READ READ ONLY` transaction for a Project item and returns `complete`, exact counts, and canonical ordering.

E1 snapshot defaults cap active memory at 5,000 rows, incident relations at 5,000 rows, any serialized row at 1 MiB, and the Project context item at 20 MiB. Exceeding a cap fails the item; it does not produce partial cache state. The local `projects.context.get` facade applies caller `q`, section limits, and `maxChars` only when deriving a response from the complete cached item.

The local facade overlays the current `projects` domain Project record on the context snapshot's Project fallback. Project rename/status/default changes therefore remain sourced from the existing Project cache.

### D-E1-005 Compatibility

- Old daemons ignore the unknown `project_context` domain and continue advancing the shared cursor.
- New daemons ignore legacy context-shaped `projects` events instead of mutating the Project cache.
- New daemons require `supportedDomains` to contain `project_context` before marking context bootstrap complete or clearing context cache. An old Core's empty response for an unknown domain is treated as unsupported, not as an empty authoritative snapshot.
- New daemons continue normal Artifact/Notes/Tasks/Project sync when an old Core does not support `project_context`.
- A full rescan retries capability detection and replaces stale context rows without deleting other manifest data.
- MCP and HTTP mutations must call the same invalidation adapter. Agent-originated MCP writes cannot be omitted.
- Core resolves relation source/target before deletion through an owner-scoped Projects relation read, then emits invalidation for both endpoints after successful deletion.

### D-E1-006 Explicit one-way export

Export always reads a fresh, complete owner-scoped snapshot from Core. It never exports from daemon SQLite fallback state.

```text
GET  /api/sync/projects/:projectId/context-export
POST /api/project-context/exports
MCP  workbench.local.project_context.export
```

The Core export snapshot contains Project, brief, all memory statuses, incident relations, Project links, active index entries, and generated summary. The Projects service reads it in one `REPEATABLE READ READ ONLY` transaction with canonical ordering. Export does not use context character budgeting; count/line/total-byte limits fail the operation instead of truncating it.

Core response fixture:

```json
{
  "schemaVersion": 1,
  "packageType": "workbench.project-context-export",
  "generatedAt": "ISO-8601",
  "complete": true,
  "project": {},
  "brief": {},
  "memories": [],
  "relations": [],
  "links": [],
  "indexEntries": [],
  "generatedSummary": null,
  "counts": {
    "memories": 0,
    "relations": 0,
    "links": 0,
    "indexEntries": 0
  }
}
```

Core removes `ownerAccountId` before returning this response. The default hard limits are 10,000 memories, 10,000 relations, 50,000 links, 100,000 index entries, 1 MiB per serialized record, and 100 MiB for the response. Limit overflow returns `413 PROJECT_CONTEXT_EXPORT_LIMIT_EXCEEDED`.

Output layout:

```text
.workbench/project-context/<base64url-project-id>/
  current.json
  snapshots/<export-id>/
    manifest.json
    PROJECT.md
    memory.jsonl
    relations.jsonl
    links.jsonl
    index.jsonl
    summary.json
```

`manifest.json` includes `schemaVersion`, `exportId`, source Project ID, export time, brief base version, record counts, SHA-256 per file, and `importPolicy`. `index.jsonl` is marked `authoritative: false` and `importPolicy: ignore`.

Frozen manifest/current shapes:

```json
{
  "schemaVersion": 1,
  "packageType": "workbench.project-context-export",
  "exportId": "uuid",
  "projectId": "stable-id",
  "projectUpdatedAt": "ISO-8601",
  "createdAt": "ISO-8601",
  "briefVersion": 0,
  "counts": {
    "memories": 0,
    "relations": 0,
    "links": 0,
    "indexEntries": 0
  },
  "files": {
    "PROJECT.md": { "sha256": "hex", "bytes": 0, "records": 1 },
    "memory.jsonl": { "sha256": "hex", "bytes": 0, "records": 0 },
    "relations.jsonl": { "sha256": "hex", "bytes": 0, "records": 0 },
    "links.jsonl": { "sha256": "hex", "bytes": 0, "records": 0 },
    "index.jsonl": {
      "sha256": "hex",
      "bytes": 0,
      "records": 0,
      "authoritative": false,
      "importPolicy": "ignore"
    },
    "summary.json": { "sha256": "hex", "bytes": 0, "records": 0 }
  },
  "importPolicy": "unsupported",
  "containsSensitiveData": true
}
```

```json
{
  "schemaVersion": 1,
  "exportId": "uuid",
  "snapshot": "snapshots/<export-id>",
  "manifestSha256": "hex",
  "updatedAt": "ISO-8601"
}
```

JSONL order is canonical: memories by `createdAt,id`; relations by `sourceProjectId,targetProjectId,relationType,id`; links by `linkedAt,id`; index by `sourceService,resourceType,path,resourceId,associationKind,id`. Each JSON/JSONL file ends with one LF; checksums cover the exact UTF-8 bytes written. `PROJECT.md` contains Project display metadata and the brief only. `summary.json` contains the generated summary or JSON `null`.

Export writes all files as UTF-8/LF into a same-parent staging directory, verifies counts and checksums, atomically renames it to the immutable snapshot directory, then atomically replaces `current.json`. A failed export leaves the previous `current.json` unchanged.

Project names never become path segments. The daemon verifies realpath containment, rejects symlink/reparse-point targets, avoids tokens/owner IDs/local paths in exported content, and applies owner-only filesystem permissions where supported.

Stable error codes are `PROJECT_CONTEXT_EXPORT_LIMIT_EXCEEDED`, `PROJECT_CONTEXT_EXPORT_UNAVAILABLE`, `PROJECT_CONTEXT_EXPORT_PATH_UNSAFE`, `PROJECT_CONTEXT_EXPORT_SYMLINK_REJECTED`, and `PROJECT_CONTEXT_EXPORT_WRITE_FAILED`. Core/Projects service failures do not fall back to stale SQLite data and do not update `current.json`.

### D-E1-007 Deferred work

The following remain out of scope:

- offline brief/memory/relation/link writes
- import or edited-package apply
- automatic export/import file watching
- conflict merge, relation ID remapping, and cross-workspace import
- server-side `clientOpId` deduplication and context-entity outbox OCC
- local index rebuild and index import

## 3. Safety wave

### Branch `codex/sync-event-store-safety`

- Use one checked-out PostgreSQL client for the entire sync event transaction.
- Roll back on failure and always release the client.
- Add a test proving transaction statements and event/version writes share one client.

### Branch `codex/sync-daemon-project-context-safety`

- Ignore legacy context-shaped `projects` events in the generic Project cache consumer.
- Preserve normal Project CRUD/default events and cursor progress.
- Add regressions for brief replacement and fake memory/relation Project rows.

Both safety branches are independently mergeable before the new domain exists.

## 4. Implementation branches

| Branch | Ownership | Deliverable |
|---|---|---|
| `codex/project-context-sync-snapshot` | `services/projects/**` | complete context snapshot, relation lookup, canonical export snapshot |
| `codex/project-context-sync-core` | `services/workbench-core/**` | domain, mutation invalidation adapter, sync detail/snapshot API |
| `codex/project-context-sync-daemon` | `services/sync-daemon/**` | cache apply/refetch, rescan, read-only loopback facade |
| `codex/project-context-export-snapshot` | Core client/facade | owner-scoped export facade and response redaction |
| `codex/project-context-export-daemon` | `services/sync-daemon/**` | atomic package writer, loopback route, MCP tool |

Agents do not merge or commit their branches. The root agent reviews, requests corrections, commits approved scopes, and integrates them in dependency order.

## 5. Approval gates

1. Safety: Project cache cannot be corrupted by context-shaped events; sync event writes are atomic.
2. Contract: fixtures freeze domain/envelope, snapshot/detail responses, unsupported-version behavior, and export manifest.
3. Core: HTTP and MCP context mutations emit equivalent invalidations; relation changes affect both Projects.
4. Daemon: snapshot and event replay converge; duplicate/out-of-order/delete/self events are safe; old Core remains usable.
5. Local reads: context, brief, memory, and relation results preserve authority/version/truncation semantics and loopback auth.
6. Export: complete live snapshot, deterministic serialization, checksums, path safety, atomic current pointer, and watcher isolation.
7. Final: Core, Projects, daemon, E2E, full build, and skill contract review pass.

## 6. Verification

```powershell
npm run build --workspace services/projects
npm run test --workspace services/projects
npm run build --workspace services/workbench-core
npm run test --workspace services/workbench-core
npm run build --workspace services/sync-daemon
npm run test --workspace services/sync-daemon
npm run test:e2e:api
npm run build
```

DB-backed and live E2E tests require Docker/PostgreSQL. When unavailable, their skip/non-run status must be recorded explicitly rather than treated as a pass.
