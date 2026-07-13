#!/usr/bin/env python3
"""Verify one LBS user's migrated rows against the tasks-service database."""

from __future__ import annotations

import argparse
import sys
from collections import Counter
from typing import Any, Mapping, Sequence

from sqlalchemy import create_engine, text

from migrate import (
    TABLE_SPECS,
    MigrationError,
    canonical,
    comparable,
    derive_user_mapping,
    fetch_source_rows,
    load_user_map,
    normalize_url,
    require_tables,
    row_key,
    transform_rows,
)


def verify_user(source_url: str, target_url: str, lbs_user_id: str, user_map_path: str | None) -> int:
    source_engine = create_engine(normalize_url(source_url), future=True)
    target_engine = create_engine(normalize_url(target_url), future=True)
    require_tables(source_engine, ["users", *(spec.source for spec in TABLE_SPECS)], "source")
    require_tables(target_engine, ["service_accounts", *(spec.target for spec in TABLE_SPECS)], "target")

    failures: list[str] = []
    with source_engine.connect() as source, target_engine.connect() as target:
        all_source_rows = fetch_source_rows(source)
        source_rows = {
            spec.source: [row for row in all_source_rows[spec.source] if str(row[spec.user_column]) == lbs_user_id]
            for spec in TABLE_SPECS
        }
        if not any(source_rows.values()):
            raise MigrationError(f"Source user {lbs_user_id!r} has no migratable rows")

        counts = {
            spec.source: Counter({lbs_user_id: len(source_rows[spec.source])})
            for spec in TABLE_SPECS
        }
        mapping, reasons = derive_user_mapping(source, target, counts, load_user_map(user_map_path))
        if lbs_user_id not in mapping:
            raise MigrationError(
                f"Cannot map source user {lbs_user_id!r}: {'; '.join(reasons.get(lbs_user_id, []))}"
            )
        owner = mapping[lbs_user_id]
        transformed = transform_rows(source_rows, mapping)

        print(f"Verifying LBS user {lbs_user_id} -> owner {owner}")
        for spec in TABLE_SPECS:
            expected_rows = transformed[spec.target]
            actual_rows = [dict(row) for row in target.execute(
                text(f"SELECT {', '.join(spec.columns)} FROM {spec.target} WHERE owner_username = :owner"),
                {"owner": owner},
            ).mappings()]
            expected = {row_key(spec, row): row for row in expected_rows}
            actual = {row_key(spec, row): row for row in actual_rows}
            print(f"  {spec.target}: source={len(expected_rows)} target={len(actual_rows)}")
            if len(expected_rows) != len(actual_rows):
                failures.append(
                    f"{spec.target}: row count differs (source={len(expected_rows)}, target={len(actual_rows)})"
                )
            missing = sorted(set(expected) - set(actual), key=str)
            extra = sorted(set(actual) - set(expected), key=str)
            if missing:
                failures.append(f"{spec.target}: missing keys {missing[:5]}")
            if extra:
                failures.append(f"{spec.target}: extra keys {extra[:5]}")
            for key in sorted(set(expected) & set(actual), key=str):
                if comparable(spec, expected[key]) != comparable(spec, actual[key]):
                    differing = [
                        column for column in spec.columns
                        if canonical(column, expected[key].get(column)) != canonical(column, actual[key].get(column))
                    ]
                    failures.append(f"{spec.target}: key={key} differs in {', '.join(differing)}")
            if expected:
                first_key = sorted(expected, key=str)[0]
                print(f"    spot key={first_key}: {'OK' if first_key in actual and comparable(spec, expected[first_key]) == comparable(spec, actual[first_key]) else 'MISMATCH'}")

    source_engine.dispose()
    target_engine.dispose()
    if failures:
        print("Verification failed:", file=sys.stderr)
        for failure in failures:
            print(f"  {failure}", file=sys.stderr)
        return 1
    print("Verification passed.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default="sqlite:///services/lbs/lbs.db", help="LBS SQLAlchemy DB URL")
    parser.add_argument("--target", required=True, help="Tasks Postgres SQLAlchemy DB URL")
    parser.add_argument("--user", required=True, dest="lbs_user_id", help="LBS users.user_id to verify")
    parser.add_argument("--user-map", help="Optional JSON {lbs_user_id: owner_core_user_id}")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return verify_user(args.source, args.target, args.lbs_user_id, args.user_map)
    except MigrationError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"ERROR: verification failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
