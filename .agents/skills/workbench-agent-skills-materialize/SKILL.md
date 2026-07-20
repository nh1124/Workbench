---
name: workbench-agent-skills-materialize
description: One-way materialization of the canonical AgentSkills store (Workbench Artifacts, project AgentSkills, path skills/) into a local agent's skill cache. Use for the agent-skills-materialization analyser routine or when asked to sync/materialize/update local skills from Workbench. Never reverse-syncs local edits.
---

# Workbench AgentSkills Materialization

The canonical source of every skill is the AgentSkills Project in Workbench
(projectId `936c62d5-1d5a-42af-979b-696c3e4d0526`, Artifact path `skills/`). Local agent skill
directories (e.g. `.agents/skills/`, `~/.claude/skills/`, a Codex skills dir) are read-only
caches materialized from it. This skill defines the one-way flow; there is no product code for
it — the procedure below IS the mechanism.

Runs as the `agent-skills-materialization` analyser routine
([workbench-analyser-cycle](../workbench-analyser-cycle/SKILL.md) governs claim/complete) or on
demand.

## Manifest

Keep a local manifest (JSON file beside the cache, e.g. `.agents/skills/.materialize-manifest.json`)
mapping each materialized file to `{ artifactItemId, path, version, contentHash (sha256 of the
materialized bytes), materializedAt }`. The manifest is the only memory of what came from where;
never guess from file contents alone.

## Procedure

1. **Detect changes.** Use the scoped sync consumer from tool-contracts.md (`pathPrefix:
   "skills/"`, `includeContent:false`, `includePatch:false`) or, for a full check, list the
   `skills/` tree via `artifacts.tree`/`artifacts.tree.list` and compare versions against the
   manifest.
2. **Fetch.** For each changed item, `artifacts.item.get` the body. Compute its content hash.
   Same hash as the manifest → no-op (do not rewrite the file, do not update timestamps).
3. **Local-edit safety.** Before overwriting, hash the current local file. If it differs from
   the manifest's recorded hash, the file was edited locally: do NOT overwrite. Create a
   proposal instead (`analyser.proposals.create`, `kind: "skill_materialization_conflict"`,
   `dedupeKey: "skill-conflict:<artifactItemId>"`, body showing both provenances) and skip the
   file this run. Local edits are never pushed back to Workbench automatically — canonical
   changes flow Workbench → local only.
4. **Atomic write.** Write the new content to a temp directory first, validate (step 5), then
   atomically replace the target file(s) and update the manifest in the same pass.
5. **Validate.** A skill is `SKILL.md` plus its `references/` files: materialize them together,
   never partially. Check that every relative link inside the materialized `SKILL.md` resolves
   within the materialized set; a broken link fails validation → keep the previous local
   version, file a `skill_materialization_conflict` proposal with the broken path.
6. **Adapters.** The install target per agent (directory layout, frontmatter expectations)
   lives in a thin per-agent adapter/config, not in this skill. Keep adapters minimal; the
   content itself is agent-neutral.
7. **Record.** Complete the routine run normally. Summarize what changed (files updated,
   no-ops, conflicts) in the run's summary when one is warranted.

## Guardrails

- One direction only: never write local edits into Workbench artifacts from this flow. If a
  local improvement is worth keeping, propose it (proposal or explicit user-driven edit of the
  canonical artifact) — then it flows back down.
- Never delete local files that the manifest does not own.
- Never materialize from an unverified source; only the AgentSkills project's `skills/` tree.
- Secrets never belong in skills; if canonical content appears to contain one, stop and file a
  proposal instead of materializing it.
