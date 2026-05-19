#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

if [[ ! -f ".env" && -f ".env.example" ]]; then
  cp ".env.example" ".env"
  echo "[LBS] Created .env from .env.example"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[LBS] Node.js is required to prepare and launch the embedded LBS service." >&2
  exit 1
fi

WORKBENCH_ENV_SCRIPT="${SCRIPT_DIR}/../../infra/scripts/workbench-env.mjs"
if [[ -f "${WORKBENCH_ENV_SCRIPT}" ]]; then
  node "${WORKBENCH_ENV_SCRIPT}" sync
fi

echo "[LBS] Starting LBS service..."
exec node scripts/lbs-python.mjs -m src.main
