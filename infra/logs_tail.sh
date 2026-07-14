#!/usr/bin/env bash
# Tail Workbench JSONL logs (docs/imple/logging-foundation-plan.md LG-D5).
# Usage: logs_tail.sh <service|all> [-n LINES] [--level debug|info|warn|error]
#                     [--date YYYY-MM-DD] [-f]
# Examples:
#   logs_tail.sh core -n 100
#   logs_tail.sh tasks --level error
#   logs_tail.sh all --date 2026-07-13
#   ssh rocky@server "~/Workbench/infra/logs_tail.sh core --level warn"
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${WORKBENCH_LOG_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)/logs}"

SERVICE="${1:-}"
if [[ -z "$SERVICE" ]]; then
    echo "Usage: $(basename "$0") <service|all> [-n LINES] [--level LVL] [--date YYYY-MM-DD] [-f]" >&2
    exit 1
fi
shift

LINES=50
LEVEL=""
# Log files are stamped with the UTC date (logger uses ISO-8601 UTC timestamps).
DATE="$(date -u +%F)"
FOLLOW=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        -n) LINES="$2"; shift 2 ;;
        --level) LEVEL="$2"; shift 2 ;;
        --date) DATE="$2"; shift 2 ;;
        -f|--follow) FOLLOW=1; shift ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

if [[ "$SERVICE" == "all" ]]; then
    FILES=("${LOG_DIR}"/*-"${DATE}".jsonl)
else
    FILES=("${LOG_DIR}/${SERVICE}-${DATE}.jsonl")
fi

EXISTING=()
for f in "${FILES[@]}"; do
    [[ -f "$f" ]] && EXISTING+=("$f")
done
if [[ ${#EXISTING[@]} -eq 0 ]]; then
    echo "No log files for '${SERVICE}' on ${DATE} in ${LOG_DIR}" >&2
    exit 1
fi

filter_level() {
    if [[ -z "$LEVEL" ]]; then
        cat
    elif [[ "$LEVEL" == "warn" ]]; then
        grep -E '"level":"(warn|error)"' || true
    elif [[ "$LEVEL" == "error" ]]; then
        grep '"level":"error"' || true
    else
        cat
    fi
}

if [[ "$FOLLOW" == "1" ]]; then
    tail -n "$LINES" -F "${EXISTING[@]}" | filter_level
else
    # merge by the leading {"ts":"..."} field so multi-service output is chronological
    tail -n "$LINES" -q "${EXISTING[@]}" | sort | filter_level | tail -n "$LINES"
fi
