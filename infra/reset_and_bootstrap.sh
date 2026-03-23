#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

"${SCRIPT_DIR}/initialize_system.sh"

echo
echo "[WARN] This will DELETE all Workbench DB data (docker volumes)."
read -r -p "Type YES to continue: " WB_CONFIRM
if [[ "${WB_CONFIRM}" != "YES" ]]; then
  echo "[CANCELLED] Initialization aborted."
  exit 1
fi

read -r -p "Workbench username for re-initialization: " WB_USERNAME
read -r -s -p "Workbench password for re-initialization: " WB_PASSWORD
echo

if [[ -z "${WB_USERNAME}" ]]; then
  echo "[ERROR] Username is required."
  exit 1
fi
if [[ -z "${WB_PASSWORD}" ]]; then
  echo "[ERROR] Password is required."
  exit 1
fi

echo
echo "[1/5] Resetting databases (docker compose down -v)..."
cd "${PROJECT_ROOT}"
docker compose down -v --remove-orphans

echo "[2/5] Starting databases..."
docker compose up -d

echo "[3/5] Starting backend services (Core HTTP + internal services)..."
if command -v gnome-terminal >/dev/null 2>&1; then
  gnome-terminal -- bash -lc "cd '${PROJECT_ROOT}' && npm run dev:services; exec bash"
elif command -v x-terminal-emulator >/dev/null 2>&1; then
  x-terminal-emulator -e "bash -lc \"cd '${PROJECT_ROOT}' && npm run dev:services; exec bash\""
elif command -v open >/dev/null 2>&1; then
  # macOS fallback
  open -a Terminal "${PROJECT_ROOT}"
  echo "[INFO] Opened Terminal app. Run: cd '${PROJECT_ROOT}' && npm run dev:services"
else
  echo "[INFO] Could not open a new terminal automatically."
  echo "[INFO] Run in another terminal: cd '${PROJECT_ROOT}' && npm run dev:services"
fi

echo "[4/5] Waiting for Workbench Core (http://127.0.0.1:4100/health)..."
ok=0
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:4100/health" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 1
done
if [[ "${ok}" -ne 1 ]]; then
  echo "[ERROR] Workbench Core did not become healthy in time."
  echo "[HINT] Check backend logs (Core + internal services)."
  exit 1
fi

echo "[5/5] Registering account and provisioning all services..."
register_payload="$(printf '{"username":"%s","password":"%s"}' "${WB_USERNAME}" "${WB_PASSWORD}")"
register_response="$(
  curl -fsS -X POST "http://127.0.0.1:4100/accounts/register" \
    -H "Content-Type: application/json" \
    -d "${register_payload}"
)"

if command -v jq >/dev/null 2>&1; then
  echo "${register_response}" | jq -r '"[OK] user=\(.user.username)", (.provisioning[]? | "  - \(.serviceId): \(.status)\(if .message then " (\(.message))" else "" end)")'
else
  echo "[OK] Registration API returned:"
  echo "${register_response}"
fi

echo
echo "[DONE] System reset and bootstrap completed."
echo "Next:"
echo "  1. Keep backend services running."
echo "  2. Start native UI: ./infra/start_native.sh"
echo "  3. In Settings > Account, sign in with the same credentials once."

