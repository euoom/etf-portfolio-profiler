import sqlite3


def _date_filter_sql(
    date_column: str = "base_date",
    *,
    start_date: str | None,
    end_date: str | None,
    days: int,
) -> tuple[str, tuple]:
    if start_date and end_date:
        return f"{date_column} BETWEEN ? AND ?", (start_date, end_date)
    if start_date:
        return f"{date_column} >= ?", (start_date,)
    if end_date:
        return f"{date_column} <= ?", (end_date,)
    return (
        f"""
        {date_column} IN (
            SELECT DISTINCT base_date
            FROM etf_daily_snapshot
            ORDER BY base_date DESC
            LIMIT ?
        )
        """,
        (days,),
    )


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


def holdings_pivot(
    conn: sqlite3.Connection,
    ksd_fund: str,
    days: int = 3,
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict:
    if start_date or end_date:
        filter_sql, filter_params = _date_filter_sql("s.base_date", start_date=start_date, end_date=end_date, days=days)
        date_rows = conn.execute(
            f"""
            SELECT DISTINCT s.base_date
            FROM etf_daily_snapshot s
            JOIN etf e ON e.etf_id = s.etf_id
            WHERE e.ksd_fund = ?
              AND {filter_sql}
            ORDER BY s.base_date DESC
            """,
            (ksd_fund, *filter_params),
        ).fetchall()
    else:
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


def cross_etf_weight_changes(
    conn: sqlite3.Connection,
    days: int = 3,
    limit: int = 40,
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict:
    filter_sql, filter_params = _date_filter_sql("base_date", start_date=start_date, end_date=end_date, days=days)
    date_rows = conn.execute(
        f"""
        SELECT DISTINCT base_date
        FROM etf_daily_snapshot
        WHERE {filter_sql}
        ORDER BY base_date DESC
        """,
        filter_params,
    ).fetchall()
    dates = sorted(row["base_date"] for row in date_rows)
    if not dates:
        return {"dates": [], "rows": []}

    placeholders = ",".join("?" for _ in dates)
    rows = conn.execute(
        f"""
        SELECT
            h.asset_code,
            h.asset_name,
            s.base_date,
            SUM(COALESCE(h.weight, 0)) AS total_weight,
            AVG(COALESCE(h.weight, 0)) AS avg_weight,
            MAX(COALESCE(h.weight, 0)) AS max_weight,
            SUM(COALESCE(h.quantity, 0)) AS total_quantity,
            SUM(COALESCE(h.valuation_amount, 0)) AS total_valuation_amount,
            COUNT(DISTINCT e.etf_id) AS etf_count
        FROM etf_daily_holding h
        JOIN etf_daily_snapshot s ON s.snapshot_id = h.snapshot_id
        JOIN etf e ON e.etf_id = s.etf_id
        WHERE s.base_date IN ({placeholders})
        GROUP BY h.asset_code, h.asset_name, s.base_date
        """,
        tuple(dates),
    ).fetchall()

    latest_date = dates[-1]
    exposure_rows = conn.execute(
        """
        SELECT
            h.asset_code,
            h.asset_name,
            e.name AS etf_name,
            h.weight
        FROM etf_daily_holding h
        JOIN etf_daily_snapshot s ON s.snapshot_id = h.snapshot_id
        JOIN etf e ON e.etf_id = s.etf_id
        WHERE s.base_date = ?
        ORDER BY h.asset_code, COALESCE(h.weight, 0) DESC
        """,
        (latest_date,),
    ).fetchall()

    by_asset: dict[tuple[str, str], dict] = {}
    for row in rows:
        key = (row["asset_code"], row["asset_name"])
        item = by_asset.setdefault(
            key,
            {
                "asset_code": row["asset_code"],
                "asset_name": row["asset_name"],
                "weights": {base_date: 0 for base_date in dates},
                "avg_weights": {base_date: 0 for base_date in dates},
                "max_weights": {base_date: 0 for base_date in dates},
                "quantities": {base_date: 0 for base_date in dates},
                "valuation_amounts": {base_date: 0 for base_date in dates},
                "etf_counts": {base_date: 0 for base_date in dates},
                "latest_exposures": [],
            },
        )
        item["weights"][row["base_date"]] = row["total_weight"]
        item["avg_weights"][row["base_date"]] = row["avg_weight"]
        item["max_weights"][row["base_date"]] = row["max_weight"]
        item["quantities"][row["base_date"]] = row["total_quantity"]
        item["valuation_amounts"][row["base_date"]] = row["total_valuation_amount"]
        item["etf_counts"][row["base_date"]] = row["etf_count"]

    for row in exposure_rows:
        key = (row["asset_code"], row["asset_name"])
        if key not in by_asset:
            continue
        exposures = by_asset[key]["latest_exposures"]
        if len(exposures) < 5:
            exposures.append({"etf_name": row["etf_name"], "weight": row["weight"]})

    start_date = dates[0]
    end_date = dates[-1]
    change_rows = []
    for item in by_asset.values():
        start_weight = item["weights"].get(start_date) or 0
        end_weight = item["weights"].get(end_date) or 0
        start_avg_weight = item["avg_weights"].get(start_date) or 0
        end_avg_weight = item["avg_weights"].get(end_date) or 0
        start_max_weight = item["max_weights"].get(start_date) or 0
        end_max_weight = item["max_weights"].get(end_date) or 0
        start_quantity = item["quantities"].get(start_date) or 0
        end_quantity = item["quantities"].get(end_date) or 0
        start_valuation_amount = item["valuation_amounts"].get(start_date) or 0
        end_valuation_amount = item["valuation_amounts"].get(end_date) or 0
        item["start_weight"] = start_weight
        item["end_weight"] = end_weight
        item["weight_delta"] = end_weight - start_weight
        item["start_avg_weight"] = start_avg_weight
        item["end_avg_weight"] = end_avg_weight
        item["avg_weight_delta"] = end_avg_weight - start_avg_weight
        item["start_max_weight"] = start_max_weight
        item["end_max_weight"] = end_max_weight
        item["max_weight_delta"] = end_max_weight - start_max_weight
        item["start_quantity"] = start_quantity
        item["end_quantity"] = end_quantity
        item["quantity_delta"] = end_quantity - start_quantity
        item["start_valuation_amount"] = start_valuation_amount
        item["end_valuation_amount"] = end_valuation_amount
        item["valuation_amount_delta"] = end_valuation_amount - start_valuation_amount
        item["latest_etf_count"] = item["etf_counts"].get(end_date) or 0
        change_rows.append(item)

    change_rows.sort(key=lambda item: abs(item["weight_delta"]), reverse=True)
    return {"dates": dates, "rows": change_rows[:limit]}


def etf_change_summary(
    conn: sqlite3.Connection,
    days: int = 3,
    limit: int = 100,
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict:
    date_filter = ""
    params: tuple = (days,)
    if start_date and end_date:
        date_filter = "WHERE base_date BETWEEN ? AND ?"
        params = (start_date, end_date)
    elif start_date:
        date_filter = "WHERE base_date >= ?"
        params = (start_date,)
    elif end_date:
        date_filter = "WHERE base_date <= ?"
        params = (end_date,)

    rows = conn.execute(
        f"""
        WITH ranked_snapshots AS (
            SELECT
                snapshot_id,
                etf_id,
                base_date,
                DENSE_RANK() OVER (
                    PARTITION BY etf_id
                    ORDER BY base_date DESC
                ) AS date_rank
            FROM etf_daily_snapshot
            {date_filter}
        )
        SELECT
            e.ksd_fund,
            e.name AS etf_name,
            h.asset_code,
            h.asset_name,
            rs.base_date,
            h.quantity,
            h.valuation_amount,
            h.weight
        FROM etf_daily_holding h
        JOIN ranked_snapshots rs ON rs.snapshot_id = h.snapshot_id
        JOIN etf e ON e.etf_id = rs.etf_id
        WHERE rs.date_rank <= ?
        ORDER BY e.name, h.asset_name, rs.base_date
        """,
        (*params, days) if date_filter else params,
    ).fetchall()

    dates = sorted({row["base_date"] for row in rows})
    dates_by_etf: dict[tuple[str, str], set[str]] = {}
    by_etf: dict[tuple[str, str], dict[tuple[str, str], dict]] = {}
    for row in rows:
        etf_key = (row["ksd_fund"], row["etf_name"])
        dates_by_etf.setdefault(etf_key, set()).add(row["base_date"])
        asset_key = (row["asset_code"], row["asset_name"])
        item = by_etf.setdefault(etf_key, {}).setdefault(
            asset_key,
            {
                "asset_code": row["asset_code"],
                "asset_name": row["asset_name"],
                "quantities": {},
                "valuation_amounts": {},
                "weights": {},
            },
        )
        item["quantities"][row["base_date"]] = row["quantity"]
        item["valuation_amounts"][row["base_date"]] = row["valuation_amount"]
        item["weights"][row["base_date"]] = row["weight"]

    summaries = []
    if not dates:
        return {"dates": [], "rows": []}

    for (ksd_fund, etf_name), assets in by_etf.items():
        etf_dates = sorted(dates_by_etf.get((ksd_fund, etf_name), set()))
        if not etf_dates:
            continue
        start_date = etf_dates[0]
        end_date = etf_dates[-1]
        summary = {
            "ksd_fund": ksd_fund,
            "etf_name": etf_name,
            "change_score": 0,
            "max_quantity_increase": None,
            "max_quantity_decrease": None,
            "max_valuation_amount": None,
            "max_valuation_increase": None,
            "max_valuation_decrease": None,
            "max_valuation_pct_increase": None,
            "max_valuation_pct_decrease": None,
            "max_weight_increase": None,
            "max_weight_decrease": None,
        }

        for asset in assets.values():
            start_quantity = asset["quantities"].get(start_date)
            end_quantity = asset["quantities"].get(end_date)
            quantity_change_pct = None
            if start_quantity not in (None, 0) and end_quantity is not None:
                quantity_change_pct = ((end_quantity - start_quantity) / abs(start_quantity)) * 100

            start_weight = asset["weights"].get(start_date) or 0
            end_weight = asset["weights"].get(end_date) or 0
            weight_delta = end_weight - start_weight
            start_valuation = asset["valuation_amounts"].get(start_date)
            end_valuation = asset["valuation_amounts"].get(end_date)
            valuation_delta = None
            valuation_change_pct = None
            if start_valuation is not None and end_valuation is not None:
                valuation_delta = end_valuation - start_valuation
                if start_valuation != 0:
                    valuation_change_pct = (valuation_delta / abs(start_valuation)) * 100

            _assign_extreme(
                summary,
                "max_quantity_increase",
                quantity_change_pct,
                asset,
                start_quantity,
                end_quantity,
                larger=True,
            )
            _assign_extreme(
                summary,
                "max_quantity_decrease",
                quantity_change_pct,
                asset,
                start_quantity,
                end_quantity,
                larger=False,
            )
            _assign_extreme(summary, "max_weight_increase", weight_delta, asset, start_weight, end_weight, larger=True)
            _assign_extreme(summary, "max_weight_decrease", weight_delta, asset, start_weight, end_weight, larger=False)
            _assign_extreme(summary, "max_valuation_amount", end_valuation, asset, start_valuation, end_valuation, larger=True)
            _assign_extreme(summary, "max_valuation_increase", valuation_delta, asset, start_valuation, end_valuation, larger=True)
            _assign_extreme(summary, "max_valuation_decrease", valuation_delta, asset, start_valuation, end_valuation, larger=False)
            _assign_extreme(summary, "max_valuation_pct_increase", valuation_change_pct, asset, start_valuation, end_valuation, larger=True)
            _assign_extreme(summary, "max_valuation_pct_decrease", valuation_change_pct, asset, start_valuation, end_valuation, larger=False)

        summaries.append(summary)

    _apply_change_scores(summaries)
    summaries.sort(key=lambda item: item["change_score"], reverse=True)
    return {"dates": dates, "rows": summaries[:limit]}


def _apply_change_scores(summaries: list[dict]) -> None:
    metric_keys = [
        "max_quantity_increase",
        "max_quantity_decrease",
        "max_weight_increase",
        "max_weight_decrease",
    ]
    max_by_metric = {
        key: max((abs((summary[key] or {}).get("value") or 0) for summary in summaries), default=0)
        for key in metric_keys
    }

    for summary in summaries:
        score = 0.0
        active_metrics = 0
        for key in metric_keys:
            metric_max = max_by_metric[key]
            if metric_max == 0:
                continue
            value = abs((summary[key] or {}).get("value") or 0)
            score += value / metric_max
            active_metrics += 1
        summary["change_score"] = round((score / active_metrics) * 100, 2) if active_metrics else 0


def _assign_extreme(
    summary: dict,
    key: str,
    value: float | None,
    asset: dict,
    start_value: float | None,
    end_value: float | None,
    larger: bool,
) -> None:
    if value is None:
        return
    if larger and value <= 0:
        return
    if not larger and value >= 0:
        return
    current = summary[key]
    if current is None or (larger and value > current["value"]) or (not larger and value < current["value"]):
        summary[key] = {
            "asset_code": asset["asset_code"],
            "asset_name": asset["asset_name"],
            "value": value,
            "start_value": start_value,
            "end_value": end_value,
        }
