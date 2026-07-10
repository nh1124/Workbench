#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

node "${SCRIPT_DIR}/scripts/ensure-npm-install.mjs"

ensure_env() {
  local target="$1"
  local sample="$2"

  if [[ -f "${target}" ]]; then
    echo "[OK] ${target}"
    return 0
  fi

  if [[ ! -f "${sample}" ]]; then
    echo "[ERROR] Missing sample file: ${sample}"
    return 1
  fi

  cp "${sample}" "${target}"
  echo "[CREATED] ${target}"
}

ensure_env "${PROJECT_ROOT}/infra/workbench.env" "${PROJECT_ROOT}/infra/workbench.env.example"
ensure_env "${PROJECT_ROOT}/services/notes/.env" "${PROJECT_ROOT}/services/notes/.env.example"
ensure_env "${PROJECT_ROOT}/services/artifacts/.env" "${PROJECT_ROOT}/services/artifacts/.env.example"
ensure_env "${PROJECT_ROOT}/services/tasks/.env" "${PROJECT_ROOT}/services/tasks/.env.example"
ensure_env "${PROJECT_ROOT}/services/projects/.env" "${PROJECT_ROOT}/services/projects/.env.example"
ensure_env "${PROJECT_ROOT}/services/lbs/.env" "${PROJECT_ROOT}/services/lbs/.env.example"
ensure_env "${PROJECT_ROOT}/services/insights/.env" "${PROJECT_ROOT}/services/insights/.env.example"
ensure_env "${PROJECT_ROOT}/services/workbench-core/.env" "${PROJECT_ROOT}/services/workbench-core/.env.example"
ensure_env "${PROJECT_ROOT}/ui/.env" "${PROJECT_ROOT}/ui/.env.example"
ensure_env "${PROJECT_ROOT}/native/desktop/.env" "${PROJECT_ROOT}/native/desktop/.env.example"

node "${SCRIPT_DIR}/scripts/workbench-env.mjs" sync

echo "Environment files are ready."
