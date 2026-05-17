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
./scripts/dev-tunnel.sh
```

Optional environment overrides:

```bash
PORT=8010 NGROK_TUNNEL=etf-portfolio-profiler-api ./scripts/dev-tunnel.sh
```

Useful endpoints:

```text
GET  /health
POST /api/collect/tiger/products
POST /api/collect/tiger/holdings/{ksd_fund}
POST /api/collect/tiger/holdings/{ksd_fund}/recent?days=3
GET  /api/etfs
GET  /api/analysis/weight-changes?ksd_fund=KR70183J0002&days=3
GET  /api/analysis/holdings-pivot?ksd_fund=KR70183J0002&days=3
POST /api/chat
```

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
