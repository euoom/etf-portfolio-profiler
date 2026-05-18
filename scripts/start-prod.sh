#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"
LOG_LEVEL="${LOG_LEVEL:-info}"
PROD_LOG="${PROD_LOG:-$ROOT_DIR/.prod.log}"
PROD_PID_FILE="${PROD_PID_FILE:-$ROOT_DIR/.prod.pid}"
DEPLOY_LOG="${DEPLOY_LOG:-$ROOT_DIR/.deploy.log}"
UPDATE_CHECK_TIME="${UPDATE_CHECK_TIME:-04:00}"
AUTO_UPDATE="${AUTO_UPDATE:-true}"
RESTART_LOCK="${RESTART_LOCK:-$ROOT_DIR/.prod-restart.lock}"

backend_pid=""
update_pid=""

command -v uv >/dev/null 2>&1 || {
  echo "uv command not found. Install uv before running this script." >&2
  exit 1
}

command -v date >/dev/null 2>&1 || {
  echo "date command not found." >&2
  exit 1
}

cleanup() {
  local exit_code=$?

  if [[ -n "$update_pid" ]] && kill -0 "$update_pid" 2>/dev/null; then
    kill "$update_pid" 2>/dev/null || true
  fi

  if [[ -f "$PROD_PID_FILE" ]]; then
    current_pid="$(cat "$PROD_PID_FILE")"
    if [[ -n "$current_pid" ]] && kill -0 "$current_pid" 2>/dev/null; then
      kill "$current_pid" 2>/dev/null || true
    fi
  elif [[ -n "$backend_pid" ]] && kill -0 "$backend_pid" 2>/dev/null; then
    kill "$backend_pid" 2>/dev/null || true
  fi

  wait "$update_pid" 2>/dev/null || true
  wait "$backend_pid" 2>/dev/null || true
  rm -f "$RESTART_LOCK"

  exit "$exit_code"
}

trap cleanup EXIT INT TERM

start_backend() {
  echo "Starting prod backend on ${HOST}:${PORT}..."
  (
    cd "$BACKEND_DIR"
    exec uv run python main.py --host "$HOST" --port "$PORT" --no-reload --log-level "$LOG_LEVEL"
  ) >>"$PROD_LOG" 2>&1 &

  backend_pid=$!
  echo "$backend_pid" >"$PROD_PID_FILE"
  echo "Prod backend pid: ${backend_pid}"
}

seconds_until_next_update() {
  local now today_target tomorrow_target target

  now="$(date +%s)"
  today_target="$(date -d "today ${UPDATE_CHECK_TIME}" +%s)"

  if (( today_target > now )); then
    target="$today_target"
  else
    tomorrow_target="$(date -d "tomorrow ${UPDATE_CHECK_TIME}" +%s)"
    target="$tomorrow_target"
  fi

  echo $(( target - now ))
}

run_update_loop() {
  while true; do
    sleep "$(seconds_until_next_update)"
    echo "[$(date --iso-8601=seconds)] Running scheduled production update..." >>"$DEPLOY_LOG"
    "$ROOT_DIR/scripts/update-prod.sh" >>"$DEPLOY_LOG" 2>&1 || true
  done
}

start_backend

if [[ "$AUTO_UPDATE" == "true" ]]; then
  run_update_loop &
  update_pid=$!
  echo "Daily prod update check is enabled at ${UPDATE_CHECK_TIME}. Updater pid: ${update_pid}"
else
  echo "Daily prod update check is disabled."
fi

while true; do
  sleep 5

  if [[ -f "$PROD_PID_FILE" ]]; then
    current_pid="$(cat "$PROD_PID_FILE")"
    if [[ -n "$current_pid" ]] && kill -0 "$current_pid" 2>/dev/null; then
      backend_pid="$current_pid"
      continue
    fi
  fi

  if [[ -f "$RESTART_LOCK" ]]; then
    continue
  fi

  echo "Prod backend process is not running. See $PROD_LOG" >&2
  exit 1
done
