import os
import shutil
import sys
import tempfile
from pathlib import Path

os.environ["LLM_PROVIDER"] = "mock"
TEST_DATA_DIR = Path(tempfile.mkdtemp(prefix="etf-profiler-test-"))
os.environ["ETF_PROFILER_DATA_DIR"] = str(TEST_DATA_DIR)

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


def pytest_sessionfinish(session, exitstatus) -> None:
    shutil.rmtree(TEST_DATA_DIR, ignore_errors=True)
