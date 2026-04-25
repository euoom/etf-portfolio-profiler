---
저장소: etf-portfolio-profiler
기술:
  - FastAPI
  - SQLite
  - Vite
  - React
  - TypeScript
상태: 개발중
tags: #저장소 #etf-portfolio-profiler
---

## 개요
ETF 포트폴리오 프로파일러의 데모 구현 저장소입니다. TIGER ETF 공개 Ajax 데이터를 먼저 수집하고, 일별 holdings 스냅샷을 SQLite에 쌓아 구성 비중 변화 분석을 제공합니다.

## 기술 스택 및 요구 사양
- **런타임/엔진**: Python 3.12, Node.js 24
- **프레임워크**: FastAPI, Vite React
- **사전 요구 사항**: 로컬 Python 가상환경, npm

## 주요 기능
- TIGER ETF 상품 목록 수집
- TIGER ETF 구성종목 PDF 수집
- SQLite 기반 `etf`, `etf_daily_snapshot`, `etf_daily_holding` 저장
- 최근 3일 비중 변화 분석 API
- 좌측 AI 분석 패널과 우측 피벗형 표/차트 데모

## 프로젝트 구조
- `backend/`: FastAPI API, SQLite 스키마, TIGER 수집기, 분석 서비스
- `frontend/`: Vite React 정적 SPA
- `data/`: 로컬 SQLite DB 저장 위치
- `docs/`: 설계 문서

## 시작하기
### 1. 백엔드
```bash
cd repository/etf-portfolio-profiler/backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

### 2. 프론트엔드
```bash
cd repository/etf-portfolio-profiler/frontend
npm install
npm run dev
```

## 개발 문서 및 관련 리소스
- **관련 프로젝트**: [[domain/etf-portfolio-profiler/project]]
- **데이터 소스 리서치**: [[domain/etf-portfolio-profiler/research/ETF_데이터_소스_및_수급_전략]]

## 라이선스
- 미정

