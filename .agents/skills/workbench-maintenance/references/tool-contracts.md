# Workbench Maintenance Tool Contracts

Frozen contracts for the maintenance loop, transcribed from the Core MCP registrations
(`registerMaintenanceTools.ts`, `registerNotesTools.ts`, `registerProjectContextTools.ts`).
The implementation is authoritative; if the running server's schema disagrees, follow the server.

## maintenance.queue.list (read)

Input:

```jsonc
{
  "kind": "memory | note | brief | index_drift",        // optional
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

## maintenance.flag (write — queue-add only)

Sets only `review_reason` on the target. Cannot promote, confirm, snooze, or clear an item.

Input:

```jsonc
{
  "target": { "type": "memory | note", "id": "string" },
  "reason": "conflict | manual",
  "note": "string"                     // optional; carried in the sync event payload, not persisted on the row
}
```

Output: the updated memory/note resource.

## sync.changes.pull (read, at-least-once)

Input:

```jsonc
{
  "consumer": "string",                // optional, 1..100 chars, default "maintenance-agent"
  "cursor": "string",                  // optional; omit to continue from the stored consumer cursor
  "domains": ["projects", "notes", "artifacts", "tasks", "project_context"], // optional filter
  "limit": 100                         // optional int 1..500, default 100
}
```

Output:

```jsonc
{
  "consumer": "maintenance-agent",
  "cursor": "…",                       // the start cursor actually used
  "events": [ /* same event shape as /api/sync/pull; project_context events carry payload.changed */ ],
  "nextCursor": "…"                    // present when events were returned
}
```

Contract: process the batch, then persist `nextCursor` with `sync.changes.commit`.
Uncommitted batches are re-delivered; downstream actions must tolerate replay.

## sync.changes.commit (write — cursor only)

Input: `{ "consumer": "string" /* optional */, "cursor": "string" /* required */ }`
Output: `{ "consumer", "cursor", "updatedAt" }`

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
