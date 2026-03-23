#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

"${SCRIPT_DIR}/initialize_system.sh"

echo "Starting Workbench service stack (Core HTTP + internal services + DB)..."
cd "${PROJECT_ROOT}"
docker compose up -d
npm run dev:services

