"""Build the deterministic SQLite fixture used by the LBS golden captures."""

from __future__ import annotations

import hashlib
import hmac
import os
import sys
from datetime import date, datetime, time, timezone
from pathlib import Path


REF_TODAY = date(2026, 7, 1)
USER_ID = "11111111-1111-4111-8111-111111111111"
API_KEY_ID = "22222222-2222-4222-8222-222222222222"
API_KEY = "lbs-golden-fixed-api-key"
API_KEY_PEPPER = "lbs-golden-fixed-pepper"
FIXED_TIMESTAMP = datetime(2026, 7, 1, 0, 0, tzinfo=timezone.utc)

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
LBS_ROOT = REPO_ROOT / "services" / "lbs"
FIXTURE_DB = SCRIPT_DIR / "fixture.db"


def _configure_imports() -> None:
    os.environ["DATABASE_URL"] = f"sqlite:///{FIXTURE_DB.resolve().as_posix()}"
    os.environ["LBS_ENV"] = "test"
    os.environ["LBS_REQUIRE_API_KEY"] = "true"
    os.environ["ALLOW_DEV_FALLBACK"] = "false"
    os.environ["LBS_API_KEY_PEPPER"] = API_KEY_PEPPER
    os.environ["LBS_REFRESH_DEBOUNCE_ENABLED"] = "false"
    sys.path.insert(0, str(LBS_ROOT))


def build_fixture() -> None:
    if FIXTURE_DB.exists():
        FIXTURE_DB.unlink()

    _configure_imports()

    from src.models.database import (  # pylint: disable=import-outside-toplevel
        APIKey,
        Base,
        DailyCondition,
        SessionLocal,
        SystemConfig,
        Task,
        TaskException,
        TaskExecution,
        TaskStatus,
        User,
        engine,
    )

    Base.metadata.create_all(bind=engine)

    api_key_hash = hmac.new(
        API_KEY_PEPPER.encode("utf-8"), API_KEY.encode("utf-8"), hashlib.sha256
    ).hexdigest()

    tasks = [
        Task(
            task_id="T-ONCE-001",
            user_id=USER_ID,
            task_name="Launch-day deep work",
            context="focus",
            base_load_score=4.5,
            active=True,
            rule_type="ONCE",
            due_date=REF_TODAY,
            start_time=time(9, 0),
            end_time=time(11, 0),
            notes="ONCE task also forced on a non-rule date.",
            timezone="UTC",
            is_locked=False,
            created_at=FIXED_TIMESTAMP,
            updated_at=FIXED_TIMESTAMP,
        ),
        Task(
            task_id="T-WEEK-MWF",
            user_id=USER_ID,
            task_name="Monday Wednesday Friday review",
            context="admin",
            base_load_score=2.4,
            active=True,
            rule_type="WEEKLY",
            mon=True,
            wed=True,
            fri=True,
            start_date=date(2026, 6, 22),
            end_date=date(2026, 8, 10),
            is_locked=True,
            timezone="UTC",
            created_at=FIXED_TIMESTAMP,
            updated_at=FIXED_TIMESTAMP,
        ),
        Task(
            task_id="T-WEEK-WEEKEND",
            user_id=USER_ID,
            task_name="Weekend maintenance",
            context="home",
            base_load_score=4.0,
            active=True,
            rule_type="WEEKLY",
            sat=True,
            sun=True,
            start_time=time(10, 0),
            end_time=time(12, 0),
            is_locked=False,
            timezone="UTC",
            created_at=FIXED_TIMESTAMP,
            updated_at=FIXED_TIMESTAMP,
        ),
        Task(
            task_id="T-WEEK-TUTH",
            user_id=USER_ID,
            task_name="Tuesday Thursday collaboration",
            context="team",
            base_load_score=1.7,
            active=True,
            rule_type="WEEKLY",
            tue=True,
            thu=True,
            start_date=date(2026, 6, 1),
            end_date=date(2027, 3, 31),
            start_time=time(14, 0),
            end_time=time(15, 0),
            timezone="UTC",
            created_at=FIXED_TIMESTAMP,
            updated_at=FIXED_TIMESTAMP,
        ),
        Task(
            task_id="T-WEEK-NONE",
            user_id=USER_ID,
            task_name="All weekdays disabled",
            context="edge",
            base_load_score=2.75,
            active=True,
            rule_type="WEEKLY",
            notes="All mon..sun flags are false; MANUAL_LOCK creates one occurrence.",
            timezone="UTC",
            created_at=FIXED_TIMESTAMP,
            updated_at=FIXED_TIMESTAMP,
        ),
        Task(
            task_id="T-EVERY-003",
            user_id=USER_ID,
            task_name="Every three days from anchor",
            context="health",
            base_load_score=2.2,
            active=True,
            rule_type="EVERY_N_DAYS",
            interval_days=3,
            anchor_date=REF_TODAY,
            start_date=date(2026, 6, 25),
            end_date=date(2027, 3, 15),
            timezone="UTC",
            created_at=FIXED_TIMESTAMP,
            updated_at=FIXED_TIMESTAMP,
        ),
        Task(
            task_id="T-MONTH-31",
            user_id=USER_ID,
            task_name="Month end clamped from day 31",
            context="finance",
            base_load_score=3.1,
            active=True,
            rule_type="MONTHLY_DAY",
            month_day=31,
            start_date=date(2026, 1, 1),
            end_date=date(2027, 12, 31),
            timezone="UTC",
            created_at=FIXED_TIMESTAMP,
            updated_at=FIXED_TIMESTAMP,
        ),
        Task(
            task_id="T-NTH-LAST-SUN",
            user_id=USER_ID,
            task_name="Last Sunday reflection",
            context="reflection",
            base_load_score=3.3,
            active=True,
            rule_type="MONTHLY_NTH_WEEKDAY",
            nth_in_month=-1,
            weekday_mon1=7,
            start_date=date(2026, 1, 1),
            end_date=date(2027, 12, 31),
            timezone="UTC",
            is_locked=True,
            created_at=FIXED_TIMESTAMP,
            updated_at=FIXED_TIMESTAMP,
        ),
        Task(
            task_id="T-NTH-SECOND-TUE",
            user_id=USER_ID,
            task_name="Second Tuesday planning",
            context="planning",
            base_load_score=1.4,
            active=True,
            rule_type="MONTHLY_NTH_WEEKDAY",
            nth_in_month=2,
            weekday_mon1=2,
            start_date=date(2026, 1, 1),
            end_date=date(2027, 12, 31),
            timezone="UTC",
            created_at=FIXED_TIMESTAMP,
            updated_at=FIXED_TIMESTAMP,
        ),
        Task(
            task_id="T-INACTIVE-ONCE",
            user_id=USER_ID,
            task_name="Inactive archived task",
            context="archive",
            base_load_score=9.0,
            active=False,
            rule_type="ONCE",
            due_date=date(2026, 7, 2),
            timezone="UTC",
            created_at=FIXED_TIMESTAMP,
            updated_at=FIXED_TIMESTAMP,
        ),
    ]

    exceptions = [
        TaskException(
            id=1,
            user_id=USER_ID,
            task_id="T-WEEK-MWF",
            target_date=date(2026, 7, 3),
            exception_type="SKIP",
            notes="Normal Friday occurrence must be absent.",
            is_locked=False,
            created_at=FIXED_TIMESTAMP,
        ),
        TaskException(
            id=2,
            user_id=USER_ID,
            task_id="T-ONCE-001",
            target_date=date(2026, 7, 3),
            exception_type="FORCE_DO",
            override_load_value=5.5,
            notes="FORCE_DO away from ONCE due_date.",
            is_locked=False,
            created_at=FIXED_TIMESTAMP,
        ),
        TaskException(
            id=3,
            user_id=USER_ID,
            task_id="T-WEEK-NONE",
            target_date=date(2026, 7, 2),
            exception_type="MANUAL_LOCK",
            override_load_value=2.75,
            notes="Creates an occurrence despite all weekday flags being false.",
            is_locked=True,
            created_at=FIXED_TIMESTAMP,
        ),
        TaskException(
            id=4,
            user_id=USER_ID,
            task_id="T-WEEK-MWF",
            target_date=REF_TODAY,
            exception_type="OVERRIDE_LOAD",
            override_load_value=6.75,
            notes="Load override must be visible in resolved and schedule output.",
            is_locked=False,
            created_at=FIXED_TIMESTAMP,
        ),
        TaskException(
            id=5,
            user_id=USER_ID,
            task_id="T-WEEK-WEEKEND",
            target_date=date(2026, 7, 4),
            exception_type="RESCHEDULE",
            start_time=time(16, 30),
            end_time=time(18, 15),
            notes="Time overrides with a locked exception.",
            is_locked=True,
            created_at=FIXED_TIMESTAMP,
        ),
    ]

    executions = [
        TaskExecution(id=1, user_id=USER_ID, task_id="T-ONCE-001", target_date=REF_TODAY, status=TaskStatus.DONE, progress=100, actual_time=105, created_at=FIXED_TIMESTAMP),
        TaskExecution(id=2, user_id=USER_ID, task_id="T-WEEK-MWF", target_date=date(2026, 6, 29), status=TaskStatus.DONE, progress=80, actual_time=45, created_at=FIXED_TIMESTAMP),
        TaskExecution(id=3, user_id=USER_ID, task_id="T-WEEK-MWF", target_date=date(2026, 7, 6), status=TaskStatus.SKIPPED, progress=25, actual_time=15, created_at=FIXED_TIMESTAMP),
        TaskExecution(id=4, user_id=USER_ID, task_id="T-WEEK-TUTH", target_date=date(2026, 6, 30), status=TaskStatus.DONE, progress=50, actual_time=30, created_at=FIXED_TIMESTAMP),
        TaskExecution(id=5, user_id=USER_ID, task_id="T-WEEK-TUTH", target_date=date(2026, 7, 2), status=TaskStatus.SKIPPED, progress=0, actual_time=0, created_at=FIXED_TIMESTAMP),
        TaskExecution(id=6, user_id=USER_ID, task_id="T-WEEK-WEEKEND", target_date=date(2026, 7, 4), status=TaskStatus.DONE, progress=100, actual_time=60, created_at=FIXED_TIMESTAMP),
    ]

    with SessionLocal() as session:
        session.add(
            User(
                user_id=USER_ID,
                email="golden@example.invalid",
                name="Golden Capture User",
                password_hash=None,
                is_active=True,
                created_at=FIXED_TIMESTAMP,
                updated_at=FIXED_TIMESTAMP,
            )
        )
        session.add(
            APIKey(
                id=API_KEY_ID,
                user_id=USER_ID,
                client_id="lbs-golden-capture",
                key_hash=api_key_hash,
                scopes=["read"],
                is_active=True,
                created_at=FIXED_TIMESTAMP,
            )
        )
        session.add_all(
            SystemConfig(
                user_id=USER_ID,
                key=key,
                value=value,
                description="Non-default golden fixture configuration.",
                updated_at=FIXED_TIMESTAMP,
            )
            for key, value in {
                "ALPHA": "0.23",
                "BETA": "1.35",
                "SWITCH_COST": "0.85",
                "CAP": "7.25",
            }.items()
        )
        session.add_all(tasks)
        session.add_all(exceptions)
        session.add_all(executions)
        session.add_all(
            DailyCondition(
                user_id=USER_ID,
                target_date=date(2026, 6, 29 + offset),
                cognitive_fatigue=offset,
                physical_fatigue=5 - offset,
                note=f"Golden cognitive fatigue level {offset}.",
                updated_at=FIXED_TIMESTAMP,
            )
            for offset in range(2)
        )
        # The remaining dates cross into July, so spell them out explicitly.
        session.add_all(
            DailyCondition(
                user_id=USER_ID,
                target_date=target_date,
                cognitive_fatigue=fatigue,
                physical_fatigue=5 - fatigue,
                note=f"Golden cognitive fatigue level {fatigue}.",
                updated_at=FIXED_TIMESTAMP,
            )
            for target_date, fatigue in [
                (date(2026, 7, 1), 2),
                (date(2026, 7, 2), 3),
                (date(2026, 7, 3), 4),
                (date(2026, 7, 4), 5),
            ]
        )
        session.commit()

    print(f"Built {FIXTURE_DB}")
    print(f"Reference date: {REF_TODAY.isoformat()}")
    print(f"Tasks: {len(tasks)}; exceptions: {len(exceptions)}; executions: {len(executions)}; conditions: 6")


if __name__ == "__main__":
    build_fixture()
