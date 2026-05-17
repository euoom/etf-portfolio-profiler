import os
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[3]
BACKEND_DIR = ROOT_DIR / "backend"
DATA_DIR = ROOT_DIR / "data"
DB_PATH = DATA_DIR / "etf_portfolio_profiler.db"


def _load_env_file(path: Path) -> None:
    if not path.exists():
        return

    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'\"")
        if key:
            os.environ.setdefault(key, value)


_load_env_file(BACKEND_DIR / ".env")

CORS_ALLOW_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ALLOW_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,https://euoom.github.io",
    ).split(",")
    if origin.strip()
]
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "mock").strip().lower()
LOCAL_LLM_COMMAND = os.getenv("LOCAL_LLM_COMMAND", "").strip()
NVIDIA_API_KEY = os.getenv("NVIDIA_API_KEY", "").strip()
NVIDIA_BASE_URL = os.getenv("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1").rstrip("/")
NVIDIA_MODEL = os.getenv("NVIDIA_MODEL", "minimaxai/minimax-m2.7").strip()

TIGER_BASE_URL = "https://investments.miraeasset.com"
TIGER_CONTEXT = "/tigeretf"
