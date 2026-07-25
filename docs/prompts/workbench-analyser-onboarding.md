# Prompt — Workbench Analyser Onboarding

**What this is.** A setup instruction you hand to an agent (Claude, Codex, cowork, …) that has
the Workbench MCP tools connected. It is deliberately **not** an AgentSkill: skills are
auto-discovered and applied by an agent when relevant, whereas this is a one-off runbook a person
invokes on purpose. The canonical copy lives in the AgentSkills project at
`prompts/workbench-analyser-onboarding.md` — outside `skills/`, so it is never picked up by the
skill catalog as a routine's `skillKey`.

**How to use.** Paste everything below the line into an agent session, once per user account.
Run it again any time routines stop firing.

---

## Task: set up Workbench Analyser for me

Analyser stores observations and schedules, but it **never runs anything by itself**. A routine
only executes when an external scheduler periodically calls `analyser.routines.claim`. Your job is
to wire that missing half in your own environment and then prove it works.

How to *execute* a routine is out of scope here — the `workbench-analyser-cycle` skill governs
that. This task only makes the cycle start happening.

### The one idea that saves the most work

**Analyser owns the schedule. Register ONE poll job per host — never one per routine.**

`claim` returns whichever routine is currently due (or `null`). The scheduler therefore needs no
knowledge of routine names, cron expressions, or timezones, and adding or retiming routines later
requires no scheduler change. If you find per-routine cron entries, collapse them into one job.

Concurrent pollers are safe (claim locks with `FOR UPDATE SKIP LOCKED` plus a unique active-run
index), so a second host may poll too — but one is enough.

### 1. Preflight

- Confirm the `analyser.*` MCP tools are available. If they are missing, the server predates this
  design or the connection is not authenticated — stop and report that, do not improvise.
- Call `analyser.status.get`. This single call carries everything you need: `routines`,
  `machines`, `hasOpenProposals`, and `runnerHealth`.

### 2. Report the owner-only gaps (do not attempt these yourself)

Creating, seeding, retiming, enabling, or disabling routines is an **owner-only UI path**; agents
cannot do it. From step 1's data, tell me plainly:

- `routines` empty → "No routines exist. Open the Analyser UI → Routines and press *Seed default
  routines* (or create your own), then re-run this setup."
- routines present but `enabled: false` → list them; they must be enabled in the UI.
- any routine with `skillMissing: true` → its canonical skill is absent from the AgentSkills
  store, so Analyser is deliberately blocking its claims (fail-safe). Report the routine and its
  `skillKey`; the fix is restoring the skill in the canonical store, not editing Analyser.

If there are no routines at all, wiring a poller is pointless — stop after reporting and ask me to
seed first.

### 3. Wire ONE recurring poll job in THIS environment

Detect what you are running on and use its native scheduling primitive:

- **Agent platforms with built-in scheduling** (Claude Code `CronCreate` / the `schedule` skill, a
  cowork routine, any host with its own cron facility): register the recurring job yourself. This
  is the fully automatic path — no action needed from me.
- **Plain CLI agents with no self-scheduling** (e.g. a bare `codex exec` install): you cannot
  self-register. Emit exactly one ready-to-paste entry for my OS (crontab line, systemd timer, or
  Windows Task Scheduler command) that invokes your CLI with the poll prompt below, and ask me to
  install it. Give one option, not a menu.

**Poll prompt to schedule** — note that it drains, which matters (see cadence):

> Run Workbench Analyser cycles: follow the `workbench-analyser-cycle` skill. Claim a due routine
> and run it to completion, then claim again, repeating until `claim` returns `null` or you have
> completed 10 routines. Report which routines ran. If the first claim is `null`, stop
> immediately and report that nothing was due.

**Cadence: every 6 hours** by default. Rationale: each tick starts an agent session, so infrequent
ticks keep context/token consumption low; the drain loop above is what makes this safe.

**Why draining is mandatory at this cadence:** one `claim` returns exactly **one** routine. The
default seed alone has ~7 routines, most scheduled in the early-morning hours. A non-draining job
polling 4×/day would run at most 4 routines/day and permanently starve the rest. A draining job
clears everything due in one tick.

**Latency tradeoff:** a routine fires at the first tick after its scheduled time, so with 6-hour
ticks it can run up to ~6 hours late. If that matters, align the tick times with the routines'
schedules rather than polling more often — e.g. if routines cluster at 04:00–08:00 and 23:30,
ticks at 00:00 / 06:00 / 09:00 / 18:00 cover them closely at the same cost. Read the actual
`scheduleExpr`/`timezone` values from step 1 and pick tick times that fit them; state the worst-case
lateness you chose. Never poll faster than once per minute.

Before creating anything, check whether a poll job already exists on this host and reuse or
replace it instead of stacking duplicates.

### 4. Snapshot the skills the routines reference

For each distinct `skillKey` in `routines`, read the canonical skill body from the AgentSkills
store and store Analyser's own copy with
`analyser.skills.snapshot.upsert { skillKey, bodyMarkdown, sourceRef }`. This is an explicit,
deliberate operation — it never happens automatically — and without it drift detection has nothing
to compare against.

Then call `analyser.skills.integrity.run` once. It reconciles the fail-safe block flags and opens a
proposal for any skill whose canonical body has drifted from its snapshot.

### 5. Verify — do not declare success without this

Re-run `analyser.status.get` and read `runnerHealth.state`:

- `never_claimed` → **setup is NOT complete.** Nothing has ever polled. On a self-scheduling
  platform your job did not register or has not fired yet; on the paste path I have not installed
  the entry. Say so explicitly and stop; do not report success.
- `stalled` → routines are overdue and no runner has claimed within the grace window. The wiring
  existed once but the poller is not running now. Report the overdue routines
  (`runnerHealth.overdueRoutines`) and the last claim time (`runnerHealth.lastClaimAt`).
- `healthy` → report the active runners (`runnerHealth.runners`: name, last seen, runs in 24h) and
  the next scheduled run. Done.

A freshly registered job shows `never_claimed` until its first tick — and at a 6-hour cadence that
is a long wait. **Trigger one cycle manually now** (run the poll prompt once yourself) and confirm
the state flips. That gives a definitive answer immediately instead of leaving me uncertain for
hours; it is the recommended way to finish.

### 6. Hand off

Report in a few lines: what I must still do in the UI (if anything), where the poll job now lives
and at what cadence and tick times, how to remove it, and the verified `runnerHealth` state. If I
run several machines, note that one poller is sufficient and the others need nothing.

### Guardrails

- Never create, retime, enable, or disable routines; never change collection settings; never
  approve or reject proposals. Those are owner-only UI paths — report them, do not work around them.
- Never write credentials, tokens, or my Workbench password into a cron entry, a unit file, a
  scheduled job definition, or a summary. Use the credential mechanism the agent platform already
  provides.
- One poll job per host. Look for an existing one before adding another; duplicates are safe but
  wasteful and confusing in the runner list.
- Do not fabricate a `healthy` verdict. `runnerHealth` is server-computed — quote it, never infer
  it from the fact that you created a job.
- If the platform genuinely has no scheduling primitive and I cannot install one, say so plainly:
  Analyser routines will then only run when someone triggers a cycle manually.
