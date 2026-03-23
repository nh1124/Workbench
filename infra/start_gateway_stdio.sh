#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

"${SCRIPT_DIR}/initialize_system.sh"

echo "Starting Core MCP stdio gateway with internal services..."
echo "[INFO] External MCP surface is provided by Workbench Core only."
echo "[INFO] UI is NOT started in this mode."
cd "${PROJECT_ROOT}"
npm run dev:gateway:stdio

