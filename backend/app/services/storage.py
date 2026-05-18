import sqlite3

from app.services.tiger_collector import TigerHolding, TigerHoldingsSnapshot, TigerProduct


def upsert_products(conn: sqlite3.Connection, products: list[TigerProduct]) -> int:
    for product in products:
        conn.execute(
            """
            INSERT INTO etf (
                provider, brand, ksd_fund, ticker, name, asset_class, category,
                net_assets_krw_100m, nav_price, listed_on
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(ksd_fund) DO UPDATE SET
                ticker = excluded.ticker,
                name = excluded.name,
                asset_class = excluded.asset_class,
                category = excluded.category,
                net_assets_krw_100m = excluded.net_assets_krw_100m,
                nav_price = excluded.nav_price,
                listed_on = excluded.listed_on,
                updated_at = CURRENT_TIMESTAMP
            """,
            (
                "Mirae Asset Global Investments",
                "TIGER",
                product.ksd_fund,
                product.ticker,
                product.name,
                product.asset_class,
                product.category,
                product.net_assets_krw_100m,
                product.nav_price,
                product.listed_on,
            ),
        )
    conn.commit()
    return len(products)


def get_etf_id(conn: sqlite3.Connection, ksd_fund: str) -> int | None:
    row = conn.execute("SELECT etf_id FROM etf WHERE ksd_fund = ?", (ksd_fund,)).fetchone()
    return int(row["etf_id"]) if row else None


def snapshot_exists(conn: sqlite3.Connection, ksd_fund: str, base_date: str) -> bool:
    row = conn.execute(
        """
        SELECT 1
        FROM etf_daily_snapshot s
        JOIN etf e ON e.etf_id = s.etf_id
        WHERE e.ksd_fund = ? AND s.base_date = ?
        LIMIT 1
        """,
        (ksd_fund, base_date),
    ).fetchone()
    return row is not None


def insert_holdings_snapshot(conn: sqlite3.Connection, snapshot: TigerHoldingsSnapshot) -> int:
    etf_id = get_etf_id(conn, snapshot.ksd_fund)
    if etf_id is None:
        raise ValueError(f"ETF not found for ksd_fund={snapshot.ksd_fund}. Collect products first.")

    existing = conn.execute(
        """
        SELECT snapshot_id
        FROM etf_daily_snapshot
        WHERE etf_id = ? AND base_date = ? AND content_hash = ?
        """,
        (etf_id, snapshot.base_date, snapshot.content_hash),
    ).fetchone()
    if existing:
        return int(existing["snapshot_id"])

    revision_row = conn.execute(
        """
        SELECT COALESCE(MAX(revision), 0) + 1 AS next_revision
        FROM etf_daily_snapshot
        WHERE etf_id = ? AND base_date = ?
        """,
        (etf_id, snapshot.base_date),
    ).fetchone()
    revision = int(revision_row["next_revision"])
    cursor = conn.execute(
        """
        INSERT INTO etf_daily_snapshot (etf_id, base_date, source, content_hash, revision, raw_html)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (etf_id, snapshot.base_date, "TIGER pdfListAjax", snapshot.content_hash, revision, snapshot.raw_html),
    )
    snapshot_id = int(cursor.lastrowid)
    insert_holdings(conn, snapshot_id, snapshot.holdings)
    conn.commit()
    return snapshot_id


def insert_holdings(conn: sqlite3.Connection, snapshot_id: int, holdings: list[TigerHolding]) -> None:
    conn.executemany(
        """
        INSERT OR IGNORE INTO etf_daily_holding (
            snapshot_id, asset_code, asset_name, quantity, valuation_amount, weight, period_return
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                snapshot_id,
                holding.asset_code,
                holding.asset_name,
                holding.quantity,
                holding.valuation_amount,
                holding.weight,
                holding.period_return,
            )
            for holding in holdings
        ],
    )
