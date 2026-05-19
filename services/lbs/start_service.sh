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

echo "[LBS] Starting LBS service..."
exec node scripts/lbs-python.mjs -m src.main
