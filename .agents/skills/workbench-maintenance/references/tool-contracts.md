# Workbench Maintenance Tool Contracts

Frozen contracts for the analyser-based maintenance loop, transcribed from the Core MCP
registrations (`registerAnalyserTools.ts`, `registerNotesTools.ts`, `registerProjectContextTools.ts`).
The implementation is authoritative; if the running server's schema disagrees, follow the server.

Shared shapes: `ResourceRef = { service, resourceType, resourceId, pathSnapshot? }` (all strings).
Dates are `YYYY-MM-DD`; datetimes are ISO 8601 with offset. List tools use keyset `cursor`
pagination with `limit` 1..200 (default 50) and return `{ items, nextCursor? }`.

## analyser.* — routine execution

- `analyser.status.get` (read) () → `{ routines: [{ key, enabled, nextRunAt?, lastCompletedAt?,
  lastFailedAt?, lastErrorSummary?, activeRun: { id, holder, leaseExpiresAt } | null }],
  hasOpenProposals, machines }`.
- `analyser.routines.list` (read) () → `{ items: RoutineRecord[] }` — key, schedule
  (`interval` minutes or 5-field cron subset + IANA timezone), enabled, committedCursor, version.
- `analyser.routines.claim` (write) `{ key?, holder, leaseSeconds? (default 900) }` →
  `{ claim: null }` when nothing is due, else `{ claim: { run, routine, collectionSettings,
  automationPolicy } }`. Atomic: one active run per routine; stale leases are auto-failed.
  Claiming does not advance the cursor.
- `analyser.routines.heartbeat` (write, idempotent) `{ runId, holder, leaseSeconds? }` —
  extends the lease and marks the run `processing`. `RUN_NOT_ACTIVE` (409) after expiry.
- `analyser.observations.pull` (write — advances the run's pending cursor)
  `{ runId, holder, limit? 1..500 (default 200) }` → `{ items: Observation[], pendingReadCursor }`.
  Repeat until `items` is empty. Observations carry metadata + resourceRefs ONLY — resolve the
  refs with normal Workbench tools when analysis needs bodies. A failed run re-reads the same
  observations next time; only `complete` commits.
- `analyser.routines.complete` (write) `{ runId, holder }` — atomically commits
  pending→committed cursor and computes `nextRunAt`.
- `analyser.routines.fail` (write) `{ runId, holder, errorSummary (≤2000 chars) }` — records the
  failure; the committed cursor does NOT move; retry backoff then next scheduled slot.

## analyser.* — observations and settings

- `analyser.settings.get` (read) `{ machineId? }` → effective collection settings
  (`workbenchChanges`, `mcpAccess`, `uiAccess`, `agentSessionEvents`, foreground/windowTitle/
  localFile toggles, `screenshots`, retention, allow/deny filters). READ-ONLY for agents:
  collection policy is changed only by the owner in the Analyser UI. Never widen collection.
- `analyser.observations.list` (read) `{ source?, machineId?, projectId?, from?, to?, limit?,
  cursor? }` — ad-hoc inspection outside a run (does not touch cursors). Sources:
  `workbench_change | mcp_access | ui_access | agent_session | pc_activity | local_file`.

## analyser.* — summaries, proposals, operations, publications

- `analyser.summaries.list` (read) `{ kind?, from?, to?, routineKey?, limit?, cursor? }` —
  metadata + `bodyChars`, no bodies. `analyser.summaries.get` (read) `{ id }` → full record.
- `analyser.summaries.upsert` (write, idempotent per `(kind, periodStart, periodEnd)`)
  `{ kind, periodStart, periodEnd, title, bodyMarkdown, metrics?, evidenceRefs?, routineKey?,
  runId?, expectedVersion? }`. Summaries are analysis records inside Analyser — creating one
  needs no approval and it is not yet durable Workbench knowledge.
- `analyser.proposals.list` (read) `{ status?, kind?, routineKey?, limit?, cursor? }`;
  `analyser.proposals.get` (read) `{ id }`.
- `analyser.proposals.create` (write) `{ kind, title, bodyMarkdown, evidenceRefs?,
  proposedAction? { kind, params? }, confidenceEvidence?, routineKey?, runId?, dedupeKey? }` —
  status is always `open`; `dedupeKey` makes re-runs idempotent. No approval needed to CREATE.
- `analyser.proposals.update` (write) — discriminated by `action`:
  - `{ id, action: "update_content", title?, bodyMarkdown?, evidenceRefs?, proposedAction?,
    confidenceEvidence?, expectedVersion }` — allowed only while `open`.
  - `{ id, action: "mark_executed", operationId, expectedVersion }` — allowed only on a
    user-`approved` proposal whose operation is already recorded with `proposalId = id`.
  Agents can NEVER set `approved`/`rejected`; that happens in the Analyser UI only.
- `analyser.operations.record` (write, idempotent per `idempotencyKey`)
  `{ operationKind: artifact_move | artifact_metadata_update |
  artifact_secondary_membership_add | progress_note_upsert, approvalBasis: policy | proposal,
  proposalId? (required for proposal basis), beforeRefs?, afterRefs?, result: succeeded |
  failed | skipped, detail?, runId?, agentLabel?, idempotencyKey }`.
  Record AFTER the domain mutation succeeded via normal Workbench tools; recording performs
  nothing. `policy` basis is validated server-side against the owner's automation policy
  allowlist (403 `POLICY_FORBIDDEN` otherwise); `proposal` basis requires an approved proposal.
- `analyser.publications.record` (write, idempotent per content hash)
  `{ sourceKind: summary | proposal, sourceId, targetKind: note | artifact, targetId,
  targetRef?, contentHash (sha256 hex of the exported content) }` — provenance is forced to
  `agent`. Record after exporting a summary/approved proposal to a Note/Artifact with normal
  tools so identical re-exports are skipped. Check first with `analyser.publications`-recorded
  state via the UI/HTTP if unsure; duplicate records return `created: false` harmlessly.

## sync.changes.consumer.initialize (write — consumer creation only)

Create a NEW consumer positioned at the CURRENT head of the owner's change stream —
no historical events are ever delivered, so a fresh scheduled agent needs no
full-history paging. Idempotent: re-initializing an existing consumer returns its
stored state untouched (`alreadyInitialized: true`) and NEVER resets cursor or scope.
Re-initializing with a different scope fails with `SYNC_CONSUMER_SCOPE_CONFLICT` (409).
There is deliberately no reset/rewind operation.

Input:

```jsonc
{
  "consumer": "string",                // required, 1..100 chars (no default)
  "startAt": "current",                // optional; "current" is the only supported value
  "scope": {                           // optional; permanently bound to the consumer
    "projectId": "string",
    "pathPrefix": "skills/",
    "domains": ["artifacts", "project_context"],
    "resourceTypes": ["note", "folder"],
    "actions": ["create", "update", "delete"]
  }
}
```

Output: `{ "consumer", "cursor", "alreadyInitialized", "scope"?, "initializedAt"? }`

A bound scope is applied automatically on every pull for that consumer and
conflicting per-pull filters are rejected. Consumers created before scopes existed
(e.g. `cowork-agent-skills-incremental`) stay unscoped and may pass ad-hoc filters.

## sync.changes.pull (read, at-least-once)

Input:

```jsonc
{
  "consumer": "string",                // optional, 1..100 chars, default "maintenance-agent"
  "cursor": "string",                  // optional; omit to continue from the stored consumer cursor
  "domains": ["projects", "notes", "artifacts", "tasks", "project_context"], // optional filter
  "limit": 100,                        // optional int 1..500, default 100 — counts MATCHING events
  "projectId": "string",               // optional server-side filter
  "pathPrefix": "skills/",             // optional; matches path OR previousPath (delete/move stay visible)
  "resourceTypes": ["note", "folder"], // optional
  "actions": ["create", "update", "delete", "upsert"], // optional ("move" does not exist; a move is an update whose path changed — previousPath keeps it filterable)
  "includeContent": false,             // optional, default true; false strips resource.contentMarkdown and returns contentLength instead
  "includePatch": false                // optional, default true; false strips payload.patch
}
```

Output:

```jsonc
{
  "consumer": "…",
  "cursor": "…",                       // the start cursor actually used
  "events": [ /* event shape below */ ],
  "nextCursor": "…",                   // commit this after processing
  "appliedScope": { … },               // present when filters were applied
  "scannedThrough": "…"                // present when filters were applied
}
```

Event envelope: events carry denormalized `projectId`, `resourceType`, `path`,
`previousPath` captured at event time (delete events keep the pre-delete
projectId/path; path changes carry previousPath). Older events may lack these fields.

Cursor semantics with filters: the cursor is a position in the GLOBAL owner stream,
not a scope-relative one. Each pull scans a bounded window (up to min(limit×10, 2000)
events); `nextCursor` advances past out-of-scope stretches even when `events` is
empty, so scoped consumers never stall — always commit `nextCursor` after processing.
Events whose scope metadata is unknown are never excluded (at-least-once over loss),
so out-of-scope replays must be tolerated.

Contract: process the batch, then persist `nextCursor` with `sync.changes.commit`.
Uncommitted batches are re-delivered; downstream actions must tolerate replay.

Note: Workbench mutations are ALSO projected automatically into analyser observations
(`source: workbench_change`) by Core's projector. Routine-based analysis should prefer
`analyser.observations.pull`; use `sync.changes.*` directly for sync-style consumers
(e.g. AgentSkills materialization) that need paths and patches.

## sync.changes.commit (write — cursor only)

Input: `{ "consumer": "string" /* optional */, "cursor": "string" /* required */ }`
Output: `{ "consumer", "cursor", "updatedAt" }`

## Cowork recipe: AgentSkills scoped consumer

```jsonc
// One-time setup for a new scheduled consumer (safe to re-run):
sync.changes.consumer.initialize {
  "consumer": "cowork-agent-skills-v2",
  "startAt": "current",
  "scope": {
    "projectId": "936c62d5-1d5a-42af-979b-696c3e4d0526",
    "pathPrefix": "skills/",
    "domains": ["artifacts", "project_context"]
  }
}

// Each scheduled run (bound scope applies automatically). Overlap protection now
// comes from the analyser routine claim (agent-skills-materialization routine);
// there is no separate lease tool.
// includePatch:false too — content edits also appear inside payload.patch:
sync.changes.pull { "consumer": "cowork-agent-skills-v2", "includeContent": false, "includePatch": false }
// …process events, fetch only needed bodies via artifacts.item.get…
sync.changes.commit { "consumer": "cowork-agent-skills-v2", "cursor": "<nextCursor>" }
// Conflicts (locally edited skill would be overwritten) become analyser proposals:
analyser.proposals.create { "kind": "skill_materialization_conflict", "title": "…", "bodyMarkdown": "…", "evidenceRefs": [ … ], "dedupeKey": "skill-conflict:<artifact-item-id>" }
```

## Supporting tools used by this skill

- `projects.list` / `projects.get` — resolve projects and the default project.
- `projects.memory.append` — durable-knowledge proposals; always saved as `agent_observed`.
  `lifecycleState` accepts `raw | triaged` only. Use `supersedesId` for replacement drafts.
- `projects.memory.archive` — retirement proposal for clearly dead knowledge.
- `notes.list` / `notes.create` / `notes.update` — note reads and exports. Notes no longer
  carry lifecycle/review fields.
- `projects.index.rebuild` — repair only, on observed drift; never routine.

## Not available to agents (by design)

- Proposal approve/reject and supersede: Analyser UI only (`/analyser?tab=proposals`).
- Collection and automation policy writes: Analyser UI Settings only. Agents read the
  effective policy via `analyser.settings.get` / the claim's `policySnapshot`.
- Routine schedule/enable changes: Analyser UI Settings (HTTP user path).
- The legacy `maintenance.*` and `insights.*` tools no longer exist; if a server still
  offers them it predates this design — stop and report the version mismatch.

## Digest conventions

- Digest = an analyser summary: `analyser.summaries.upsert` with `kind: "weekly_digest"`,
  `periodStart`/`periodEnd` = the ISO week's Monday/Sunday, title
  `Workbench Weekly Digest <YYYY-Www>` (e.g. `2026-W28`). Idempotent per week by contract.
- Export to a Note only on request (Analyser UI export, or agent-side export + 
  `analyser.publications.record`).
- Digest feed reads must not commit the `maintenance-agent` cursor.
