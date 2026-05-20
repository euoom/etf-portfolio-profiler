#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"
FRONTEND_HOST="${FRONTEND_HOST:-0.0.0.0}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
NGROK_TUNNEL="${NGROK_TUNNEL:-etf-portfolio-profiler-api}"
BACKEND_LOG="${BACKEND_LOG:-$ROOT_DIR/.backend.log}"
FRONTEND_LOG="${FRONTEND_LOG:-$ROOT_DIR/.frontend.log}"
NGROK_LOG="${NGROK_LOG:-$ROOT_DIR/.ngrok.log}"
VITE_API_BASE_URL="${VITE_API_BASE_URL:-http://localhost:${PORT}}"

backend_pid=""
frontend_pid=""
ngrok_pid=""

cleanup() {
  local exit_code=$?

  if [[ -n "$ngrok_pid" ]] && kill -0 "$ngrok_pid" 2>/dev/null; then
    kill "$ngrok_pid" 2>/dev/null || true
  fi

  if [[ -n "$frontend_pid" ]] && kill -0 "$frontend_pid" 2>/dev/null; then
    kill "$frontend_pid" 2>/dev/null || true
  fi

  if [[ -n "$backend_pid" ]] && kill -0 "$backend_pid" 2>/dev/null; then
    kill "$backend_pid" 2>/dev/null || true
  fi

  wait "$ngrok_pid" 2>/dev/null || true
  wait "$frontend_pid" 2>/dev/null || true
  wait "$backend_pid" 2>/dev/null || true

  exit "$exit_code"
}

trap cleanup EXIT INT TERM

command -v uv >/dev/null 2>&1 || {
  echo "uv command not found. Install uv before running this script." >&2
  exit 1
}

command -v npm >/dev/null 2>&1 || {
  echo "npm command not found. Install npm before running this script." >&2
  exit 1
}

command -v ngrok >/dev/null 2>&1 || {
  echo "ngrok command not found. Install ngrok before running this script." >&2
  exit 1
}

echo "Starting backend on ${HOST}:${PORT}..."
(
  cd "$BACKEND_DIR"
  uv run python main.py --host "$HOST" --port "$PORT" --reload
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

echo "Starting frontend on ${FRONTEND_HOST}:${FRONTEND_PORT}..."
(
  cd "$FRONTEND_DIR"
  VITE_API_BASE_URL="$VITE_API_BASE_URL" npm run dev -- --host "$FRONTEND_HOST" --port "$FRONTEND_PORT"
) >"$FRONTEND_LOG" 2>&1 &
frontend_pid=$!

echo "Waiting for frontend dev server..."
for _ in {1..30}; do
  if curl -fsS "http://127.0.0.1:${FRONTEND_PORT}/" >/dev/null 2>&1; then
    break
  fi

  if ! kill -0 "$frontend_pid" 2>/dev/null; then
    echo "Frontend exited early. See $FRONTEND_LOG" >&2
    exit 1
  fi

  sleep 1
done

if ! curl -fsS "http://127.0.0.1:${FRONTEND_PORT}/" >/dev/null 2>&1; then
  echo "Frontend did not become available. See $FRONTEND_LOG" >&2
  exit 1
fi

echo "Starting ngrok tunnel '${NGROK_TUNNEL}'..."
ngrok start "$NGROK_TUNNEL" >"$NGROK_LOG" 2>&1 &
ngrok_pid=$!

cat <<EOF

ETF Portfolio Profiler dev stack is running.

Frontend: http://127.0.0.1:${FRONTEND_PORT}
Backend:  http://127.0.0.1:${PORT}
Health:   http://127.0.0.1:${PORT}/health
ngrok:    ${NGROK_TUNNEL}

Logs:
  frontend: $FRONTEND_LOG
  backend:  $BACKEND_LOG
  ngrok:    $NGROK_LOG

Press Ctrl+C to stop all processes.
EOF

wait -n "$backend_pid" "$frontend_pid" "$ngrok_pid"
