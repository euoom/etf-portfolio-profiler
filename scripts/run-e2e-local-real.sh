#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"

BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
BACKEND_PORT="${BACKEND_PORT:-8010}"
FRONTEND_HOST="${FRONTEND_HOST:-127.0.0.1}"
FRONTEND_PORT="${FRONTEND_PORT:-4174}"
BACKEND_URL="http://${BACKEND_HOST}:${BACKEND_PORT}"
FRONTEND_URL="http://${FRONTEND_HOST}:${FRONTEND_PORT}/etf-portfolio-profiler/"

BACKEND_LOG="${BACKEND_LOG:-$ROOT_DIR/.e2e-local-backend.log}"
FRONTEND_LOG="${FRONTEND_LOG:-$ROOT_DIR/.e2e-local-frontend.log}"
LLM_PROVIDER="${LLM_PROVIDER:-nvidia}"
RUN_REAL_COLLECTOR_E2E="${RUN_REAL_COLLECTOR_E2E:-1}"
E2E_THEME="${E2E_THEME:-dark}"
CHAT_QUALITY_CDP="${CHAT_QUALITY_CDP:-0}"
CHAT_QUALITY_LOG="${CHAT_QUALITY_LOG:-$ROOT_DIR/.chat-quality-cdp.log}"
TIGER_CHECK_LABEL="disabled"
if [[ "$RUN_REAL_COLLECTOR_E2E" == "1" ]]; then
  TIGER_CHECK_LABEL="enabled"
fi
PLAYWRIGHT_CDP_ENDPOINT="${PLAYWRIGHT_CDP_ENDPOINT:-}"

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

assert_port_available() {
  local label="$1"
  local host="$2"
  local port="$3"

  if command -v ss >/dev/null 2>&1 && ss -ltn "sport = :$port" | grep -q ":$port"; then
    echo "$label port $host:$port is already in use. Stop the existing process or set ${label^^}_PORT." >&2
    return 1
  fi
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

assert_port_available "backend" "$BACKEND_HOST" "$BACKEND_PORT"
assert_port_available "frontend" "$FRONTEND_HOST" "$FRONTEND_PORT"

cat <<EOF
Starting local real E2E stack.

Backend:  ${BACKEND_URL}
Frontend: ${FRONTEND_URL}
LLM:      ${LLM_PROVIDER}
Data dir: ${ETF_PROFILER_DATA_DIR:-$ROOT_DIR/data}
CDP:      ${PLAYWRIGHT_CDP_ENDPOINT:-disabled}
Theme:    ${E2E_THEME}
TIGER:    collector check ${TIGER_CHECK_LABEL}
Chat QA:  ${CHAT_QUALITY_CDP}

This script uses the real local DB and the real LLM provider configured in backend/.env
or the current shell environment. It does not create a temporary mock data directory.
EOF

(
  cd "$BACKEND_DIR"
  LLM_PROVIDER="$LLM_PROVIDER" \
    CORS_ALLOW_ORIGINS="http://${FRONTEND_HOST}:${FRONTEND_PORT},http://localhost:${FRONTEND_PORT}" \
    uv run --python 3.13 python main.py --host "$BACKEND_HOST" --port "$BACKEND_PORT" --no-reload
) >"$BACKEND_LOG" 2>&1 &
backend_pid=$!

wait_for_url "Backend" "${BACKEND_URL}/health" "$backend_pid" || {
  echo "Backend log:" >&2
  cat "$BACKEND_LOG" >&2 || true
  exit 1
}

(
  cd "$FRONTEND_DIR"
  VITE_API_BASE_URL="$BACKEND_URL" npm run build
)

(
  cd "$FRONTEND_DIR"
  npm run preview -- --host "$FRONTEND_HOST" --port "$FRONTEND_PORT" --strictPort
) >"$FRONTEND_LOG" 2>&1 &
frontend_pid=$!

wait_for_url "Frontend" "$FRONTEND_URL" "$frontend_pid" || {
  echo "Frontend log:" >&2
  cat "$FRONTEND_LOG" >&2 || true
  exit 1
}

(
  cd "$FRONTEND_DIR"
  if [[ -n "$PLAYWRIGHT_CDP_ENDPOINT" ]]; then
    if [[ "$CHAT_QUALITY_CDP" == "1" ]]; then
      E2E_BACKEND_URL="$BACKEND_URL" \
        PLAYWRIGHT_BASE_URL="$FRONTEND_URL" \
        PLAYWRIGHT_CDP_ENDPOINT="$PLAYWRIGHT_CDP_ENDPOINT" \
        E2E_THEME="$E2E_THEME" \
        CHAT_QUALITY_LOG="$CHAT_QUALITY_LOG" \
        npm run chat:quality:cdp
    else
      E2E_BACKEND_URL="$BACKEND_URL" \
        PLAYWRIGHT_BASE_URL="$FRONTEND_URL" \
        PLAYWRIGHT_CDP_ENDPOINT="$PLAYWRIGHT_CDP_ENDPOINT" \
        E2E_THEME="$E2E_THEME" \
        RUN_REAL_COLLECTOR_E2E="$RUN_REAL_COLLECTOR_E2E" \
        npm run e2e:local:cdp
    fi
  else
    if [[ "$CHAT_QUALITY_CDP" == "1" ]]; then
      echo "CHAT_QUALITY_CDP=1 requires PLAYWRIGHT_CDP_ENDPOINT." >&2
      exit 1
    fi
    E2E_BACKEND_URL="$BACKEND_URL" \
      PLAYWRIGHT_BASE_URL="$FRONTEND_URL" \
      E2E_THEME="$E2E_THEME" \
      RUN_REAL_COLLECTOR_E2E="$RUN_REAL_COLLECTOR_E2E" \
      npm run e2e:local
  fi
)
