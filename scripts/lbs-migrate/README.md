# LBS data migration

This directory contains the one-time migration from the legacy LBS database to the local LBS tables in the tasks-service database. The migration never writes unless `--execute` is supplied, and `--target` is always required.

## User mapping rule

The target `owner_username` is the Workbench Core user ID after the tasks-service normalization rule: trim surrounding whitespace, then lowercase it (`normalizeOwner` in `services/tasks/src/lbs/storeUtils.ts` and `services/tasks/src/db.ts`). It is not the Workbench username snapshot.

Automatic mapping uses `service_accounts.core_user_id` in the target database and accepts exactly one of these deterministic links:

1. An LBS `external_identities` row whose issuer is `workbench-core` and whose subject exactly identifies a target `service_accounts.core_user_id` after owner normalization.
2. The historical local LBS account email created by the retired provisioner: `wb_<compact-core-id>@workbench.local`, where `<compact-core-id>` is the lowercased Core user ID with every non-ASCII-alphanumeric character removed. The email is matched against all target service accounts and is accepted only when it yields one owner.

The provisioned email cannot safely be inverted by itself because compaction can collide (for example, punctuation is discarded). The tool therefore derives candidate emails from the target service accounts and aborts on zero or multiple matches. `users.name`, `username_snapshot`, and LBS display names are never treated as identity.

For legacy or ambiguous accounts, pass a reviewed JSON file:

```json
{
  "legacy-lbs-user-id": "core-user-id"
}
```

Explicit values must still identify an existing target `service_accounts.core_user_id`. The stored `owner_username` is normalized exactly as runtime lookups normalize it. If any row in a migrated source table belongs to an unmappable user, the whole run aborts before writing.

## Field and key mapping

| LBS source | Tasks target | Upsert key |
|---|---|---|
| `tasks` | `task_definitions` | `(owner_username, task_id)` |
| `task_exceptions` | `task_rule_exceptions` | source global primary key `id` |
| `task_executions` | `task_executions` | `(owner_username, task_id, target_date)` |
| `daily_conditions` | `daily_conditions` | `(owner_username, target_date)` |
| `system_config` | `lbs_user_config` | `(owner_username, key)` |

Only `ALPHA`, `BETA`, `SWITCH_COST`, and `CAP` config rows are copied. `lbs_daily_cache` is derived and is deliberately skipped. The exception target schema has no composite unique constraint, so the globally unique source exception `id` is preserved and used by `ON CONFLICT(id)`.

Dates are written as `YYYY-MM-DD` TEXT, times as `HH:MM:SS` TEXT, task rule and exception enums remain uppercase, execution status is lowercase (`todo`, `done`, `skipped`), and booleans are real database booleans. These formats match `fixture_input.json` and the W1 store parsers used by `LocalLbsBackend`.

## Usage

Use the preinstalled golden-harness virtual environment; do not install packages:

```powershell
$python = "scripts/lbs-golden/.venv/Scripts/python.exe"
$source = "sqlite:///C:/backups/lbs-production/lbs.db"
$target = "postgresql://tasks_user:password@db-host:5432/tasks_db"

# Dry-run is the default. This reads both databases and rolls back the target transaction.
& $python scripts/lbs-migrate/migrate.py --source $source --target $target

# An explicit flag is required to write.
& $python scripts/lbs-migrate/migrate.py --source $source --target $target --user-map C:/secure/lbs-user-map.json --execute

# Verify one source LBS user after migration.
& $python scripts/lbs-migrate/verify.py --source $source --target $target --user legacy-lbs-user-id --user-map C:/secure/lbs-user-map.json
```

Both `postgres://` and `postgresql://` source/target URLs are accepted. SQLite targets are supported only for the isolated test harness. A migration run reports source counts per table, per-user counts, mapping evidence, unmappable rows, existing target `task_id` collisions, and predicted/actual inserted, updated, and unchanged counts. All target upserts run in one transaction and any error rolls the entire run back.

## Production cutover

1. On the currently deployed pre-W6 version, stop every writer to the legacy LBS database. Do not deploy W6 while production is still in remote mode.
2. Take the normal database backups/snapshots and prepare/review any required user-map file.
3. Run the migration without `--execute`. Resolve every unmappable user and review all row counts and task-ID collisions.
4. Run the same command with `--execute`. Do not change the source database or user map between dry-run and execute.
5. Run `verify.py` for every migrated LBS user; any mismatch exits nonzero and blocks cutover.
6. Switch the tasks service to `TASKS_LBS_MODE=local`, restart it, and run the local-backend acceptance checks.
7. Keep the stopped legacy LBS database and the pre-cutover tasks backup available for the rollback window.

Never execute against production without the required user confirmation in the repository operating rules.

## Test

```powershell
& scripts/lbs-golden/.venv/Scripts/python.exe scripts/lbs-migrate/test_migrate.py
```

The test builds a temporary SQLite source from literal legacy DDL with SQLAlchemy Core, creates an isolated SQLite target, checks dry-run safety and field formats, executes twice to prove idempotency, and runs the verifier. The migration and verifier import no code from the retired Python service.
