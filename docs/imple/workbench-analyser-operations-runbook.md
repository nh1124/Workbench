# Workbench Analyser operations runbook

Use this runbook for routine operations after the analyser-centric cutover. The public service boundary is Workbench Core: browser and operator requests use `/api/analyser/*`, and agents use the frozen `analyser.*` MCP tools. Do not write Analyser tables directly to repair application state.

For the legacy-data migration and production cutover sequence, use [workbench-analyser-migration-runbook.md](workbench-analyser-migration-runbook.md). That runbook documents its required two-phase deployment window.

## Collection and automation settings

Manage settings in the authenticated Analyser UI. The equivalent user-authenticated Core routes are:

- `GET /api/analyser/settings`: owner defaults, machine override rows, effective owner settings, and automation policy/version.
- `GET /api/analyser/settings/effective?machineId=<uuid>`: effective collection settings for the owner or one machine.
- `PUT /api/analyser/settings/collection`: update an owner default or machine override.
- `PUT /api/analyser/settings/automation`: update the owner automation policy.
- `GET /api/analyser/routines` and `PATCH /api/analyser/routines/:key`: inspect or update server-side routine schedules.

Agents may call `analyser.settings.get` to read effective collection settings. There is no agent tool for settings writes, routine schedule writes, or proposal approval/rejection.

### Update collection policy

Send the smallest settings patch and use `expectedVersion` from the settings read when updating an existing row:

```jsonc
{
  "machineId": null,
  "settings": {
    "workbenchChanges": "metadata",
    "mcpAccess": "mutations",
    "uiAccess": "mutations",
    "foregroundAppCapture": false,
    "foregroundAppUpload": false,
    "windowTitleCapture": false,
    "windowTitleUpload": false,
    "localFileEvents": "off",
    "localFileUpload": false,
    "screenshots": "off"
  },
  "expectedVersion": 1
}
```

Use `machineId: null` or omit it for the owner default. Use a registered machine UUID for an override. Confirm the result with the effective-settings route for the same machine.

Collection fields are:

- `workbenchChanges`: `off | metadata`.
- `mcpAccess`, `uiAccess`: `off | mutations | reads_and_mutations`.
- `agentSessionEvents`: `off | explicit_only`.
- `foregroundAppCapture`, `foregroundAppUpload`, `windowTitleCapture`, `windowTitleUpload`: booleans.
- `localFileEvents`: `off | metadata`; `localFileUpload`: boolean.
- `screenshots`: `off | local_only`.
- `retentionDays`: per-source values for `workbench_change`, `mcp_access`, `ui_access`, `agent_session`, `pc_activity`, and `local_file`.
- `localScreenshotRetentionDays`.
- Project, resource-type, and local-root allow/deny arrays plus `excludePatterns`.

Collection is gated at both producer and ingest. A disabled or unknown source fails closed. Screenshots remain local-only and are not returned by Analyser HTTP or MCP.

### Update automation policy

The complete automation policy is required:

```jsonc
{
  "policy": {
    "enabled": true,
    "requireHighConfidence": true,
    "destructiveAllowed": false,
    "bulkAllowed": false,
    "allowedOperationKinds": [
      "artifact_move",
      "artifact_metadata_update",
      "artifact_secondary_membership_add",
      "progress_note_upsert"
    ]
  },
  "expectedVersion": 1
}
```

Only the four listed operation kinds are accepted by the current schema. Agent execution still requires all five high-confidence conditions and current authoritative verification; policy membership alone is insufficient.

## Routine failure triage

Routine schedule and cursor state live only in Analyser PostgreSQL. No agent host owns a canonical cron file or local cursor.

1. Open the Analyser Overview or call `analyser.status.get` and `analyser.routines.list`. Record the routine key, last error, next run, active run holder, and lease expiry.
2. Inspect the service log for the same time and request ID. Use the commands in [Logs](#logs).
3. Classify the failure:
   - **No claim returned:** the routine is disabled, not due, already active, or awaiting retry/backoff. Compare `enabled`, `nextRunAt`, and the active lease.
   - **Lease expired / `RUN_NOT_ACTIVE`:** stop using that run ID. Let a later claim recover the work; never force-complete an expired run.
   - **Pull or focused-read failure:** verify Core, Analyser, and the referenced domain service health. Do not replace a missing Core tool with direct service or database writes.
   - **Domain mutation conflict:** re-read the resource and membership/index views. Retry only when intent remains deterministic; otherwise create a proposal.
   - **Proposal execution failure:** leave the proposal approved, record only an accurate failed/skipped operation when applicable, and do not mark it executed.
4. If the holder still owns an active lease, heartbeat before further diagnosis. If safe completion is impossible, call `analyser.routines.fail` with a non-sensitive error summary.
5. Confirm that a failed run did not advance the committed cursor. The next claim will receive the same observations. Do not edit cursors manually.
6. Preserve retry identities: summary `kind + period`, proposal `dedupeKey`, operation `idempotencyKey`, and publication source/target/content hash.

`analyser.routines.complete` is the only routine action that commits the pending observation cursor. `analyser.observations.pull` advances only the active run's pending cursor.

## Retention

Raw observations receive `expiresAt` at ingest from the effective per-source retention policy. Defaults are 30 days for every server observation source; accepted values are 1 through 90 days. Local screenshot retention defaults to 7 days and accepts 1 through 30 days.

The Analyser process runs retention housekeeping hourly. Each pass deletes at most 5,000 expired observation rows, so a large backlog drains across multiple passes. A successful deletion and any cleanup error are written to the Analyser log.

Retention deletes only raw observations. Summaries, proposals, operations, and publications are not removed by this housekeeping loop. Local screenshots are managed on the capture machine and never stored in `analyser_db`.

Changing policy does not recompute `expiresAt` for rows already ingested; verify existing expiry distribution before expecting an immediate storage reduction:

```sql
SELECT source, MIN(expires_at), MAX(expires_at), COUNT(*)
FROM analyser_observations
GROUP BY source
ORDER BY source;
```

Use direct SQL for read-only operational inspection only. Make policy changes through the UI/Core route.

## Backup

The compose defaults are `127.0.0.1:5551`, database `analyser_db`, user `analyser_user`, and password `analyser_pass`. Override them with deployment secrets. A PostgreSQL custom-format dump captures observation, policy, schedule/cursor, run, summary, proposal, operation, and publication state consistently while the database is online.

```powershell
New-Item -ItemType Directory -Force backups | Out-Null
$analyserBackupStamp = Get-Date -AsUTC -Format "yyyyMMddTHHmmssZ"
$env:PGPASSWORD = $env:ANALYSER_DB_PASSWORD ?? "analyser_pass"
pg_dump `
  -h ($env:ANALYSER_DB_HOST ?? "127.0.0.1") `
  -p ($env:ANALYSER_DB_PORT ?? "5551") `
  -U ($env:ANALYSER_DB_USER ?? "analyser_user") `
  -d ($env:ANALYSER_DB_NAME ?? "analyser_db") `
  -Fc -f "backups/analyser_db-$analyserBackupStamp.dump"
pg_restore --list "backups/analyser_db-$analyserBackupStamp.dump" | Select-Object -First 20
```

Retain at least one verified dump outside the database host before a deploy, schema change, or cutover. The compose volume is `analyser_pgdata`; a volume alone is not a portable logical backup.

## Restore

Restore is destructive to the target database. Confirm the exact dump and target, take a fresh pre-restore dump, and stop the Analyser process so Core projection and daemon uploads cannot write during restore. There is no `analyser` application container in the current compose file; only `analyser-db` is composed, while `infra/start_services.*` runs the Analyser Node service locally.

1. Stop the local/server Analyser process while leaving or starting PostgreSQL with `docker compose up -d analyser-db`.
2. Verify the intended target with `pg_isready` and a read-only connection.
3. Restore the selected custom-format dump:

   ```powershell
   $env:PGPASSWORD = $env:ANALYSER_DB_PASSWORD ?? "analyser_pass"
   pg_restore --clean --if-exists `
     -h ($env:ANALYSER_DB_HOST ?? "127.0.0.1") `
     -p ($env:ANALYSER_DB_PORT ?? "5551") `
     -U ($env:ANALYSER_DB_USER ?? "analyser_user") `
     -d ($env:ANALYSER_DB_NAME ?? "analyser_db") `
     "backups/<verified-analyser-dump>.dump"
   ```

4. Restart `services/analyser`; startup runs the idempotent schema initializer and starts hourly retention housekeeping.
5. Verify Analyser `/health`, Core `/health`, `GET /api/analyser/status`, routine list/status, effective settings, and representative summary/proposal reads.
6. Confirm that the next agent poll returns either no due claim or a valid claim whose cursor matches the restored state. Do not manually advance it.

For a production migration or service cutover, follow [workbench-analyser-migration-runbook.md](workbench-analyser-migration-runbook.md) instead of using this restore procedure as a substitute.

## Logs

The shared logger writes UTC-dated JSONL files and mirrors to stderr by default:

- Default file: `logs/analyser-YYYY-MM-DD.jsonl` under the repository root.
- Override directory: `WORKBENCH_LOG_DIR`.
- Console threshold: `LOG_LEVEL=debug|info|warn|error` (default `info`).
- File retention: `WORKBENCH_LOG_RETENTION_DAYS` (default 14).
- Set `WORKBENCH_LOG_CONSOLE=0` to disable the stderr mirror.

On Bash-capable hosts:

```bash
infra/logs_tail.sh analyser -n 100
infra/logs_tail.sh analyser --level error
infra/logs_tail.sh analyser -f
```

The file date is UTC. For database-container startup or PostgreSQL errors, use `docker compose logs --tail=200 analyser-db`. When launched by `npm run dev*` or `infra/start_services.*`, the service's stderr also appears in that supervising terminal or process manager.
