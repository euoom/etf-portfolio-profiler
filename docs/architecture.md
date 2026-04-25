# Architecture

## Product Direction

The first demo focuses on TIGER ETF data:

1. Collect TIGER product list.
2. Collect daily holdings snapshots for selected ETFs.
3. Collect recent business-day snapshots when the user asks for a period such as "최근 3일".
4. Store normalized snapshots and holdings in SQLite.
5. Show holdings as an OLAP-like pivot matrix with dates as columns.
6. Show each selected/changed holding as a line series over the date columns.
7. Let an AI panel trigger predefined analyses.

KODEX is the next provider target after TIGER collection is stable.

## Backend

FastAPI owns:

- collection jobs
- SQLite schema and persistence
- analysis queries
- LLM provider adapters

The frontend never calls LLM providers directly.

## Frontend

The app is a static Vite React SPA:

- left: AI analysis panel
- right: analysis canvas
- canvas top: pivot-like table
- canvas bottom: chart
- light/dark theme toggle

Initial suggested prompt:

```text
최근 3일간 비중 변화 큰 종목 찾아줘
```

## LLM

The POC may use local terminal login based CLI tools through `LocalCliProvider`.
Production should move to user-configured provider credentials.
