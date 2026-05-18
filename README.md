# etf-portfolio-profiler

ETF holdings change profiler for Korean ETF brands, starting with TIGER and later KODEX.

## Stack

- Backend: FastAPI, SQLite
- Frontend: Vite, React, TypeScript
- LLM POC: local CLI provider adapter

## Layout

```text
backend/   FastAPI API, SQLite schema, TIGER collector, analysis services
frontend/  Static React SPA
data/      Local SQLite database location
docs/      Design notes
```

## Backend

```bash
cd backend
uv sync
uv run uvicorn app.main:app --reload --port 8000
```

Run the local backend and the configured ngrok tunnel together:

```bash
./scripts/start-dev-tunnel.sh
```

Run the backend, local frontend, and configured ngrok tunnel together:

```bash
./scripts/start-dev-all.sh
```

Optional environment overrides:

```bash
PORT=8010 NGROK_TUNNEL=etf-portfolio-profiler-api ./scripts/start-dev-tunnel.sh
PORT=8010 FRONTEND_PORT=5174 NGROK_TUNNEL=etf-portfolio-profiler-api ./scripts/start-dev-all.sh
```

Run the production backend with a daily update check:

```bash
./scripts/start-prod.sh
```

By default, `start-prod.sh` starts the backend and checks for updates every day at `04:00`. If a newer `master` commit exists, it applies the update, restarts the backend, and verifies `/health`. Override the update time or disable the built-in update loop with:

```bash
UPDATE_CHECK_TIME=03:30 ./scripts/start-prod.sh
AUTO_UPDATE=false ./scripts/start-prod.sh
```

Run the same pull-based production update once:

```bash
./scripts/update-prod.sh
```

Useful endpoints:

```text
GET  /health
POST /api/collect/tiger/products
POST /api/collect/tiger/holdings/{ksd_fund}
POST /api/collect/tiger/holdings/{ksd_fund}/recent?days=5
GET  /api/etfs
GET  /api/analysis/weight-changes?ksd_fund=KR70183J0002&days=5
GET  /api/analysis/holdings-pivot?ksd_fund=KR70183J0002&days=5
POST /api/chat
```

Recent TIGER holdings use the Korea Exchange calendar (`XKRX`) for business-day ranges. Existing snapshots are skipped, and only missing business dates are requested.

## Frontend

```bash
cd frontend
npm install
npm run dev
```

The frontend expects the API at `http://localhost:8000` by default. Override with:

```bash
VITE_API_BASE_URL=http://localhost:8000 npm run dev
```

Manual collection controls are hidden by default. Enable them for local development with:

```bash
VITE_SHOW_DEV_TOOLS=true npm run dev
```

Useful routes:

```text
/#/                         ETF change list
/#/cross                    Cross-ETF asset view
/#/etf/{ksd_fund}           ETF detail view
```
