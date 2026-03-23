#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

"${SCRIPT_DIR}/initialize_system.sh"

echo "Starting Workbench native UI (desktop only)..."
echo "[INFO] Backend APIs are NOT started by this script."
echo "[INFO] Start infra/start_services.sh in another terminal first."
cd "${PROJECT_ROOT}"
npm run dev:native
