# LBS golden-capture harness

This harness builds a synthetic SQLite fixture and captures the Python LBS API contract for the TypeScript port. It never reads or writes `services/lbs/lbs.db`, uses the fixed reference date `2026-07-01`, and runs the FastAPI app in-process with `TestClient`.

The venv at `scripts/lbs-golden/.venv` is already provisioned. From the repository root, run:

```powershell
scripts/lbs-golden/.venv/Scripts/python.exe scripts/lbs-golden/build_fixture.py
scripts/lbs-golden/.venv/Scripts/python.exe scripts/lbs-golden/capture.py
scripts/lbs-golden/.venv/Scripts/python.exe scripts/lbs-golden/validate_goldens.py
```

`build_fixture.py` deletes and recreates `scripts/lbs-golden/fixture.db`. `capture.py` sets `DATABASE_URL` before importing the LBS app, authenticates with the fixture API key, removes stale JSON captures, and writes one sorted, pretty-printed response per call plus `manifest.json` under `services/tasks/src/lbs/__goldens__/`.

The dashboard endpoint derives its `today` field from the real current UTC date even when its fixed `start_date` is supplied. This caveat is recorded in the manifest; all other requested capture windows are explicitly anchored to fixed dates.
