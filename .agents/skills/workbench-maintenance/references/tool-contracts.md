# Workbench Maintenance Tool Contracts

Frozen contracts for the maintenance loop, transcribed from the Core MCP registrations
(`registerMaintenanceTools.ts`, `registerNotesTools.ts`, `registerProjectContextTools.ts`).
The implementation is authoritative; if the running server's schema disagrees, follow the server.

## maintenance.queue.list (read)

Input:

```jsonc
{
  "kind": "memory | note | brief | index_drift | artifact", // optional
  "reason": "raw | expired | unconfirmed | conflict | manual | source_changed | unused | brief_unmaintained | brief_oversized", // optional
  "projectId": "string",                                 // optional
  "cursor": "string",                                    // optional, opaque compound cursor
  "limit": 1                                             // optional int 1..100, default 20
}
```

Output:

```jsonc
{
  "items": [
    {
      "id": "<kind>:<resourceId>",
      "kind": "memory | note | brief | index_drift",
      "projectId": "…",
      "projectName": "…",
      "resourceId": "…",
      "title": "…",                    // memory: first body line, brief: project name
      "excerpt": "…",                  // ~200 chars
      "reasons": ["unconfirmed"],      // one or more
      "authority": "agent_observed",   // memory only
      "lifecycleState": "triaged",     // memory/note only
      "lastConfirmedAt": null,
      "reviewAfter": null,
      "updatedAt": "ISO datetime",
      "suggestedActions": ["confirm", "supersede", "archive"]
    }
  ],
  "nextCursor": "…",                    // present when more pages exist
  "totals": { "byReason": { "raw": 3, "unconfirmed": 7 } }
}
```

Reason semantics: `raw` (untriaged), `expired` (`reviewAfter` passed), `unconfirmed`
(old `agent_observed` memory never confirmed), `conflict`/`manual` (flagged),
`source_changed` (index entry behind its source), `unused` (index entry unread past the
threshold), `brief_unmaintained` (empty or too-short brief), `brief_oversized`
(brief larger than the slimness threshold; propose moving detail out).

`artifact` kind items are open Artifact maintenance flags. They carry the common shape
plus `path`, `artifactKind` (folder|note|file), `version`, `flaggedBy`, `flaggedAt`;
`resourceId` is the Artifact item id, `suggestedActions` is `["resolve"]`.

## maintenance.flag (write — queue-add only)

For memory/note: sets only `review_reason` on the target. Cannot promote, confirm,
snooze, or clear an item. For artifact: opens (or updates in place) the single open
maintenance flag on an Artifact item of any kind; the flag row keeps audit history.

Input:

```jsonc
{
  "target": { "type": "memory | note | artifact", "id": "string" },
  "reason": "conflict | manual",
  "note": "string"                     // optional; memory/note: carried in the sync event payload only. artifact: persisted on the flag row
}
```

Output: the updated memory/note resource, or the Artifact flag joined with
`artifact: { id, projectId, projectName, title, path, kind, version }`.

`type: "artifact"` targets an Artifacts-service item by item id (any kind).
`type: "note"` still means a Notes-service note — the two are never interchangeable.
Re-flagging an item with an open flag updates reason/note/flaggedBy in place
(no duplicate open flags). Other-owner or missing items return 404.

## maintenance.review.resolve (write)

Resolves the open maintenance flag on an Artifact item. The resolved row is kept as
audit history (`status: "resolved"`, `resolvedBy`, `resolvedAt`, `resolutionNote`);
nothing is deleted. Errors (404) when no open flag exists. Works even if the Artifact
item was deleted after flagging.

Input: `{ "target": { "type": "artifact", "id": "string" }, "note": "string" /* optional */ }`
Output: the resolved flag joined with the artifact info (see maintenance.flag).

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

## sync.changes.commit (write — cursor only)

Input: `{ "consumer": "string" /* optional */, "cursor": "string" /* required */ }`
Output: `{ "consumer", "cursor", "updatedAt" }`

## maintenance.lease.acquire / renew / release (write — advisory locks)

Prevent overlapping scheduled maintenance runs. Advisory only; Workbench runs no
scheduler. Owner-scoped; `key` and `holder` are 1..100 chars, `ttlSeconds` 1..86400
(default 1800).

- `acquire { key, holder, ttlSeconds? }` → `{ key, holder, expiresAt, acquiredAt, renewedAt? }`.
  Idempotent for the same holder (extends TTL). While another holder's lease is
  unexpired: `MAINTENANCE_LEASE_HELD` (409). Expired leases are reclaimable by anyone,
  so a crashed run recovers after TTL without manual cleanup.
- `renew { key, holder, ttlSeconds? }` — extends an unexpired lease held by this
  holder; otherwise `MAINTENANCE_LEASE_NOT_HELD` (409).
- `release { key, holder }` → `{ released: boolean }`; never errors on missing,
  expired, or foreign leases.

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

// Each scheduled run (bound scope applies automatically):
maintenance.lease.acquire { "key": "agent-skills-primary-maintainer", "holder": "cowork-agent-skills-v2" }
sync.changes.pull { "consumer": "cowork-agent-skills-v2", "includeContent": false }
// …process events, fetch only needed bodies via artifacts.item.get…
sync.changes.commit { "consumer": "cowork-agent-skills-v2", "cursor": "<nextCursor>" }
maintenance.lease.release { "key": "agent-skills-primary-maintainer", "holder": "cowork-agent-skills-v2" }

// The pre-existing consumer "cowork-agent-skills-incremental" is unscoped:
// keep pulling with explicit filters instead —
sync.changes.pull {
  "consumer": "cowork-agent-skills-incremental",
  "projectId": "936c62d5-1d5a-42af-979b-696c3e4d0526",
  "pathPrefix": "skills/",
  "includeContent": false
}
// Flag a Skill for review / resolve after handling:
maintenance.flag { "target": { "type": "artifact", "id": "<artifact-item-id>" }, "reason": "conflict", "note": "…" }
maintenance.review.resolve { "target": { "type": "artifact", "id": "<artifact-item-id>" }, "note": "…" }
```

## maintenance.usage.summary (read)

Input: `{ "since": "ISO datetime" /* optional, default last 30 days */, "until": "ISO datetime" /* optional */ }`

Output:

```jsonc
{
  "since": "…",
  "until": "…",
  "truncation": { "count": 4, "bySection": [{ "section": "index", "count": 3 }] },
  "zeroHitQueries": [{ "queryText": "…", "count": 2 }],   // missing-knowledge signals
  "topResources": [{ "sourceService": "artifacts", "resourceType": "note", "resourceId": "…", "count": 9 }]
}
```

## insights.* (activity analysis)

Aggregated capture activity from machines that opted into upload. All reads are scoped to the
authenticated user. If the server answers "Insights service is not configured", the deployment
has no insights service — skip activity analysis and say so.

- `insights.machines.list` () → `{ items: [{ id, machineKey, displayName?, platform?, registeredAt, lastSeenAt }] }`
- `insights.activity.query` ({ from, to, machineId? }) — dates `YYYY-MM-DD`, both inclusive →
  `{ totals: { activeSeconds, idleSeconds, contextSwitches }, categories: { <name>: seconds }, apps: { <name>: seconds }, days: [{ date, machineId, activeSeconds, contextSwitches }] }`
- `insights.summaries.list` ({ machineId?, from?, to?, limit?, cursor? }) → metadata + `metricsJson`, no markdown bodies; keyset cursor.
- `insights.summaries.get` ({ machineId, date }) → one summary including `summaryMarkdown`
  (App Activity / Top Window Titles / Timeline / Focus Blocks / Context Switches / Categories / Idle Time).
- `insights.derived.ingest` ({ machineId?, observedDate, kind, title, contentMarkdown, payloadJson? }) —
  the only agent write into insights. Text derived from local-only sources (screenshots) after
  explicit human-directed processing; never image data, never automated.
- `insights.derived.list` ({ from?, to?, kind?, limit?, cursor? }) → prior derived observations.

Analysis conclusions do not go into insights; they become memory/note proposals via the
supporting tools below.

## Supporting tools used by this skill

- `projects.list` / `projects.get` — resolve projects and the default project.
- `projects.memory.append` — proposals only; always saved as `agent_observed`.
  `lifecycleState` accepts `raw | triaged` only. Use `supersedesId` for replacement drafts.
- `projects.memory.archive` — retirement proposal for clearly dead knowledge.
- `notes.list` / `notes.create` / `notes.update` — digest note search and idempotent upsert.
  `notes.create` accepts `lifecycleState` of `raw | triaged` only.
- `projects.index.rebuild` — repair only, on observed drift; never routine.

## Not available to agents (by design)

Confirm and snooze exist only as UI-path HTTP routes
(`POST /api/project-memories/:id/confirm|snooze`, `POST /api/notes/:id/confirm|snooze`).
They are intentionally unregistered as MCP tools; do not call them over HTTP either —
they record a user/UI caller. Direct the user to the /maintenance UI for promotion.

## Digest conventions

- Note title: `Workbench Weekly Digest <YYYY-Www>` (ISO week, e.g. `2026-W28`).
- Tag: `workbench-maintenance`. Location: default project.
- Idempotent: search by exact title first; update when found, create otherwise.
- Digest feed reads must not commit the `maintenance-agent` cursor.
