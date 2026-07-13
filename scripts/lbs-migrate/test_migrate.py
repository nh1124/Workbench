#!/usr/bin/env python3
"""Plain-assert integration test for the LBS migration CLIs."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from datetime import date, datetime, time, timezone
from pathlib import Path

from sqlalchemy import create_engine, text


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
LBS_ROOT = REPO_ROOT / "services" / "lbs"
MIGRATE = SCRIPT_DIR / "migrate.py"
VERIFY = SCRIPT_DIR / "verify.py"
LBS_USER_ID = "11111111-1111-4111-8111-111111111111"
CORE_USER_ID = "Core-User_01"
OWNER = CORE_USER_ID.lower()
FIXED = datetime(2026, 7, 1, 0, 0, tzinfo=timezone.utc)


TARGET_DDL = (
    "CREATE TABLE service_accounts (core_user_id TEXT UNIQUE)",
    """CREATE TABLE task_definitions (
        owner_username TEXT NOT NULL, task_id TEXT NOT NULL, task_name TEXT NOT NULL,
        context TEXT NOT NULL, base_load_score REAL NOT NULL, active BOOLEAN NOT NULL,
        rule_type TEXT NOT NULL, due_date TEXT, mon BOOLEAN NOT NULL, tue BOOLEAN NOT NULL,
        wed BOOLEAN NOT NULL, thu BOOLEAN NOT NULL, fri BOOLEAN NOT NULL, sat BOOLEAN NOT NULL,
        sun BOOLEAN NOT NULL, interval_days INTEGER, anchor_date TEXT, month_day INTEGER,
        nth_in_month INTEGER, weekday_mon1 INTEGER, start_date TEXT, end_date TEXT,
        start_time TEXT, end_time TEXT, notes TEXT, external_sync_id TEXT, timezone TEXT,
        is_locked BOOLEAN NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (owner_username, task_id))""",
    """CREATE TABLE task_rule_exceptions (
        id INTEGER PRIMARY KEY, owner_username TEXT NOT NULL, task_id TEXT NOT NULL,
        target_date TEXT NOT NULL, exception_type TEXT NOT NULL, override_load_value REAL,
        start_time TEXT, end_time TEXT, notes TEXT, is_locked BOOLEAN NOT NULL, created_at TEXT NOT NULL)""",
    """CREATE TABLE task_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, owner_username TEXT NOT NULL, task_id TEXT NOT NULL,
        target_date TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('todo', 'done', 'skipped')),
        progress INTEGER NOT NULL,
        actual_time INTEGER, created_at TEXT NOT NULL,
        UNIQUE (owner_username, task_id, target_date))""",
    """CREATE TABLE daily_conditions (
        owner_username TEXT NOT NULL, target_date TEXT NOT NULL, cognitive_fatigue INTEGER NOT NULL,
        physical_fatigue INTEGER NOT NULL, note TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY (owner_username, target_date))""",
    """CREATE TABLE lbs_user_config (
        owner_username TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        description TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (owner_username, key))""",
)


def db_url(path: Path) -> str:
    return f"sqlite:///{path.resolve().as_posix()}"


def run(*args: str, expected: int = 0) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        [sys.executable, *args], cwd=REPO_ROOT, text=True, capture_output=True, check=False
    )
    if result.returncode != expected:
        raise AssertionError(
            f"command returned {result.returncode}, expected {expected}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


def build_source(path: Path) -> None:
    os.environ["DATABASE_URL"] = db_url(path)
    os.environ["LBS_ENV"] = "test"
    sys.path.insert(0, str(LBS_ROOT))
    from src.models.database import (  # pylint: disable=import-outside-toplevel
        Base, DailyCondition, LBSDailyCache, SessionLocal, SystemConfig, Task, TaskException,
        TaskExecution, TaskStatus, User, engine,
    )

    Base.metadata.create_all(bind=engine)
    with SessionLocal() as session:
        session.add(User(
            user_id=LBS_USER_ID,
            email="wb_coreuser01@workbench.local",
            name="Migrated Workbench user",
            is_active=True,
            created_at=FIXED,
            updated_at=FIXED,
        ))
        session.add(Task(
            task_id="T-MIGRATE-1", user_id=LBS_USER_ID, task_name="Migration task",
            context="focus", base_load_score=3.5, active=True, rule_type="WEEKLY",
            mon=True, wed=True, start_date=date(2026, 7, 1), end_date=date(2026, 12, 31),
            start_time=time(9, 30), end_time=time(10, 45), notes="Keep me",
            timezone="Asia/Tokyo", is_locked=True, created_at=FIXED, updated_at=FIXED,
        ))
        session.add(TaskException(
            id=41, user_id=LBS_USER_ID, task_id="T-MIGRATE-1", target_date=date(2026, 7, 8),
            exception_type="RESCHEDULE", start_time=time(13, 0), end_time=time(14, 0),
            notes="Moved", is_locked=False, created_at=FIXED,
        ))
        session.add(TaskExecution(
            id=51, user_id=LBS_USER_ID, task_id="T-MIGRATE-1", target_date=date(2026, 7, 1),
            status=TaskStatus.DONE, progress=80, actual_time=65, created_at=FIXED,
        ))
        session.add(DailyCondition(
            user_id=LBS_USER_ID, target_date=date(2026, 7, 1), cognitive_fatigue=2,
            physical_fatigue=3, note="Normal", updated_at=FIXED,
        ))
        for key, value in {"ALPHA": "0.25", "BETA": "1.4", "SWITCH_COST": "0.75", "CAP": "7.5", "IGNORED": "9"}.items():
            session.add(SystemConfig(
                user_id=LBS_USER_ID, key=key, value=value, description=f"{key} test", updated_at=FIXED,
            ))
        session.add(LBSDailyCache(
            id=61, user_id=LBS_USER_ID, target_date=date(2026, 7, 1), task_id="T-MIGRATE-1",
            calculated_load=3.5, status=TaskStatus.TODO, is_overflow=False, generated_at=FIXED,
        ))
        session.commit()
    engine.dispose()


def build_target(path: Path) -> None:
    engine = create_engine(db_url(path), future=True)
    with engine.begin() as connection:
        for statement in TARGET_DDL:
            connection.exec_driver_sql(statement)
        connection.execute(text("INSERT INTO service_accounts (core_user_id) VALUES (:core)"), {"core": CORE_USER_ID})
    engine.dispose()


def snapshot(path: Path) -> dict[str, list[tuple[object, ...]]]:
    engine = create_engine(db_url(path), future=True)
    result: dict[str, list[tuple[object, ...]]] = {}
    with engine.connect() as connection:
        for table in ("task_definitions", "task_rule_exceptions", "task_executions", "daily_conditions", "lbs_user_config"):
            result[table] = sorted(tuple(row) for row in connection.execute(text(f"SELECT * FROM {table}")))
    engine.dispose()
    return result


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="lbs-migrate-test-") as temp_dir:
        root = Path(temp_dir)
        source = root / "source.db"
        target = root / "target.db"
        build_source(source)
        build_target(target)
        common = (str(MIGRATE), "--source", db_url(source), "--target", db_url(target))

        dry_run = run(*common)
        assert "Mode: dry-run" in dry_run.stdout
        assert "task_definitions: inserted=1 updated=0 unchanged=0" in dry_run.stdout
        assert all(not rows for rows in snapshot(target).values())

        first = run(*common, "--execute")
        assert "Transaction committed." in first.stdout
        first_snapshot = snapshot(target)
        assert {table: len(rows) for table, rows in first_snapshot.items()} == {
            "task_definitions": 1,
            "task_rule_exceptions": 1,
            "task_executions": 1,
            "daily_conditions": 1,
            "lbs_user_config": 4,
        }

        engine = create_engine(db_url(target), future=True)
        with engine.connect() as connection:
            task = connection.execute(text("SELECT * FROM task_definitions")).mappings().one()
            assert task["owner_username"] == OWNER
            assert task["rule_type"] == "WEEKLY"
            assert task["start_date"] == "2026-07-01"
            assert task["start_time"] == "09:30:00"
            assert bool(task["active"]) is True and bool(task["is_locked"]) is True
            execution = connection.execute(text("SELECT status, progress FROM task_executions")).one()
            assert execution == ("done", 80)
            exception = connection.execute(text("SELECT id, exception_type, start_time FROM task_rule_exceptions")).one()
            assert exception == (41, "RESCHEDULE", "13:00:00")
            assert connection.execute(text("SELECT COUNT(*) FROM lbs_user_config WHERE key = 'IGNORED'" )).scalar_one() == 0
        engine.dispose()

        second = run(*common, "--execute")
        assert "task_definitions: inserted=0 updated=0 unchanged=1" in second.stdout
        assert "lbs_user_config: inserted=0 updated=0 unchanged=4" in second.stdout
        assert "same-owner upsert" in second.stdout
        assert snapshot(target) == first_snapshot

        verified = run(
            str(VERIFY), "--source", db_url(source), "--target", db_url(target), "--user", LBS_USER_ID
        )
        assert "Verification passed." in verified.stdout

        # Force a late-table constraint failure after an earlier task update and prove the whole run rolls back.
        source_engine = create_engine(db_url(source), future=True)
        with source_engine.begin() as connection:
            connection.execute(text("UPDATE tasks SET task_name = 'Must roll back'"))
            connection.execute(text("UPDATE task_executions SET status = 'BROKEN'"))
        source_engine.dispose()
        failed = run(*common, "--execute", expected=1)
        assert "rolled back" in failed.stderr
        assert snapshot(target) == first_snapshot

        print("test_migrate.py: all assertions passed")
        print("dry-run excerpt:")
        print("\n".join(line for line in dry_run.stdout.splitlines() if "->" in line or "inserted=" in line))


if __name__ == "__main__":
    main()
