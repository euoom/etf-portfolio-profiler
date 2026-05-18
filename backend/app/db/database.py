import sqlite3
from collections.abc import Iterator

from app.core.config import DATA_DIR, DB_PATH


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def connection() -> Iterator[sqlite3.Connection]:
    conn = get_connection()
    try:
        yield conn
    finally:
        conn.close()


def init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with get_connection() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS etf (
                etf_id INTEGER PRIMARY KEY AUTOINCREMENT,
                provider TEXT NOT NULL,
                brand TEXT NOT NULL,
                ksd_fund TEXT NOT NULL UNIQUE,
                ticker TEXT,
                name TEXT NOT NULL,
                asset_class TEXT,
                category TEXT,
                net_assets_krw_100m REAL,
                nav_price REAL,
                listed_on TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS etf_daily_snapshot (
                snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
                etf_id INTEGER NOT NULL,
                base_date TEXT NOT NULL,
                source TEXT NOT NULL,
                collected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                content_hash TEXT NOT NULL,
                revision INTEGER NOT NULL DEFAULT 1,
                raw_html TEXT,
                FOREIGN KEY (etf_id) REFERENCES etf(etf_id),
                UNIQUE (etf_id, base_date, content_hash)
            );

            CREATE TABLE IF NOT EXISTS etf_daily_holding (
                holding_id INTEGER PRIMARY KEY AUTOINCREMENT,
                snapshot_id INTEGER NOT NULL,
                asset_code TEXT NOT NULL,
                asset_name TEXT NOT NULL,
                quantity REAL,
                valuation_amount REAL,
                weight REAL,
                period_return REAL,
                FOREIGN KEY (snapshot_id) REFERENCES etf_daily_snapshot(snapshot_id),
                UNIQUE (snapshot_id, asset_code, asset_name)
            );

            CREATE TABLE IF NOT EXISTS analysis_cache (
                cache_id INTEGER PRIMARY KEY AUTOINCREMENT,
                cache_key TEXT NOT NULL UNIQUE,
                payload_json TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE VIEW IF NOT EXISTS v_etf_holdings AS
            SELECT
                e.provider,
                e.brand,
                e.name AS etf_name,
                e.ksd_fund,
                e.ticker,
                s.base_date,
                s.collected_at,
                h.asset_code,
                h.asset_name,
                h.quantity,
                h.valuation_amount,
                h.weight,
                h.period_return
            FROM etf_daily_holding h
            JOIN etf_daily_snapshot s ON s.snapshot_id = h.snapshot_id
            JOIN etf e ON e.etf_id = s.etf_id;

            CREATE INDEX IF NOT EXISTS idx_etf_ksd_fund ON etf(ksd_fund);
            CREATE INDEX IF NOT EXISTS idx_snapshot_etf_date ON etf_daily_snapshot(etf_id, base_date);
            CREATE INDEX IF NOT EXISTS idx_holding_asset_code ON etf_daily_holding(asset_code);
            """
        )

