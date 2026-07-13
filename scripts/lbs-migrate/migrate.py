#!/usr/bin/env python3
"""Migrate the legacy LBS database into the tasks-service LBS tables."""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import Connection, Engine


CONFIG_KEYS = {"ALPHA", "BETA", "SWITCH_COST", "CAP"}
WORKBENCH_ISSUER = "workbench-core"


@dataclass(frozen=True)
class TableSpec:
    source: str
    target: str
    columns: tuple[str, ...]
    key: tuple[str, ...]
    user_column: str = "user_id"


TABLE_SPECS = (
    TableSpec(
        "tasks",
        "task_definitions",
        (
            "owner_username", "task_id", "task_name", "context", "base_load_score", "active",
            "rule_type", "due_date", "mon", "tue", "wed", "thu", "fri", "sat", "sun",
            "interval_days", "anchor_date", "month_day", "nth_in_month", "weekday_mon1",
            "start_date", "end_date", "start_time", "end_time", "notes", "external_sync_id",
            "timezone", "is_locked", "created_at", "updated_at",
        ),
        ("owner_username", "task_id"),
    ),
    TableSpec(
        "task_exceptions",
        "task_rule_exceptions",
        (
            "id", "owner_username", "task_id", "target_date", "exception_type",
            "override_load_value", "start_time", "end_time", "notes", "is_locked", "created_at",
        ),
        ("id",),
    ),
    TableSpec(
        "task_executions",
        "task_executions",
        (
            "owner_username", "task_id", "target_date", "status", "progress", "actual_time",
            "created_at",
        ),
        ("owner_username", "task_id", "target_date"),
    ),
    TableSpec(
        "daily_conditions",
        "daily_conditions",
        (
            "owner_username", "target_date", "cognitive_fatigue", "physical_fatigue", "note",
            "updated_at",
        ),
        ("owner_username", "target_date"),
    ),
    TableSpec(
        "system_config",
        "lbs_user_config",
        ("owner_username", "key", "value", "description", "updated_at"),
        ("owner_username", "key"),
    ),
)

DATE_COLUMNS = {"due_date", "anchor_date", "start_date", "end_date", "target_date"}
TIME_COLUMNS = {"start_time", "end_time"}
BOOL_COLUMNS = {"active", "mon", "tue", "wed", "thu", "fri", "sat", "sun", "is_locked"}
TIMESTAMP_COLUMNS = {"created_at", "updated_at"}


class MigrationError(RuntimeError):
    """A migration precondition or data validation error."""


def normalize_url(url: str) -> str:
    if url.startswith("postgres://"):
        return "postgresql+psycopg2://" + url[len("postgres://"):]
    if url.startswith("postgresql://"):
        return "postgresql+psycopg2://" + url[len("postgresql://"):]
    return url


def normalize_owner(value: str) -> str:
    return value.strip().lower()


def compact_core_user_id(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", normalize_owner(value))


def provisioned_email(core_user_id: str) -> str:
    return f"wb_{compact_core_user_id(core_user_id)}@workbench.local"


def iso_date(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        value = value.date()
    if isinstance(value, date):
        return value.isoformat()
    rendered = str(value).strip()
    return rendered[:10] if rendered else None


def iso_time(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, time):
        return value.replace(tzinfo=None).isoformat(timespec="seconds")
    rendered = str(value).strip()
    if not rendered:
        return None
    return rendered[:8] if len(rendered) >= 8 else rendered


def iso_timestamp(value: Any) -> str | None:
    if value is None:
        return None
    parsed: datetime
    if isinstance(value, datetime):
        parsed = value
    else:
        rendered = str(value).strip().replace(" ", "T", 1)
        if not rendered:
            return None
        try:
            parsed = datetime.fromisoformat(rendered.replace("Z", "+00:00"))
        except ValueError:
            return rendered
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    rendered = parsed.isoformat(timespec="microseconds")
    return rendered[:-7] if rendered.endswith(".000000") else rendered


def canonical(column: str, value: Any) -> Any:
    if column in DATE_COLUMNS:
        return iso_date(value)
    if column in TIME_COLUMNS:
        return iso_time(value)
    if column in TIMESTAMP_COLUMNS:
        return iso_timestamp(value)
    if column in BOOL_COLUMNS:
        return bool(value) if value is not None else False
    if column in {"rule_type", "exception_type"} and value is not None:
        return str(value).upper()
    if column == "status" and value is not None:
        rendered = getattr(value, "value", value)
        return str(rendered).lower()
    return value


def row_key(spec: TableSpec, row: Mapping[str, Any]) -> tuple[Any, ...]:
    return tuple(canonical(column, row[column]) for column in spec.key)


def comparable(spec: TableSpec, row: Mapping[str, Any]) -> tuple[Any, ...]:
    return tuple(canonical(column, row.get(column)) for column in spec.columns)


def load_user_map(path: str | None) -> dict[str, str]:
    if not path:
        return {}
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise MigrationError(f"Unable to read --user-map {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise MigrationError("--user-map must contain a JSON object {lbs_user_id: owner_core_user_id}")
    result: dict[str, str] = {}
    for source_id, owner in payload.items():
        if not isinstance(source_id, str) or not isinstance(owner, str) or not source_id.strip() or not owner.strip():
            raise MigrationError("--user-map keys and values must be non-empty strings")
        result[source_id.strip()] = normalize_owner(owner)
    return result


def require_tables(engine: Engine, names: Iterable[str], label: str) -> None:
    available = set(inspect(engine).get_table_names())
    missing = sorted(set(names) - available)
    if missing:
        raise MigrationError(f"{label} database is missing required tables: {', '.join(missing)}")


def fetch_source_rows(connection: Connection) -> dict[str, list[dict[str, Any]]]:
    rows: dict[str, list[dict[str, Any]]] = {}
    for spec in TABLE_SPECS:
        query = f"SELECT * FROM {spec.source}"
        if spec.source == "system_config":
            query += " WHERE key IN ('ALPHA', 'BETA', 'SWITCH_COST', 'CAP')"
        rows[spec.source] = [dict(row) for row in connection.execute(text(query)).mappings()]
    return rows


def used_user_counts(source_rows: Mapping[str, Sequence[Mapping[str, Any]]]) -> dict[str, Counter[str]]:
    result: dict[str, Counter[str]] = {}
    for spec in TABLE_SPECS:
        result[spec.source] = Counter(str(row[spec.user_column]) for row in source_rows[spec.source])
    return result


def derive_user_mapping(
    source: Connection,
    target: Connection,
    counts: Mapping[str, Counter[str]],
    explicit: Mapping[str, str],
) -> tuple[dict[str, str], dict[str, list[str]]]:
    used_users = sorted({user_id for table_counts in counts.values() for user_id in table_counts})
    service_accounts = [dict(row) for row in target.execute(text(
        "SELECT core_user_id FROM service_accounts WHERE core_user_id IS NOT NULL"
    )).mappings()]
    by_normalized: dict[str, list[str]] = defaultdict(list)
    for row in service_accounts:
        raw = str(row["core_user_id"]).strip()
        by_normalized[normalize_owner(raw)].append(raw)

    users = {
        str(row["user_id"]): dict(row)
        for row in source.execute(text("SELECT user_id, email, name FROM users")).mappings()
    }
    external: dict[str, list[dict[str, Any]]] = defaultdict(list)
    source_tables = set(inspect(source.engine).get_table_names())
    if "external_identities" in source_tables:
        for row in source.execute(text("SELECT user_id, issuer, subject FROM external_identities")).mappings():
            external[str(row["user_id"])].append(dict(row))

    mapping: dict[str, str] = {}
    reasons: dict[str, list[str]] = {}
    for user_id in used_users:
        candidates: set[str] = set()
        user_reasons: list[str] = []
        if user_id in explicit:
            candidates.add(explicit[user_id])
            user_reasons.append("explicit --user-map")
        else:
            for identity in external.get(user_id, []):
                if str(identity["issuer"]).strip().lower() != WORKBENCH_ISSUER:
                    continue
                subject = normalize_owner(str(identity["subject"]))
                if subject in by_normalized:
                    candidates.update(normalize_owner(value) for value in by_normalized[subject])
                    user_reasons.append(f"external identity {WORKBENCH_ISSUER}/{identity['subject']}")

            user = users.get(user_id)
            email = str(user.get("email", "")).strip().lower() if user else ""
            for normalized_core_id, originals in by_normalized.items():
                if email and email == provisioned_email(normalized_core_id):
                    candidates.add(normalized_core_id)
                    user_reasons.append(f"provisioned email {email}")

        valid = {candidate for candidate in candidates if candidate in by_normalized}
        if len(valid) == 1:
            mapping[user_id] = next(iter(valid))
            reasons[user_id] = sorted(set(user_reasons))
        elif not valid:
            reasons[user_id] = ["no matching target service_accounts.core_user_id"]
        else:
            reasons[user_id] = [f"ambiguous candidates: {', '.join(sorted(valid))}"]
    return mapping, reasons


def transform_rows(
    source_rows: Mapping[str, Sequence[Mapping[str, Any]]],
    mapping: Mapping[str, str],
) -> dict[str, list[dict[str, Any]]]:
    transformed: dict[str, list[dict[str, Any]]] = {}
    for spec in TABLE_SPECS:
        table_rows: list[dict[str, Any]] = []
        for source_row in source_rows[spec.source]:
            user_id = str(source_row[spec.user_column])
            if user_id not in mapping:
                continue
            row: dict[str, Any] = {"owner_username": mapping[user_id]}
            for column in spec.columns:
                if column == "owner_username":
                    continue
                row[column] = canonical(column, source_row.get(column))
            if spec.source == "tasks" and row.get("timezone") is None:
                row["timezone"] = "UTC"
            table_rows.append(row)
        transformed[spec.target] = table_rows
    return transformed


def fetch_existing(connection: Connection, spec: TableSpec) -> dict[tuple[Any, ...], dict[str, Any]]:
    selected = ", ".join(spec.columns)
    result: dict[tuple[Any, ...], dict[str, Any]] = {}
    for row in connection.execute(text(f"SELECT {selected} FROM {spec.target}")).mappings():
        as_dict = dict(row)
        result[row_key(spec, as_dict)] = as_dict
    return result


def classify_rows(
    spec: TableSpec,
    incoming: Sequence[Mapping[str, Any]],
    existing: Mapping[tuple[Any, ...], Mapping[str, Any]],
) -> Counter[str]:
    counts: Counter[str] = Counter()
    for row in incoming:
        old = existing.get(row_key(spec, row))
        if old is None:
            counts["inserted"] += 1
        elif comparable(spec, row) == comparable(spec, old):
            counts["unchanged"] += 1
        else:
            counts["updated"] += 1
    return counts


def upsert_sql(spec: TableSpec) -> str:
    columns = ", ".join(spec.columns)
    values = ", ".join(f":{column}" for column in spec.columns)
    updates = [column for column in spec.columns if column not in spec.key]
    update_clause = ", ".join(f"{column} = excluded.{column}" for column in updates)
    key = ", ".join(spec.key)
    return (
        f"INSERT INTO {spec.target} ({columns}) VALUES ({values}) "
        f"ON CONFLICT ({key}) DO UPDATE SET {update_clause}"
    )


def sync_postgres_sequences(connection: Connection) -> None:
    """Keep SERIAL allocation safe after preserving legacy exception IDs."""
    if connection.dialect.name != "postgresql":
        return
    connection.execute(text("""
        SELECT setval(
          pg_get_serial_sequence('task_rule_exceptions', 'id'),
          COALESCE(MAX(id), 1),
          COUNT(*) > 0
        )
        FROM task_rule_exceptions
    """))


def task_collisions(connection: Connection, task_rows: Sequence[Mapping[str, Any]]) -> list[dict[str, str]]:
    incoming_ids = {str(row["task_id"]) for row in task_rows}
    incoming_keys = {(str(row["owner_username"]), str(row["task_id"])) for row in task_rows}
    collisions: list[dict[str, str]] = []
    if not incoming_ids:
        return collisions
    for row in connection.execute(text("SELECT owner_username, task_id FROM task_definitions")).mappings():
        task_id = str(row["task_id"])
        owner = str(row["owner_username"])
        if task_id in incoming_ids:
            collisions.append({
                "owner": owner,
                "task_id": task_id,
                "kind": "same-owner upsert" if (owner, task_id) in incoming_keys else "cross-owner task_id",
            })
    return collisions


def print_report(
    mode: str,
    source_rows: Mapping[str, Sequence[Mapping[str, Any]]],
    counts_by_user: Mapping[str, Counter[str]],
    mapping: Mapping[str, str],
    reasons: Mapping[str, Sequence[str]],
    changes: Mapping[str, Counter[str]] | None = None,
    collisions: Sequence[Mapping[str, str]] = (),
) -> None:
    print(f"Mode: {mode}")
    print("Source rows:")
    for spec in TABLE_SPECS:
        print(f"  {spec.source} -> {spec.target}: {len(source_rows[spec.source])}")
    print("Per-user rows:")
    all_users = sorted({user for counter in counts_by_user.values() for user in counter})
    for user_id in all_users:
        owner = mapping.get(user_id, "UNMAPPABLE")
        pieces = [f"{spec.source}={counts_by_user[spec.source][user_id]}" for spec in TABLE_SPECS if counts_by_user[spec.source][user_id]]
        print(f"  {user_id} -> {owner}: {', '.join(pieces)}")
    print("User mapping:")
    for user_id in all_users:
        print(f"  {user_id}: {mapping.get(user_id, 'UNMAPPABLE')} ({'; '.join(reasons.get(user_id, []))})")
    print("Unmappable rows:")
    unmappable_total = 0
    for user_id in all_users:
        if user_id in mapping:
            continue
        for spec in TABLE_SPECS:
            count = counts_by_user[spec.source][user_id]
            if count:
                unmappable_total += count
                print(f"  {spec.source}: user_id={user_id}, rows={count}")
    if not unmappable_total:
        print("  none")
    print("Existing task_id collisions:")
    if collisions:
        for collision in collisions:
            print(f"  {collision['task_id']} owner={collision['owner']} ({collision['kind']})")
    else:
        print("  none")
    if changes is not None:
        print("Target changes:")
        for spec in TABLE_SPECS:
            table = changes[spec.target]
            print(
                f"  {spec.target}: inserted={table['inserted']} updated={table['updated']} "
                f"unchanged={table['unchanged']}"
            )


def run_migration(source_url: str, target_url: str, user_map_path: str | None, execute: bool) -> int:
    source_engine = create_engine(normalize_url(source_url), future=True)
    target_engine = create_engine(normalize_url(target_url), future=True)
    require_tables(source_engine, ["users", *(spec.source for spec in TABLE_SPECS)], "source")
    require_tables(target_engine, ["service_accounts", *(spec.target for spec in TABLE_SPECS)], "target")
    explicit = load_user_map(user_map_path)

    with source_engine.connect() as source, target_engine.connect() as target:
        transaction = target.begin()
        try:
            source_rows = fetch_source_rows(source)
            counts_by_user = used_user_counts(source_rows)
            mapping, reasons = derive_user_mapping(source, target, counts_by_user, explicit)
            transformed = transform_rows(source_rows, mapping)
            changes: dict[str, Counter[str]] = {}
            for spec in TABLE_SPECS:
                changes[spec.target] = classify_rows(spec, transformed[spec.target], fetch_existing(target, spec))
            collisions = task_collisions(target, transformed["task_definitions"])
            print_report("execute" if execute else "dry-run", source_rows, counts_by_user, mapping, reasons, changes, collisions)

            missing = sorted({user for counter in counts_by_user.values() for user in counter} - set(mapping))
            if missing:
                raise MigrationError(
                    "Migration aborted: one or more source rows have no unambiguous Workbench owner mapping; "
                    "supply --user-map after reviewing the report"
                )

            if execute:
                for spec in TABLE_SPECS:
                    rows = transformed[spec.target]
                    if rows:
                        target.execute(text(upsert_sql(spec)), rows)
                sync_postgres_sequences(target)
                transaction.commit()
                print("Transaction committed.")
            else:
                transaction.rollback()
                print("Dry-run complete; target transaction rolled back without writes.")
            return 0
        except Exception:
            if transaction.is_active:
                transaction.rollback()
            raise
        finally:
            source_engine.dispose()
            target_engine.dispose()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default="sqlite:///services/lbs/lbs.db", help="LBS SQLAlchemy DB URL")
    parser.add_argument("--target", required=True, help="Tasks Postgres SQLAlchemy DB URL (required; no write default)")
    parser.add_argument("--user-map", help="Optional JSON {lbs_user_id: owner_core_user_id}")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="Inspect only (default)")
    mode.add_argument("--execute", action="store_true", help="Write in one target transaction")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return run_migration(args.source, args.target, args.user_map, args.execute)
    except MigrationError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # keep the CLI failure concise while preserving rollback
        print(f"ERROR: migration failed and was rolled back: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
