#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

"${SCRIPT_DIR}/initialize_system.sh"

echo "Starting Workbench web stack (services + web UI)..."
cd "${PROJECT_ROOT}"
npm run dev