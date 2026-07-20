#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

"${SCRIPT_DIR}/initialize_system.sh"
node "${SCRIPT_DIR}/scripts/workbench-env.mjs" check

echo "Starting Workbench service stack (Core HTTP + internal services + DB)..."
cd "${PROJECT_ROOT}"
# Artifacts is docker-only in this mode.
# Rebuild artifacts image after pull to ensure latest code is reflected.
docker compose up -d --build artifacts-db artifacts workbench-core-db notes-db tasks-db projects-db images-db mindmaps-db wbs-db analyser-db

# Run local services except artifacts (which is handled by docker above).
npm run dev:services:no-artifacts
