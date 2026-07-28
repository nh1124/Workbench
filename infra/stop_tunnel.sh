#!/usr/bin/env bash
set -euo pipefail

# Stops the Cloudflare tunnel started by start_tunnel.sh. `restart:
# unless-stopped` means the container comes back on its own after a crash or a
# reboot, so stopping it needs an explicit command rather than closing a shell.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.edge.yml"

if command -v docker-compose >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker-compose"
elif docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker compose"
else
    echo "ERROR: Docker Compose not found."
    exit 1
fi

ENV_FILE="$PROJECT_ROOT/.env.edge"
EDGE_ENV_FILE="../.env.edge"

echo "Stopping Cloudflare tunnel service..."
EDGE_ENV_FILE="$EDGE_ENV_FILE" \
    $DOCKER_COMPOSE --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile edge down

echo "Tunnel stopped."
