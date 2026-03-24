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

    log "Restarting Workbench in tmux session '${TMUX_SESSION}:${TMUX_WINDOW}'..."
    tmux send-keys -t "${TMUX_SESSION}:${TMUX_WINDOW}" C-c ""
    sleep 2
    tmux send-keys -t "${TMUX_SESSION}:${TMUX_WINDOW}" "cd \"$PROJECT_ROOT\" && npm run dev" Enter
    log "Restart sent to tmux session '$TMUX_SESSION'."
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
