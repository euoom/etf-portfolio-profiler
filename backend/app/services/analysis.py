import sqlite3


def list_etfs(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        """
        SELECT etf_id, provider, brand, ksd_fund, ticker, name, asset_class, category,
               net_assets_krw_100m, nav_price, listed_on, updated_at
        FROM etf
        ORDER BY name
        """
    ).fetchall()
    return [dict(row) for row in rows]


def weight_changes(conn: sqlite3.Connection, ksd_fund: str, days: int = 3) -> list[dict]:
    rows = conn.execute(
        """
        WITH recent_dates AS (
            SELECT DISTINCT s.base_date
            FROM etf_daily_snapshot s
            JOIN etf e ON e.etf_id = s.etf_id
            WHERE e.ksd_fund = ?
            ORDER BY s.base_date DESC
            LIMIT ?
        ),
        holdings AS (
            SELECT h.asset_code, h.asset_name, s.base_date, h.weight
            FROM etf_daily_holding h
            JOIN etf_daily_snapshot s ON s.snapshot_id = h.snapshot_id
            JOIN etf e ON e.etf_id = s.etf_id
            WHERE e.ksd_fund = ?
              AND s.base_date IN (SELECT base_date FROM recent_dates)
        )
        SELECT
            asset_code,
            asset_name,
            MIN(base_date) AS start_date,
            MAX(base_date) AS end_date,
            MAX(CASE WHEN base_date = (SELECT MIN(base_date) FROM recent_dates) THEN weight END) AS start_weight,
            MAX(CASE WHEN base_date = (SELECT MAX(base_date) FROM recent_dates) THEN weight END) AS end_weight,
            COALESCE(MAX(CASE WHEN base_date = (SELECT MAX(base_date) FROM recent_dates) THEN weight END), 0)
              - COALESCE(MAX(CASE WHEN base_date = (SELECT MIN(base_date) FROM recent_dates) THEN weight END), 0) AS weight_delta
        FROM holdings
        GROUP BY asset_code, asset_name
        ORDER BY ABS(weight_delta) DESC
        LIMIT 30
        """,
        (ksd_fund, days, ksd_fund),
    ).fetchall()
    return [dict(row) for row in rows]


def holdings_pivot(conn: sqlite3.Connection, ksd_fund: str, days: int = 3) -> dict:
    date_rows = conn.execute(
        """
        SELECT DISTINCT s.base_date
        FROM etf_daily_snapshot s
        JOIN etf e ON e.etf_id = s.etf_id
        WHERE e.ksd_fund = ?
        ORDER BY s.base_date DESC
        LIMIT ?
        """,
        (ksd_fund, days),
    ).fetchall()
    dates = sorted(row["base_date"] for row in date_rows)
    if not dates:
        return {"dates": [], "rows": []}

    placeholders = ",".join("?" for _ in dates)
    rows = conn.execute(
        f"""
        SELECT h.asset_code, h.asset_name, s.base_date, h.weight, h.quantity, h.valuation_amount
        FROM etf_daily_holding h
        JOIN etf_daily_snapshot s ON s.snapshot_id = h.snapshot_id
        JOIN etf e ON e.etf_id = s.etf_id
        WHERE e.ksd_fund = ?
          AND s.base_date IN ({placeholders})
        ORDER BY h.asset_name, s.base_date
        """,
        (ksd_fund, *dates),
    ).fetchall()

    by_asset: dict[tuple[str, str], dict] = {}
    for row in rows:
        key = (row["asset_code"], row["asset_name"])
        item = by_asset.setdefault(
            key,
            {
                "asset_code": row["asset_code"],
                "asset_name": row["asset_name"],
                "weights": {base_date: None for base_date in dates},
                "quantities": {base_date: None for base_date in dates},
                "valuation_amounts": {base_date: None for base_date in dates},
            },
        )
        item["weights"][row["base_date"]] = row["weight"]
        item["quantities"][row["base_date"]] = row["quantity"]
        item["valuation_amounts"][row["base_date"]] = row["valuation_amount"]

    pivot_rows = []
    start_date = dates[0]
    end_date = dates[-1]
    for item in by_asset.values():
        start_weight = item["weights"].get(start_date) or 0
        end_weight = item["weights"].get(end_date) or 0
        item["weight_delta"] = end_weight - start_weight
        pivot_rows.append(item)

    pivot_rows.sort(key=lambda item: abs(item["weight_delta"]), reverse=True)
    return {"dates": dates, "rows": pivot_rows}
