#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

"${SCRIPT_DIR}/initialize_system.sh"
node "${SCRIPT_DIR}/scripts/workbench-env.mjs" check

echo "Starting Workbench web stack (services + web UI)..."
cd "${PROJECT_ROOT}"
docker compose up -d workbench-core-db notes-db artifacts-db tasks-db projects-db images-db mindmaps-db wbs-db
npm run dev
