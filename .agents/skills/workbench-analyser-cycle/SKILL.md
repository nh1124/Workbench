---
name: workbench-analyser-cycle
description: Execute one Workbench Analyser routine end-to-end over MCP - claim a due routine, pull observation metadata, do focused resource reads, save summaries/proposals, perform only allow-listed high-confidence operations, record everything, and complete or fail the run. Use when running scheduled analyser routines (daily-work-summary, progress-record-maintenance, artifact-classification, workbench-knowledge-maintenance, weekly-workbench-digest, agent-skills-materialization) or when asked to "run the analyser". Not for ad-hoc project edits (use workbench-project).
---

# Workbench Analyser Cycle

Analyser stores observations, schedules, summaries, proposals, and operation records; it never
reasons and never mutates Workbench resources itself. You are the reasoning half: pull metadata,
read only what the analysis needs, write conclusions back to Analyser, and touch Workbench
resources only through the existing domain tools under the rules below.

Tool shapes are frozen in
[workbench-maintenance/references/tool-contracts.md](../workbench-maintenance/references/tool-contracts.md).

## The cycle

1. **Claim.** `analyser.routines.claim { holder: "<agent>/<runId>", key? }`. A `null` claim means
   nothing is due — stop and say so; never invent work. The claim returns the run, the routine
   (incl. `skillKey` naming the skill that governs this routine), the effective
   `collectionSettings`, and the `automationPolicy` snapshot. Scheduling state lives only in
   Analyser; do not track or recompute due-ness yourself.
2. **Heartbeat.** For work approaching the lease (default 900s), call
   `analyser.routines.heartbeat` periodically. An expired lease fails the run and another
   claim may take over; stop working on a run once you get `RUN_NOT_ACTIVE`.
3. **Pull.** `analyser.observations.pull { runId, holder }` repeatedly until empty. Observations
   are metadata + `resourceRefs` only (no bodies, by design). Group them by project/resource
   before reading anything.
4. **Focused reads.** Resolve only the refs the analysis needs via normal tools
   (`projects.context.get`, index search, `notes.get`, `artifacts.item.get`, …). Never sweep all
   resources; never copy resource bodies into observations.
5. **Write analysis results into Analyser** (no approval needed for either):
   - `analyser.summaries.upsert` — periodic findings (work summaries, digests). Idempotent per
     `(kind, periodStart, periodEnd)`; always attach `evidenceRefs`; never embed large source
     bodies, secrets, or private content unrelated to the finding.
   - `analyser.proposals.create` — every change to Workbench resources you are NOT allowed to
     perform directly (see below). Use a stable `dedupeKey` so re-runs do not duplicate. Fill
     `proposedAction { kind, params }` and `confidenceEvidence` honestly.
6. **High-confidence direct operations** — allowed ONLY when every one of these holds:
   - `deterministicTarget`: exactly one correct target/destination by explicit rule;
   - `currentEvidence`: the evidence resources still exist and are current (re-read them);
   - `policyAllowed`: `automationPolicy.enabled` and the operation kind is in
     `allowedOperationKinds` (initial allowlist: `artifact_move`, `artifact_metadata_update`,
     `artifact_secondary_membership_add`, `progress_note_upsert`);
   - `concurrencyProtected`: the mutation uses version/optimistic-concurrency fields;
   - `reversibleOrNonDestructive`: small and undoable.
   Perform the mutation with the normal domain tools per `workbench-project` rules, then
   **re-read the authoritative resource and affected membership/index**, then
   `analyser.operations.record { approvalBasis: "policy", beforeRefs, afterRefs, result,
   idempotencyKey }`. Recording never performs the mutation. If any condition fails —
   multiple plausible targets, stale evidence, deletes, primary-membership removal, bulk
   changes, meaning-changing rewrites — create a proposal instead. Numeric confidence alone
   never justifies acting.
7. **Approved proposals.** When a proposal is user-`approved` (Analyser UI), execute its action
   with domain tools, verify by re-reading, `analyser.operations.record { approvalBasis:
   "proposal", proposalId }`, then `analyser.proposals.update { action: "mark_executed",
   operationId }`. You can never approve, reject, or supersede-on-behalf-of-the-user.
8. **Exports.** When a summary or approved proposal should become a durable Note/Artifact,
   create it with the normal tools and `analyser.publications.record` with the content hash so
   identical re-exports are skipped. The Analyser UI has its own export path; both are deduped
   by the same publication table.
9. **Finish.** `analyser.routines.complete { runId, holder }` on success — this atomically
   commits the observation cursor and schedules the next run. On any unrecoverable problem,
   `analyser.routines.fail { runId, holder, errorSummary }` — the cursor does not advance and
   the same observations return on retry, so keep all writes idempotent (dedupe keys,
   idempotency keys, upserts).

## Guardrails

- Agents cannot change collection settings, approve/reject proposals, or edit routine
  schedules; those are owner-only UI paths. `analyser.settings.get` is read-only awareness.
- Do not put resource bodies, prompts, secrets, tokens, window titles, or file contents into
  observations, summaries-as-evidence, or operation details. Evidence = refs.
- One holder string per run (`<agent>/<runId>`); never share holders across concurrent runs.
- If the claim's `skillKey` names another skill (e.g. `workbench-maintenance`,
  `workbench-agent-skills-materialize`), load and follow that skill for steps 4-8; this skill
  still governs the claim/pull/complete mechanics.
- If `analyser.*` tools are missing, the server predates this design — stop and report the
  capability gap; do not fall back to legacy maintenance/insights tools.
