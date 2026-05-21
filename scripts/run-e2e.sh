#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"

BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_HOST="${FRONTEND_HOST:-127.0.0.1}"
FRONTEND_PORT="${FRONTEND_PORT:-4173}"
BACKEND_URL="http://${BACKEND_HOST}:${BACKEND_PORT}"
FRONTEND_URL="http://${FRONTEND_HOST}:${FRONTEND_PORT}/etf-portfolio-profiler/"

DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/etf-profiler-e2e-data.XXXXXX")"
BACKEND_LOG="${BACKEND_LOG:-$ROOT_DIR/.e2e-backend.log}"
FRONTEND_LOG="${FRONTEND_LOG:-$ROOT_DIR/.e2e-frontend.log}"

backend_pid=""
frontend_pid=""

cleanup() {
  local exit_code=$?

  if [[ -n "$frontend_pid" ]] && kill -0 "$frontend_pid" 2>/dev/null; then
    kill "$frontend_pid" 2>/dev/null || true
  fi
  if [[ -n "$backend_pid" ]] && kill -0 "$backend_pid" 2>/dev/null; then
    kill "$backend_pid" 2>/dev/null || true
  fi

  wait "$frontend_pid" 2>/dev/null || true
  wait "$backend_pid" 2>/dev/null || true
  rm -rf "$DATA_DIR"

  exit "$exit_code"
}

wait_for_url() {
  local label="$1"
  local url="$2"
  local pid="$3"

  for _ in {1..60}; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "$label exited early." >&2
      return 1
    fi
    sleep 1
  done

  echo "$label did not become ready at $url" >&2
  return 1
}

trap cleanup EXIT INT TERM

command -v uv >/dev/null 2>&1 || {
  echo "uv command not found." >&2
  exit 1
}

command -v npm >/dev/null 2>&1 || {
  echo "npm command not found." >&2
  exit 1
}

echo "Starting backend for E2E on ${BACKEND_URL}..."
(
  cd "$BACKEND_DIR"
  ETF_PROFILER_DATA_DIR="$DATA_DIR" \
    LLM_PROVIDER=mock \
    CORS_ALLOW_ORIGINS="http://${FRONTEND_HOST}:${FRONTEND_PORT},http://localhost:${FRONTEND_PORT}" \
    uv run --python 3.13 python main.py --host "$BACKEND_HOST" --port "$BACKEND_PORT" --no-reload
) >"$BACKEND_LOG" 2>&1 &
backend_pid=$!

wait_for_url "Backend" "${BACKEND_URL}/health" "$backend_pid" || {
  echo "Backend log:" >&2
  cat "$BACKEND_LOG" >&2 || true
  exit 1
}

echo "Building frontend for E2E..."
(
  cd "$FRONTEND_DIR"
  VITE_API_BASE_URL="$BACKEND_URL" npm run build
)

echo "Starting frontend preview on ${FRONTEND_URL}..."
(
  cd "$FRONTEND_DIR"
  npm run preview -- --host "$FRONTEND_HOST" --port "$FRONTEND_PORT"
) >"$FRONTEND_LOG" 2>&1 &
frontend_pid=$!

wait_for_url "Frontend" "$FRONTEND_URL" "$frontend_pid" || {
  echo "Frontend log:" >&2
  cat "$FRONTEND_LOG" >&2 || true
  exit 1
}

echo "Running Playwright E2E tests..."
(
  cd "$FRONTEND_DIR"
  E2E_BACKEND_URL="$BACKEND_URL" PLAYWRIGHT_BASE_URL="$FRONTEND_URL" npm run e2e:ci
)
