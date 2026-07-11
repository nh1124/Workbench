#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LOCK_FILE="/tmp/workbench-auto-update.lock"

MODE="${1:-watch}"
CHECK_INTERVAL_SECONDS="${CHECK_INTERVAL_SECONDS:-60}"
TARGET_BRANCH="${TARGET_BRANCH:-}"
ALLOW_DIRTY="${ALLOW_DIRTY:-0}"
RESTART_AFTER_PULL="${RESTART_AFTER_PULL:-1}"
TMUX_SESSION="${TMUX_SESSION:-workbench}"
TMUX_WINDOW="${TMUX_WINDOW:-0}"

timestamp() {
    date +"%Y-%m-%d %H:%M:%S"
}

log() {
    echo "[$(timestamp)] $*"
}

require_commands() {
    local required=(git npm node awk)
    for cmd in "${required[@]}"; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            log "ERROR: Required command not found: $cmd"
            exit 1
        fi
    done
}

resolve_branch() {
    if [[ -n "$TARGET_BRANCH" ]]; then
        return
    fi

    TARGET_BRANCH="$(git -C "$PROJECT_ROOT" rev-parse --abbrev-ref HEAD)"
    if [[ "$TARGET_BRANCH" == "HEAD" ]]; then
        log "ERROR: Detached HEAD detected. Set TARGET_BRANCH explicitly."
        exit 1
    fi
}

ensure_clean_worktree() {
    if [[ "$ALLOW_DIRTY" == "1" ]]; then
        return
    fi

    if [[ -n "$(git -C "$PROJECT_ROOT" status --porcelain)" ]]; then
        log "WARN: Working tree is dirty. Skipping update (set ALLOW_DIRTY=1 to override)."
        return 1
    fi
}

# Node-run service ports (4102/artifacts excluded: it may legitimately stay
# bound by the workbench-artifacts-service container in docker-only mode).
NODE_SERVICE_PORT_REGEX=':(4100|4101|4103|4104|4105|4106|4107|4108|8100)[[:space:]]'

artifacts_runs_in_docker() {
    command -v docker >/dev/null 2>&1 \
        && docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^workbench-artifacts-service$'
}

resolve_restart_command() {
    if [[ -n "${RESTART_COMMAND:-}" ]]; then
        echo "$RESTART_COMMAND"
        return
    fi
    if artifacts_runs_in_docker; then
        # Artifacts is docker-only on this host (see infra/start_services.sh):
        # rebuild its image so the pulled code is reflected, then start the
        # node stack without artifacts to avoid EADDRINUSE on 4102.
        echo "docker compose up -d --build artifacts-db artifacts workbench-core-db notes-db tasks-db projects-db images-db mindmaps-db wbs-db insights-db && npm run dev:web:no-artifacts"
        return
    fi
    echo "npm run dev"
}

wait_for_node_service_ports() {
    if ! command -v ss >/dev/null 2>&1; then
        sleep 5
        return
    fi
    for _ in $(seq 1 15); do
        if ! ss -ltn 2>/dev/null | grep -qE "$NODE_SERVICE_PORT_REGEX"; then
            return
        fi
        sleep 2
    done
    log "WARN: Some service ports are still in use after waiting; the restart may fail."
}

restart_service() {
    log "Running npm install..."
    cd "$PROJECT_ROOT"
    npm install

    if ! command -v tmux >/dev/null 2>&1; then
        log "WARN: tmux not found. Skipping service restart."
        return
    fi

    if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
        log "WARN: tmux session '$TMUX_SESSION' not found. Skipping restart."
        return
    fi

    local restart_command
    restart_command="$(resolve_restart_command)"

    log "Restarting Workbench in tmux session '${TMUX_SESSION}:${TMUX_WINDOW}'..."
    tmux send-keys -t "${TMUX_SESSION}:${TMUX_WINDOW}" C-c ""
    wait_for_node_service_ports
    tmux send-keys -t "${TMUX_SESSION}:${TMUX_WINDOW}" "cd \"$PROJECT_ROOT\" && ${restart_command}" Enter
    log "Restart sent to tmux session '$TMUX_SESSION' (command: ${restart_command})."
}

update_once() {
    local local_commit remote_commit

    local_commit="$(git -C "$PROJECT_ROOT" rev-parse HEAD)"
    remote_commit="$(git -C "$PROJECT_ROOT" ls-remote --heads origin "$TARGET_BRANCH" | awk '{print $1}')"

    if [[ -z "$remote_commit" ]]; then
        log "ERROR: Could not resolve remote commit for branch origin/$TARGET_BRANCH"
        return 1
    fi

    if [[ "$local_commit" == "$remote_commit" ]]; then
        log "No changes on origin/$TARGET_BRANCH (local=$local_commit)"
        return 0
    fi

    log "Update detected on origin/$TARGET_BRANCH (local=$local_commit, remote=$remote_commit)"

    if ! ensure_clean_worktree; then
        return 0
    fi

    (
        cd "$PROJECT_ROOT"
        git fetch origin "$TARGET_BRANCH"
        git pull --ff-only origin "$TARGET_BRANCH"
    )

    if [[ "$RESTART_AFTER_PULL" == "1" ]]; then
        restart_service
    else
        log "Skipping service restart (RESTART_AFTER_PULL=$RESTART_AFTER_PULL)"
    fi
}

watch_loop() {
    log "Starting watch mode (interval=${CHECK_INTERVAL_SECONDS}s, branch=${TARGET_BRANCH}, session=${TMUX_SESSION})"
    while true; do
        update_once || true
        sleep "$CHECK_INTERVAL_SECONDS"
    done
}

main() {
    require_commands
    resolve_branch

    if command -v flock >/dev/null 2>&1; then
        exec 200>"$LOCK_FILE"
        if ! flock -n 200; then
            log "Another auto_update.sh process is running. Exiting."
            exit 0
        fi
    else
        log "WARN: flock not found. Locking is disabled."
    fi

    case "$MODE" in
        once)
            log "Running one-shot update check"
            update_once
            ;;
        watch)
            watch_loop
            ;;
        *)
            log "ERROR: Unknown mode '$MODE'. Use 'once' or 'watch'."
            exit 1
            ;;
    esac
}

main "$@"
