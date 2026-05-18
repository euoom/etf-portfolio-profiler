#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"
NGROK_TUNNEL="${NGROK_TUNNEL:-etf-portfolio-profiler-api}"
BACKEND_LOG="${BACKEND_LOG:-$ROOT_DIR/.backend.log}"
NGROK_LOG="${NGROK_LOG:-$ROOT_DIR/.ngrok.log}"

backend_pid=""
ngrok_pid=""

cleanup() {
  local exit_code=$?

  if [[ -n "$ngrok_pid" ]] && kill -0 "$ngrok_pid" 2>/dev/null; then
    kill "$ngrok_pid" 2>/dev/null || true
  fi

  if [[ -n "$backend_pid" ]] && kill -0 "$backend_pid" 2>/dev/null; then
    kill "$backend_pid" 2>/dev/null || true
  fi

  wait "$ngrok_pid" 2>/dev/null || true
  wait "$backend_pid" 2>/dev/null || true

  exit "$exit_code"
}

trap cleanup EXIT INT TERM

command -v uv >/dev/null 2>&1 || {
  echo "uv command not found. Install uv before running this script." >&2
  exit 1
}

command -v ngrok >/dev/null 2>&1 || {
  echo "ngrok command not found. Install ngrok before running this script." >&2
  exit 1
}

echo "Starting backend on ${HOST}:${PORT}..."
(
  cd "$BACKEND_DIR"
  uv run python main.py --host "$HOST" --port "$PORT" --no-reload
) >"$BACKEND_LOG" 2>&1 &
backend_pid=$!

echo "Waiting for backend health check..."
for _ in {1..30}; do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    break
  fi

  if ! kill -0 "$backend_pid" 2>/dev/null; then
    echo "Backend exited early. See $BACKEND_LOG" >&2
    exit 1
  fi

  sleep 1
done

if ! curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "Backend did not become healthy. See $BACKEND_LOG" >&2
  exit 1
fi

echo "Starting ngrok tunnel '${NGROK_TUNNEL}'..."
ngrok start "$NGROK_TUNNEL" >"$NGROK_LOG" 2>&1 &
ngrok_pid=$!

cat <<EOF

ETF Portfolio Profiler dev tunnel is running.

Backend: http://127.0.0.1:${PORT}
Health:  http://127.0.0.1:${PORT}/health
ngrok:   ${NGROK_TUNNEL}

Logs:
  backend: $BACKEND_LOG
  ngrok:   $NGROK_LOG

Press Ctrl+C to stop both processes.
EOF

wait -n "$backend_pid" "$ngrok_pid"
