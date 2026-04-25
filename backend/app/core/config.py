from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[3]
DATA_DIR = ROOT_DIR / "data"
DB_PATH = DATA_DIR / "etf_portfolio_profiler.db"

TIGER_BASE_URL = "https://investments.miraeasset.com"
TIGER_CONTEXT = "/tigeretf"

