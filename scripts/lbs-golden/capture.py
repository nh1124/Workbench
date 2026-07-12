"""Capture deterministic JSON responses from the Python LBS app in-process."""

from __future__ import annotations

import json
import logging
import os
import sys
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Any

warnings.filterwarnings("ignore", message="Using `httpx` with `starlette.testclient` is deprecated.*")

from fastapi.testclient import TestClient


REF_TODAY = "2026-07-01"
API_KEY = "lbs-golden-fixed-api-key"
API_KEY_PEPPER = "lbs-golden-fixed-pepper"

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
LBS_ROOT = REPO_ROOT / "services" / "lbs"
FIXTURE_DB = SCRIPT_DIR / "fixture.db"
GOLDENS_DIR = REPO_ROOT / "services" / "tasks" / "src" / "lbs" / "__goldens__"
API_PREFIX = "/api/lbs"


@dataclass(frozen=True)
class Call:
    filename: str
    path: str
    description: str
    query: tuple[tuple[str, str], ...] = ()
    method: str = "GET"
    body: Any = None


TASK_IDS = (
    "T-ONCE-001",
    "T-WEEK-MWF",
    "T-WEEK-WEEKEND",
    "T-WEEK-TUTH",
    "T-WEEK-NONE",
    "T-EVERY-003",
    "T-MONTH-31",
    "T-NTH-LAST-SUN",
    "T-NTH-SECOND-TUE",
    "T-INACTIVE-ONCE",
)


def _q(**values: str) -> tuple[tuple[str, str], ...]:
    return tuple((key, value) for key, value in values.items())


def _status_query(*statuses: str, **values: str) -> tuple[tuple[str, str], ...]:
    return tuple((key, value) for key, value in values.items()) + tuple(
        ("status", status) for status in statuses
    )


def build_calls() -> list[Call]:
    calls = [
        Call("tasks_all.json", f"{API_PREFIX}/tasks", "List tasks with active unset."),
        Call("tasks_active.json", f"{API_PREFIX}/tasks", "List active tasks.", _q(active="true")),
        Call("tasks_inactive.json", f"{API_PREFIX}/tasks", "List inactive tasks.", _q(active="false")),
    ]

    calls.extend(
        Call(
            f"task_{task_id.lower()}.json",
            f"{API_PREFIX}/tasks/{task_id}",
            f"Get task definition for {task_id}.",
        )
        for task_id in TASK_IDS
    )

    calls.extend(
        [
            Call(
                "schedule_reference_window.json",
                f"{API_PREFIX}/schedule",
                "Schedule from REF_TODAY - 14 days through REF_TODAY + 45 days.",
                _q(start_date="2026-06-17", end_date="2026-08-15"),
            ),
            Call(
                "schedule_month_boundary.json",
                f"{API_PREFIX}/schedule",
                "Schedule across an August/September month boundary.",
                _q(start_date="2026-08-28", end_date="2026-09-03"),
            ),
            Call(
                "schedule_february_clamp.json",
                f"{API_PREFIX}/schedule",
                "February 2027 window proving month_day=31 clamps to February 28.",
                _q(start_date="2027-02-01", end_date="2027-03-02"),
            ),
            Call(
                "schedule_year_boundary.json",
                f"{API_PREFIX}/schedule",
                "Schedule across the 2026/2027 year boundary.",
                _q(start_date="2026-12-28", end_date="2027-01-05"),
            ),
        ]
    )

    resolved_dates = (
        ("T-ONCE-001", "2026-07-01", "normal_due_date"),
        ("T-ONCE-001", "2026-07-03", "force_do_non_rule_date"),
        ("T-WEEK-MWF", "2026-07-01", "override_load"),
        ("T-WEEK-MWF", "2026-07-03", "skip"),
        ("T-WEEK-NONE", "2026-07-02", "manual_lock"),
        ("T-WEEK-WEEKEND", "2026-07-04", "reschedule_times"),
        ("T-MONTH-31", "2027-02-28", "february_clamp"),
        ("T-NTH-LAST-SUN", "2026-07-26", "last_sunday"),
    )
    calls.extend(
        Call(
            f"resolved_{task_id.lower()}_{target_date}_{label}.json",
            f"{API_PREFIX}/tasks/{task_id}/resolved",
            f"Resolve {task_id} on {target_date} ({label.replace('_', ' ')}).",
            _q(target_date=target_date),
        )
        for task_id, target_date, label in resolved_dates
    )

    calls.extend(
        [
            Call(
                "dashboard_reference_week.json",
                f"{API_PREFIX}/dashboard",
                "Dashboard for the week containing REF_TODAY; its today field uses the endpoint's real current UTC date.",
                _q(start_date="2026-06-29"),
            ),
            Call(
                "heatmap_reference.json",
                f"{API_PREFIX}/heatmap",
                "Heatmap including TODO, DONE, and SKIPPED statuses.",
                _status_query("todo", "done", "skipped", start="2026-06-29", end="2026-07-12"),
            ),
            Call(
                "trends_reference.json",
                f"{API_PREFIX}/trends",
                "Four fixed weeks of trend data with every status.",
                _status_query("todo", "done", "skipped", weeks="4", start_date="2026-06-15"),
            ),
            Call(
                "context_distribution_reference.json",
                f"{API_PREFIX}/context-distribution",
                "Context distribution including every status.",
                _status_query("todo", "done", "skipped", start="2026-06-29", end="2026-07-12"),
            ),
            Call(
                "calculate_2026-06-29_all.json",
                f"{API_PREFIX}/calculate/2026-06-29",
                "Daily load at cognitive fatigue 0 with every status.",
                _status_query("todo", "done", "skipped"),
            ),
            Call(
                "calculate_2026-07-01_default.json",
                f"{API_PREFIX}/calculate/2026-07-01",
                "Daily load at cognitive fatigue 2 with the endpoint's default TODO/DONE filter.",
            ),
            Call(
                "calculate_2026-07-01_todo.json",
                f"{API_PREFIX}/calculate/2026-07-01",
                "Daily load at cognitive fatigue 2 with TODO only.",
                _status_query("todo"),
            ),
            Call(
                "calculate_2026-07-01_done.json",
                f"{API_PREFIX}/calculate/2026-07-01",
                "Daily load at cognitive fatigue 2 with DONE only.",
                _status_query("done"),
            ),
            Call(
                "calculate_2026-07-02_all.json",
                f"{API_PREFIX}/calculate/2026-07-02",
                "Daily load including a SKIPPED execution and MANUAL_LOCK.",
                _status_query("todo", "done", "skipped"),
            ),
            Call(
                "calculate_2026-07-04_all.json",
                f"{API_PREFIX}/calculate/2026-07-04",
                "High-fatigue daily load at cognitive fatigue 5 with every status.",
                _status_query("todo", "done", "skipped"),
            ),
            Call(
                "exceptions_all.json",
                f"{API_PREFIX}/exceptions",
                "List all exception types in the fixture.",
                _q(start_date="2026-01-01", end_date="2027-12-31"),
            ),
        ]
    )

    calls.extend(
        Call(
            f"history_{task_id.lower()}.json",
            f"{API_PREFIX}/tasks/{task_id}/history",
            f"Execution history for {task_id}.",
            _q(start_date="2026-01-01", end_date="2027-12-31"),
        )
        for task_id in TASK_IDS
    )
    return calls


def _configure_app() -> None:
    if not FIXTURE_DB.exists():
        raise SystemExit(f"Fixture missing: run build_fixture.py first ({FIXTURE_DB})")
    os.environ["DATABASE_URL"] = f"sqlite:///{FIXTURE_DB.resolve().as_posix()}"
    os.environ["LBS_ENV"] = "test"
    os.environ["LBS_REQUIRE_API_KEY"] = "true"
    os.environ["ALLOW_DEV_FALLBACK"] = "false"
    os.environ["LBS_API_KEY_PEPPER"] = API_KEY_PEPPER
    os.environ["LBS_REFRESH_DEBOUNCE_ENABLED"] = "false"
    sys.path.insert(0, str(LBS_ROOT))


def _write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def capture() -> None:
    _configure_app()
    from src.main import app  # pylint: disable=import-outside-toplevel

    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("src.services.lbs_engine").setLevel(logging.WARNING)

    GOLDENS_DIR.mkdir(parents=True, exist_ok=True)
    for old_json in GOLDENS_DIR.glob("*.json"):
        old_json.unlink()

    calls = build_calls()
    manifest_calls = []
    headers = {"X-API-KEY": API_KEY, "X-Timezone": "UTC"}

    with TestClient(app) as client:
        for call in calls:
            response = client.request(
                call.method,
                call.path,
                params=list(call.query),
                json=call.body,
                headers=headers,
            )
            if not response.is_success:
                raise RuntimeError(
                    f"{call.method} {call.path} failed with {response.status_code}: {response.text}"
                )
            _write_json(GOLDENS_DIR / call.filename, response.json())
            manifest_calls.append(
                {
                    "body": call.body,
                    "description": call.description,
                    "file": call.filename,
                    "method": call.method,
                    "path": call.path,
                    "query": [
                        {"name": name, "value": value} for name, value in call.query
                    ],
                }
            )

    manifest = {
        "calls": manifest_calls,
        "caveats": [
            "GET /api/lbs/dashboard calculates its today field with get_local_today at capture time even when start_date is supplied; the fixed weekly breakdown is still anchored by start_date=2026-06-29."
        ],
        "fixture": "scripts/lbs-golden/fixture.db",
        "golden_count": len(calls),
        "reference_date": REF_TODAY,
    }
    _write_json(GOLDENS_DIR / "manifest.json", manifest)
    print(f"Captured {len(calls)} goldens in {GOLDENS_DIR}")


if __name__ == "__main__":
    capture()
