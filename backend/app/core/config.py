import os
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[3]
DATA_DIR = ROOT_DIR / "data"
DB_PATH = DATA_DIR / "etf_portfolio_profiler.db"
CORS_ALLOW_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ALLOW_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,https://euoom.github.io",
    ).split(",")
    if origin.strip()
]

TIGER_BASE_URL = "https://investments.miraeasset.com"
TIGER_CONTEXT = "/tigeretf"
