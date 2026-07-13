# LBS golden-capture harness

The committed JSON goldens are frozen as the parity contract for the TypeScript implementation. Normal Workbench development and tests consume those files and do not require the retired Python service.

Re-capturing goldens now requires a separate checkout of the standalone [LBS repository](https://github.com/nh1124/LBS). Set `LBS_SOURCE_ROOT` to that checkout, then expose it at the `services/lbs`-equivalent path expected by the unchanged capture scripts (for example, with a temporary directory junction). The environment variable documents the authoritative checkout; the scripts themselves still import from the equivalent repository path.

```powershell
$env:LBS_SOURCE_ROOT = "C:/src/LBS"
New-Item -ItemType Junction -Path services/lbs -Target $env:LBS_SOURCE_ROOT
```

Remove the temporary junction after capture. Never point it at production data: the harness builds a synthetic SQLite fixture, uses the fixed reference date `2026-07-01`, and runs the FastAPI app in-process with `TestClient`.

The venv at `scripts/lbs-golden/.venv` is already provisioned. With the standalone checkout exposed at that equivalent path, run from the Workbench repository root:

```powershell
scripts/lbs-golden/.venv/Scripts/python.exe scripts/lbs-golden/build_fixture.py
scripts/lbs-golden/.venv/Scripts/python.exe scripts/lbs-golden/capture.py
scripts/lbs-golden/.venv/Scripts/python.exe scripts/lbs-golden/validate_goldens.py
```

`build_fixture.py` deletes and recreates `scripts/lbs-golden/fixture.db`. `capture.py` sets `DATABASE_URL` before importing the LBS app, authenticates with the fixture API key, removes stale JSON captures, and writes one sorted, pretty-printed response per call plus `manifest.json` under `services/tasks/src/lbs/__goldens__/`.

The dashboard endpoint derives its `today` field from the real current UTC date even when its fixed `start_date` is supplied. This caveat is recorded in the manifest; all other requested capture windows are explicitly anchored to fixed dates.
