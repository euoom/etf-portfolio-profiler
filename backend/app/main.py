import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import router
from app.core.config import CORS_ALLOW_ORIGINS
from app.db.database import init_db


logger = logging.getLogger(__name__)
app = FastAPI(title="ETF Portfolio Profiler API")


@app.middleware("http")
async def json_unhandled_errors(request: Request, call_next):
    try:
        return await call_next(request)
    except Exception:
        logger.exception("Unhandled API error: %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=500,
            content={
                "detail": "Internal server error",
                "path": request.url.path,
            },
        )

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOW_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup() -> None:
    init_db()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(router, prefix="/api")


def run() -> None:
    import argparse

    import uvicorn

    parser = argparse.ArgumentParser(description="Run the ETF Portfolio Profiler API server.")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--reload", dest="reload", action="store_true", default=True)
    parser.add_argument("--no-reload", dest="reload", action="store_false")
    parser.add_argument("--log-level", default="info")
    args = parser.parse_args()

    uvicorn.run(
        "app.main:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level=args.log_level,
    )


if __name__ == "__main__":
    run()
