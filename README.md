# etf-portfolio-profiler

국내 ETF 편입 종목 변화를 수집하고 비교하는 프로파일러입니다. 현재는 TIGER ETF를 우선 지원하며, 이후 KODEX 등 다른 브랜드로 확장할 수 있도록 구성합니다.

ETF holdings change profiler for Korean ETF brands. It starts with TIGER ETFs and is designed to expand to other brands such as KODEX.

## Stack

- Backend: FastAPI, SQLite
- Frontend: Vite, React, TypeScript
- LLM POC: local CLI provider adapter / 로컬 CLI provider 어댑터

## Layout

```text
backend/   FastAPI API, SQLite schema, TIGER collector, analysis services / 백엔드 API와 수집/분석 서비스
frontend/  Static React SPA / 정적 React SPA
data/      Local SQLite database location / 로컬 SQLite 데이터베이스 위치
docs/      Design notes / 설계 메모
```

## Backend

백엔드 개발 서버 실행:

Run the backend development server:

```bash
cd backend
uv sync
uv run uvicorn app.main:app --reload --port 8000
```

로컬 백엔드와 설정된 ngrok 터널을 함께 실행:

Run the local backend and the configured ngrok tunnel together:

```bash
./scripts/start-dev-tunnel.sh
```

백엔드, 로컬 프론트엔드, ngrok 터널을 함께 실행:

Run the backend, local frontend, and configured ngrok tunnel together:

```bash
./scripts/start-dev-all.sh
```

선택 환경변수 override:

Optional environment overrides:

```bash
PORT=8010 NGROK_TUNNEL=etf-portfolio-profiler-api ./scripts/start-dev-tunnel.sh
PORT=8010 FRONTEND_PORT=5174 NGROK_TUNNEL=etf-portfolio-profiler-api ./scripts/start-dev-all.sh
TIGER_REQUEST_DELAY_SECONDS=1.0 ./scripts/start-dev-tunnel.sh
```

운영 백엔드를 실행하고 매일 업데이트를 확인:

Run the production backend with a daily update check:

```bash
./scripts/start-prod.sh
```

기본값으로 `start-prod.sh`는 백엔드를 실행하고 매일 `04:00`에 업데이트를 확인합니다. 더 새로운 `master` 커밋이 있으면 업데이트를 적용하고, 백엔드를 재시작한 뒤 `/health`를 확인합니다.

By default, `start-prod.sh` starts the backend and checks for updates every day at `04:00`. If a newer `master` commit exists, it applies the update, restarts the backend, and verifies `/health`.

업데이트 시각을 바꾸거나 내장 업데이트 루프를 끌 수 있습니다:

Override the update time or disable the built-in update loop:

```bash
UPDATE_CHECK_TIME=03:30 ./scripts/start-prod.sh
AUTO_UPDATE=false ./scripts/start-prod.sh
```

동일한 pull-based 운영 업데이트를 한 번만 실행:

Run the same pull-based production update once:

```bash
./scripts/update-prod.sh
```

주요 엔드포인트:

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

최근 TIGER 편입 종목 수집은 한국거래소 캘린더(`XKRX`)를 사용해 영업일 범위를 계산합니다. 이미 존재하는 스냅샷은 건너뛰고, 누락된 영업일만 요청합니다.

Recent TIGER holdings use the Korea Exchange calendar (`XKRX`) for business-day ranges. Existing snapshots are skipped, and only missing business dates are requested.

TIGER 요청은 기본적으로 연속 요청 사이에 `0.75`초 간격을 둡니다. `TIGER_REQUEST_DELAY_SECONDS`로 조정할 수 있습니다.

TIGER requests are throttled with a default `0.75` second delay between consecutive requests. Configure it with `TIGER_REQUEST_DELAY_SECONDS`.

## Frontend

프론트엔드 개발 서버 실행:

Run the frontend development server:

```bash
cd frontend
npm install
npm run dev
```

프론트엔드는 기본적으로 API를 `http://localhost:8000`에서 찾습니다. 다음처럼 변경할 수 있습니다:

The frontend expects the API at `http://localhost:8000` by default. Override with:

```bash
VITE_API_BASE_URL=http://localhost:8000 npm run dev
```

수동 수집 컨트롤은 기본적으로 숨겨져 있습니다. 로컬 개발에서 활성화하려면:

Manual collection controls are hidden by default. Enable them for local development with:

```bash
VITE_SHOW_DEV_TOOLS=true npm run dev
```

주요 라우트:

Useful routes:

```text
/#/                         ETF change list
/#/cross                    Cross-ETF asset view
/#/etf/{ksd_fund}           ETF detail view
```
