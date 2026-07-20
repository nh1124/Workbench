# Workbench Analyser migration runbook

Run this only while the legacy Insights database and maintenance queue routes still exist. Run commands from the repository root. Prerequisites are Node.js with the existing root workspace dependencies, `pg_dump`/`pg_restore`, access to both PostgreSQL databases, and a Core user whose maintenance queue is being migrated.

## 1. Back up Insights

Create a UTC-dated custom-format dump before starting either migration:

```powershell
New-Item -ItemType Directory -Force backups | Out-Null
$migrationStamp = Get-Date -AsUTC -Format "yyyyMMddTHHmmssZ"
$env:PGPASSWORD = $env:INSIGHTS_DB_PASSWORD ?? "insights_pass"
pg_dump -h ($env:INSIGHTS_DB_HOST ?? "127.0.0.1") -p ($env:INSIGHTS_DB_PORT ?? "5550") -U ($env:INSIGHTS_DB_USER ?? "insights_user") -d ($env:INSIGHTS_DB_NAME ?? "insights_db") -Fc -f "backups/insights_db-$migrationStamp.dump"
```

Keep the dump until the legacy service and schema have been removed and the analyser verification period has completed.

## 2. Start Analyser

Start the target database, then the analyser service (Core must also be configured with `ANALYSER_SERVICE_URL`):

```powershell
docker compose up -d analyser-db
npm run dev:http --workspace services/analyser
```

## 3. Migrate Insights data

The DB variables default to the compose values (`127.0.0.1:5550/insights_db` and `127.0.0.1:5551/analyser_db`, with their compose users/passwords). Override `INSIGHTS_DB_*` or `ANALYSER_DB_*` when needed.

```powershell
node infra/scripts/migrate-insights-to-analyser.mjs --dry-run --sample-days 30
node infra/scripts/migrate-insights-to-analyser.mjs --sample-days 30
```

Both services derive `service_accounts.id` as the first 32 hex characters of SHA-256 over `core_user_id`, so the migration preserves those IDs. It also preserves each legacy machine ID and machine key; a conflicting target identity fails the migration instead of silently breaking daemon convergence.

The daemon stores `sampledAt` text verbatim and builds `pc:${machineId}:${sampledAt}`. Insights stored that value as `TIMESTAMPTZ`, so the original text is no longer available; the migration emits the required UTC millisecond ISO form (`YYYY-MM-DDTHH:mm:ss.SSSZ`) and uses the same formatted value in `dedupe_key`. `window_title` is intentionally not migrated because it was collected under the old policy and the new default is `windowTitleUpload=false`. `activity_summaries` and `derived_observations` remain only in the backup.

## 4. Migrate maintenance items

Keep Core, Analyser, and the old maintenance routes running. Supply a bearer token, or credentials for `POST /accounts/login`:

```powershell
$env:WORKBENCH_CORE_URL = "http://127.0.0.1:4100"
$env:WORKBENCH_TOKEN = "<bearer-token>"
node infra/scripts/migrate-maintenance-to-proposals.mjs --dry-run
node infra/scripts/migrate-maintenance-to-proposals.mjs
```

Repeat for each Core user/owner that has legacy maintenance items. Proposal dedupe keys make reruns safe.

## 5. Verify

Run these against `analyser_db`:

```sql
SELECT COUNT(*) FROM service_accounts;
SELECT COUNT(*) FROM analyser_machines;
SELECT COUNT(*) FROM analyser_observations WHERE source = 'pc_activity' AND action = 'foreground_sample';
SELECT COUNT(*) AS duplicate_keys
FROM (
  SELECT service_account_id, dedupe_key
  FROM analyser_observations
  GROUP BY service_account_id, dedupe_key
  HAVING COUNT(*) > 1
) duplicates;
SELECT COUNT(*) AS migrated_window_titles
FROM analyser_observations
WHERE source = 'pc_activity' AND metadata ? 'windowTitle';
```

`duplicate_keys` and `migrated_window_titles` must both be zero. Verify proposals through Core, then rerun both migration scripts; the second real run should report zero copied/created rows and all eligible existing rows as skipped/deduped.

```powershell
curl.exe -H "Authorization: Bearer $env:WORKBENCH_TOKEN" "$env:WORKBENCH_CORE_URL/api/analyser/proposals?status=open&limit=200"
```

## 6. Roll back

Stop legacy Insights writes before restoring its dump. Restore into the legacy database with the matching connection variables:

```powershell
$env:PGPASSWORD = $env:INSIGHTS_DB_PASSWORD ?? "insights_pass"
pg_restore --clean --if-exists -h ($env:INSIGHTS_DB_HOST ?? "127.0.0.1") -p ($env:INSIGHTS_DB_PORT ?? "5550") -U ($env:INSIGHTS_DB_USER ?? "insights_user") -d ($env:INSIGHTS_DB_NAME ?? "insights_db") "backups/<dated-insights-dump>.dump"
```

The analyser rows are additive and keyed for idempotency; leave them in place rather than deleting untagged shared data. After correcting the cause of rollback, both scripts can be rerun safely.
