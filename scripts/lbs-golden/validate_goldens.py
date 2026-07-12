"""Mechanical coverage checks for the captured LBS golden responses."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Callable


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
GOLDENS_DIR = REPO_ROOT / "services" / "tasks" / "src" / "lbs" / "__goldens__"
EXPECTED_RULE_TYPES = {
    "ONCE",
    "WEEKLY",
    "EVERY_N_DAYS",
    "MONTHLY_DAY",
    "MONTHLY_NTH_WEEKDAY",
}
EXPECTED_EXCEPTION_TYPES = {
    "SKIP",
    "FORCE_DO",
    "MANUAL_LOCK",
    "OVERRIDE_LOAD",
    "RESCHEDULE",
}


def load(filename: str) -> Any:
    path = GOLDENS_DIR / filename
    if not path.is_file():
        raise AssertionError(f"missing golden: {filename}")
    return json.loads(path.read_text(encoding="utf-8"))


def schedule_days(filename: str) -> dict[str, dict[str, Any]]:
    return {day["date"]: day for day in load(filename)}


def task_ids_on(day: dict[str, Any]) -> set[str]:
    return {task["task_id"] for task in day["tasks"]}


def check_manifest() -> str:
    manifest = load("manifest.json")
    calls = manifest["calls"]
    assert manifest["golden_count"] == len(calls), "manifest golden_count does not match calls"
    files = [call["file"] for call in calls]
    assert len(files) == len(set(files)), "manifest contains duplicate golden filenames"
    missing = [filename for filename in files if not (GOLDENS_DIR / filename).is_file()]
    assert not missing, f"manifest references missing files: {missing}"
    assert all(call["method"] and call["path"] and call["description"] for call in calls)
    assert all("query" in call and "body" in call for call in calls)
    return f"manifest describes {len(calls)} calls and every response file exists"


def check_rule_types() -> str:
    task_rule = {task["task_id"]: task["rule_type"] for task in load("tasks_all.json")}
    scheduled_task_ids: set[str] = set()
    for filename in (
        "schedule_reference_window.json",
        "schedule_month_boundary.json",
        "schedule_february_clamp.json",
        "schedule_year_boundary.json",
    ):
        for day in load(filename):
            scheduled_task_ids.update(task_ids_on(day))
    found = {task_rule[task_id] for task_id in scheduled_task_ids}
    assert EXPECTED_RULE_TYPES <= found, f"schedule rule types missing: {sorted(EXPECTED_RULE_TYPES - found)}"
    return f"schedule goldens contain all rule types: {', '.join(sorted(found))}"


def check_fixture_edge_shapes() -> str:
    tasks = load("tasks_all.json")
    all_false = next(task for task in tasks if task["task_id"] == "T-WEEK-NONE")
    assert not any(all_false[day] for day in ("mon", "tue", "wed", "thu", "fri", "sat", "sun"))
    assert any(task["start_date"] and task["end_date"] for task in tasks)
    assert any(task["start_time"] and task["end_time"] for task in tasks)
    assert any(task["start_time"] is None and task["end_time"] is None for task in tasks)
    assert len({task["context"] for task in tasks}) >= 5
    assert {task["is_locked"] for task in tasks} == {False, True}
    active = load("tasks_active.json")
    inactive = load("tasks_inactive.json")
    assert active and all(task["active"] for task in active)
    assert inactive and all(not task["active"] for task in inactive)
    return "weekly all-false, bounds, timing, context, lock, and active-filter variants are present"


def check_february_clamp() -> str:
    days = schedule_days("schedule_february_clamp.json")
    assert "2027-02-28" in days, "February 28 is absent"
    assert "T-MONTH-31" in task_ids_on(days["2027-02-28"]), "month_day=31 did not clamp to February 28"
    return "month_day=31 occurs on 2027-02-28"


def check_last_weekday() -> str:
    days = schedule_days("schedule_reference_window.json")
    assert "2026-07-26" in days
    assert "T-NTH-LAST-SUN" in task_ids_on(days["2026-07-26"])
    task = load("task_t-nth-last-sun.json")
    assert task["nth_in_month"] == -1 and task["weekday_mon1"] == 7
    return "nth=-1 / Sunday occurrence is present on 2026-07-26"


def check_skip_and_force_do() -> str:
    days = schedule_days("schedule_reference_window.json")
    july_3 = days["2026-07-03"]
    ids = task_ids_on(july_3)
    assert "T-WEEK-MWF" not in ids, "SKIPped Friday occurrence is still present"
    assert "T-ONCE-001" in ids, "FORCE_DO ONCE occurrence is absent"
    forced = next(task for task in july_3["tasks"] if task["task_id"] == "T-ONCE-001")
    assert forced["exception_type"] == "FORCE_DO"
    once = load("task_t-once-001.json")
    assert once["due_date"] != "2026-07-03", "FORCE_DO date unexpectedly equals ONCE due date"
    return "SKIP removes its normal occurrence and FORCE_DO adds ONCE on a non-rule date"


def check_exceptions() -> str:
    exceptions = load("exceptions_all.json")
    found = {exception["exception_type"] for exception in exceptions}
    assert found == EXPECTED_EXCEPTION_TYPES, f"exception types differ: {sorted(found)}"
    reschedule = next(exc for exc in exceptions if exc["exception_type"] == "RESCHEDULE")
    assert reschedule["start_time"] == "16:30:00" and reschedule["end_time"] == "18:15:00"
    assert reschedule["is_locked"] is True
    return "all five exception types, locked RESCHEDULE, and time overrides are captured"


def check_override_load() -> str:
    days = schedule_days("schedule_reference_window.json")
    task = next(task for task in days["2026-07-01"]["tasks"] if task["task_id"] == "T-WEEK-MWF")
    assert task["exception_type"] == "OVERRIDE_LOAD"
    assert task["load"] == 6.75, f"expected override load 6.75, got {task['load']}"
    resolved = load("resolved_t-week-mwf_2026-07-01_override_load.json")
    assert resolved["load"] == 6.75 and resolved["exception"]["override_load_value"] == 6.75
    return "OVERRIDE_LOAD=6.75 is visible in schedule and resolved-task goldens"


def check_fatigue_and_overflow() -> str:
    rested = load("calculate_2026-06-29_all.json")
    fatigued = load("calculate_2026-07-04_all.json")
    assert rested["cognitive_fatigue"] == 0 and fatigued["cognitive_fatigue"] == 5
    assert rested["cap"] > fatigued["cap"], "fatigue did not lower effective cap"
    assert fatigued["level"] == "CRITICAL", "high-fatigue day is not CRITICAL"
    assert fatigued["adjusted_load"] > fatigued["cap"], "high-fatigue day does not overflow cap"
    return f"fatigue lowers cap {rested['cap']} -> {fatigued['cap']}; high-fatigue day is CRITICAL"


def check_non_default_config() -> str:
    config = load("dashboard_reference_week.json")["config"]
    expected = {"ALPHA": 0.23, "BETA": 1.35, "SWITCH_COST": 0.85, "CAP": 7.25}
    assert config == expected, f"non-default config mismatch: {config}"
    return "dashboard reflects non-default ALPHA/BETA/SWITCH_COST/CAP"


def check_histories() -> str:
    statuses: set[str] = set()
    for path in GOLDENS_DIR.glob("history_*.json"):
        statuses.update(row["status"] for row in json.loads(path.read_text(encoding="utf-8")))
    assert {"done", "skipped"} <= statuses, f"history status coverage missing: {statuses}"
    return "per-task histories include DONE and SKIPPED outcomes"


def main() -> int:
    checks: list[tuple[str, Callable[[], str]]] = [
        ("manifest", check_manifest),
        ("rule types", check_rule_types),
        ("fixture shapes", check_fixture_edge_shapes),
        ("February clamp", check_february_clamp),
        ("last weekday", check_last_weekday),
        ("SKIP/FORCE_DO", check_skip_and_force_do),
        ("exceptions", check_exceptions),
        ("override load", check_override_load),
        ("fatigue/overflow", check_fatigue_and_overflow),
        ("system config", check_non_default_config),
        ("histories", check_histories),
    ]
    try:
        for label, check in checks:
            print(f"PASS [{label}] {check()}")
    except (AssertionError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        print(f"FAIL [{label}] {exc}", file=sys.stderr)
        return 1
    print(f"Validation passed: {len(checks)} checks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
