#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"

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

if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: $ENV_FILE not found."
    echo "Create it with: TUNNEL_TOKEN=<your-cloudflare-tunnel-token>"
    echo "See infra/env_samples/.env.edge.example for reference."
    exit 1
fi

echo "Starting Cloudflare tunnel service..."
EDGE_ENV_FILE="$EDGE_ENV_FILE" \
    $DOCKER_COMPOSE --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile edge up --build tunnel
