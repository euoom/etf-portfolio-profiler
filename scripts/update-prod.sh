#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"

REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-master}"
PORT="${PORT:-8000}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${PORT}/health}"
PROD_LOG="${PROD_LOG:-$ROOT_DIR/.prod.log}"
PROD_PID_FILE="${PROD_PID_FILE:-$ROOT_DIR/.prod.pid}"
SERVICE_NAME="${SERVICE_NAME:-}"
HOST="${HOST:-0.0.0.0}"
LOG_LEVEL="${LOG_LEVEL:-info}"
RESTART_LOCK="${RESTART_LOCK:-$ROOT_DIR/.prod-restart.lock}"

cd "$ROOT_DIR"

trap 'rm -f "$RESTART_LOCK"' EXIT

command -v git >/dev/null 2>&1 || {
  echo "git command not found." >&2
  exit 1
}

command -v uv >/dev/null 2>&1 || {
  echo "uv command not found. Install uv before running this script." >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || {
  echo "curl command not found." >&2
  exit 1
}

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Tracked files have local changes. Refusing to deploy over local changes." >&2
  git status --short >&2
  exit 1
fi

echo "Fetching ${REMOTE}/${BRANCH}..."
git fetch "$REMOTE" "$BRANCH"

local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse "${REMOTE}/${BRANCH}")"

if [[ "$local_sha" == "$remote_sha" ]]; then
  echo "No updates. Already at ${local_sha}."
  exit 0
fi

echo "Updating ${local_sha} -> ${remote_sha}..."
git pull --ff-only "$REMOTE" "$BRANCH"

echo "Syncing backend dependencies..."
(
  cd "$BACKEND_DIR"
  uv sync --frozen
  uv run python -m compileall app
)

restart_with_systemd() {
  echo "Restarting systemd service ${SERVICE_NAME}..."
  systemctl restart "$SERVICE_NAME"
}

restart_with_pid_file() {
  touch "$RESTART_LOCK"

  if [[ -f "$PROD_PID_FILE" ]]; then
    old_pid="$(cat "$PROD_PID_FILE")"
    if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
      echo "Stopping existing prod process ${old_pid}..."
      kill "$old_pid"

      for _ in {1..30}; do
        if ! kill -0 "$old_pid" 2>/dev/null; then
          break
        fi
        sleep 1
      done

      if kill -0 "$old_pid" 2>/dev/null; then
        echo "Existing prod process did not stop in time: ${old_pid}" >&2
        exit 1
      fi
    fi
  fi

  echo "Starting prod process..."
  (
    cd "$BACKEND_DIR"
    exec uv run python main.py --host "$HOST" --port "$PORT" --no-reload --log-level "$LOG_LEVEL"
  ) >>"$PROD_LOG" 2>&1 &
  echo "$!" >"$PROD_PID_FILE"
}

if [[ -n "$SERVICE_NAME" ]]; then
  restart_with_systemd
else
  restart_with_pid_file
fi

echo "Waiting for health check..."
for _ in {1..30}; do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    echo "Deployment complete. Health check passed: ${HEALTH_URL}"
    exit 0
  fi

  sleep 1
done

echo "Deployment finished, but health check failed: ${HEALTH_URL}" >&2
echo "See log: ${PROD_LOG}" >&2
exit 1
