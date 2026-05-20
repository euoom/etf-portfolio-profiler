import json
import re
import sqlite3
from functools import lru_cache

from app.core.config import ASSET_CLASSIFICATION_OVERRIDES_PATH, ETF_CLASSIFICATION_OVERRIDES_PATH


ASSET_TYPES = {"stock", "listed_product", "fixed_income", "derivative", "cash"}
ETF_TYPES = {"equity", "income", "leveraged_inverse", "fixed_income", "money_market", "other"}


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


def _complete_snapshot_dates(
    conn: sqlite3.Connection,
    *,
    start_date: str | None,
    end_date: str | None,
    days: int,
) -> list[str]:
    if start_date or end_date:
        filter_sql, filter_params = _date_filter_sql("base_date", start_date=start_date, end_date=end_date, days=days)
    else:
        filter_sql, filter_params = "1 = 1", ()
    date_rows = conn.execute(
        f"""
        WITH date_counts AS (
            SELECT base_date, COUNT(DISTINCT etf_id) AS etf_count
            FROM etf_daily_snapshot
            WHERE {filter_sql}
            GROUP BY base_date
        ),
        max_count AS (
            SELECT MAX(etf_count) AS etf_count
            FROM date_counts
        )
        SELECT base_date
        FROM date_counts
        WHERE etf_count = (SELECT etf_count FROM max_count)
        ORDER BY base_date DESC
        """,
        filter_params,
    ).fetchall()
    dates = [row["base_date"] for row in date_rows]
    if not start_date and not end_date:
        dates = dates[:days]
    return sorted(dates)


def list_etfs(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        """
        SELECT etf_id, provider, brand, ksd_fund, ticker, name, asset_class, category,
               net_assets_krw_100m, nav_price, listed_on, updated_at
        FROM etf
        ORDER BY name
        """
    ).fetchall()
    return [
        {
            **dict(row),
            "etf_type": _classify_etf(row["ksd_fund"], row["name"], row["asset_class"], row["category"]),
        }
        for row in rows
    ]


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
    dates = _complete_snapshot_dates(conn, start_date=start_date, end_date=end_date, days=days)
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
            e.ksd_fund,
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
                "asset_type": _classify_asset(row["asset_code"], row["asset_name"]),
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
        if len(exposures) < 3:
            exposures.append({"ksd_fund": row["ksd_fund"], "etf_name": row["etf_name"], "weight": row["weight"]})

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


def _classify_asset(asset_code: str | None, asset_name: str | None) -> str:
    code = (asset_code or "").upper()
    name = asset_name or ""
    upper_name = name.upper()

    override = _asset_type_override(code, name)
    if override:
        return override

    if code.startswith("KRD") or any(token in upper_name for token in ("원화예금", "예금", "현금", "CASH")):
        return "cash"
    if _is_listed_product(code, upper_name):
        return "listed_product"
    if (
        code.startswith("KR4")
        or any(token in upper_name for token in ("FUTURE", "FUTURES", "E-MINI", "선물", "SWAP", "스왑"))
        or re.search(r"\b[CP]\s+\d{6}\b", upper_name)
    ):
        return "derivative"
    if (
        code == "-"
        or code.startswith("KR3")
        or any(token in name for token in ("채권", "통안", "기업어음", "전자단기사채", "(단)"))
        or "제" in name and "차" in name and any(char.isdigit() for char in name)
    ):
        return "fixed_income"
    return "stock"


def _asset_type_override(asset_code: str, asset_name: str) -> str | None:
    overrides = _load_asset_classification_overrides()
    by_asset_code = overrides.get("by_asset_code", {})
    by_asset_name = overrides.get("by_asset_name", {})
    return (
        _parse_asset_type_override(by_asset_code.get(asset_code))
        or _parse_asset_type_override(by_asset_name.get(asset_name))
        or _parse_asset_type_override(by_asset_name.get(asset_name.upper()))
    )


@lru_cache(maxsize=1)
def _load_asset_classification_overrides() -> dict:
    path = ASSET_CLASSIFICATION_OVERRIDES_PATH
    if not path.exists():
        return {"by_asset_code": {}, "by_asset_name": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"by_asset_code": {}, "by_asset_name": {}}
    if not isinstance(data, dict):
        return {"by_asset_code": {}, "by_asset_name": {}}
    return {
        "by_asset_code": _normalize_asset_code_override_map(data.get("by_asset_code")),
        "by_asset_name": _normalize_asset_name_override_map(data.get("by_asset_name")),
    }


def _normalize_asset_code_override_map(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        return {}
    return {str(key).upper(): item for key, item in value.items()}


def _normalize_asset_name_override_map(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        return {}
    normalized = {}
    for key, item in value.items():
        name = str(key)
        normalized[name] = item
        normalized[name.upper()] = item
    return normalized


def _parse_asset_type_override(value: object) -> str | None:
    asset_type = value.get("asset_type") if isinstance(value, dict) else value
    if isinstance(asset_type, str) and asset_type in ASSET_TYPES:
        return asset_type
    return None


def _classify_etf(
    ksd_fund: str | None,
    etf_name: str | None,
    asset_class: str | None,
    category: str | None,
) -> str:
    fund = (ksd_fund or "").upper()
    name = etf_name or ""
    source_asset_class = asset_class or ""
    source_category = category or ""
    text = f"{name} {source_asset_class} {source_category}".upper()

    override = _etf_type_override(fund, name)
    if override:
        return override
    if any(token in text for token in ("커버드콜", "COVERED", "인컴", "배당")):
        return "income"
    if any(token in text for token in ("레버리지", "인버스", "2X", "합성")):
        return "leveraged_inverse"
    if any(token in text for token in ("머니마켓", "MMF", "CD금리", "CD1년", "KOFR", "단기채권", "금리")):
        return "money_market"
    if "채권" in source_asset_class or "채권" in source_category or "채권" in name:
        return "fixed_income"
    if "주식" in source_asset_class:
        return "equity"
    return "other"


def _etf_type_override(ksd_fund: str, etf_name: str) -> str | None:
    overrides = _load_etf_classification_overrides()
    by_ksd_fund = overrides.get("by_ksd_fund", {})
    by_etf_name = overrides.get("by_etf_name", {})
    return (
        _parse_etf_type_override(by_ksd_fund.get(ksd_fund))
        or _parse_etf_type_override(by_etf_name.get(etf_name))
        or _parse_etf_type_override(by_etf_name.get(etf_name.upper()))
    )


@lru_cache(maxsize=1)
def _load_etf_classification_overrides() -> dict:
    path = ETF_CLASSIFICATION_OVERRIDES_PATH
    if not path.exists():
        return {"by_ksd_fund": {}, "by_etf_name": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"by_ksd_fund": {}, "by_etf_name": {}}
    if not isinstance(data, dict):
        return {"by_ksd_fund": {}, "by_etf_name": {}}
    return {
        "by_ksd_fund": _normalize_asset_code_override_map(data.get("by_ksd_fund")),
        "by_etf_name": _normalize_asset_name_override_map(data.get("by_etf_name")),
    }


def _parse_etf_type_override(value: object) -> str | None:
    etf_type = value.get("etf_type") if isinstance(value, dict) else value
    if isinstance(etf_type, str) and etf_type in ETF_TYPES:
        return etf_type
    return None


def _is_listed_product(asset_code: str, upper_asset_name: str) -> bool:
    listed_product_codes = {
        "DIA US EQUITY",
        "IVV US EQUITY",
        "IWM US EQUITY",
        "QQQ US EQUITY",
        "SPY US EQUITY",
        "VOO US EQUITY",
    }
    if asset_code in listed_product_codes:
        return True
    return any(
        token in upper_asset_name
        for token in (
            " ETF",
            " ETF ",
            " ETF TRUST",
            "ISHARES ",
            "SPDR ",
            "VANGUARD ",
            "INVESCO QQQ TRUST",
        )
    )


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
            e.asset_class,
            e.category,
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
    etf_meta: dict[tuple[str, str], dict] = {}
    for row in rows:
        etf_key = (row["ksd_fund"], row["etf_name"])
        etf_meta[etf_key] = {"asset_class": row["asset_class"], "category": row["category"]}
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
        meta = etf_meta.get((ksd_fund, etf_name), {})
        etf_dates = sorted(dates_by_etf.get((ksd_fund, etf_name), set()))
        if not etf_dates:
            continue
        start_date = etf_dates[0]
        end_date = etf_dates[-1]
        summary = {
            "ksd_fund": ksd_fund,
            "etf_name": etf_name,
            "etf_type": _classify_etf(ksd_fund, etf_name, meta.get("asset_class"), meta.get("category")),
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
    metric_weights = {
        "max_quantity_increase": 0.3,
        "max_quantity_decrease": 0.3,
        "max_weight_increase": 0.2,
        "max_weight_decrease": 0.2,
    }
    max_by_metric = {
        key: max((abs((summary[key] or {}).get("value") or 0) for summary in summaries), default=0)
        for key in metric_weights
    }

    for summary in summaries:
        score = 0.0
        active_weight = 0.0
        for key, weight in metric_weights.items():
            metric_max = max_by_metric[key]
            if metric_max == 0:
                continue
            value = abs((summary[key] or {}).get("value") or 0)
            score += (value / metric_max) * weight
            active_weight += weight
        summary["change_score"] = round((score / active_weight) * 100, 2) if active_weight else 0


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


def asset_exposures(
    conn: sqlite3.Connection,
    asset_code: str,
    asset_name: str | None = None,
    days: int = 3,
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict:
    dates = _complete_snapshot_dates(conn, start_date=start_date, end_date=end_date, days=days)
    if not dates:
        return {"dates": [], "rows": []}

    placeholders = ",".join("?" for _ in dates)
    asset_name_filter = "AND h.asset_name = ?" if asset_name is not None else ""
    asset_params = (asset_code, asset_name) if asset_name is not None else (asset_code,)
    raw_holdings = conn.execute(
        f"""
        SELECT
            e.ksd_fund,
            e.name AS etf_name,
            s.base_date,
            COALESCE(h.quantity, 0) AS quantity,
            COALESCE(h.valuation_amount, 0) AS valuation_amount,
            COALESCE(h.weight, 0) AS weight
        FROM etf_daily_holding h
        JOIN etf_daily_snapshot s ON s.snapshot_id = h.snapshot_id
        JOIN etf e ON e.etf_id = s.etf_id
        WHERE h.asset_code = ?
          {asset_name_filter}
          AND s.base_date IN ({placeholders})
        ORDER BY s.base_date ASC
        """,
        (*asset_params, *dates),
    ).fetchall()

    etf_data = {}
    for row in raw_holdings:
        ksd = row["ksd_fund"]
        if ksd not in etf_data:
            etf_data[ksd] = {
                "ksd_fund": ksd,
                "etf_name": row["etf_name"],
                "history": {}
            }
        etf_data[ksd]["history"][row["base_date"]] = {
            "quantity": row["quantity"],
            "valuation_amount": row["valuation_amount"],
            "weight": row["weight"],
        }

    start_date_val = dates[0]
    end_date_val = dates[-1]

    exposures = []
    for ksd, data in etf_data.items():
        history = data["history"]
        
        start_hist = history.get(start_date_val, {"quantity": 0, "valuation_amount": 0, "weight": 0.0})
        end_hist = history.get(end_date_val, {"quantity": 0, "valuation_amount": 0, "weight": 0.0})

        item = {
            "ksd_fund": ksd,
            "etf_name": data["etf_name"],
            "start_quantity": start_hist["quantity"],
            "end_quantity": end_hist["quantity"],
            "quantity_delta": end_hist["quantity"] - start_hist["quantity"],
            "start_valuation_amount": start_hist["valuation_amount"],
            "end_valuation_amount": end_hist["valuation_amount"],
            "valuation_amount_delta": end_hist["valuation_amount"] - start_hist["valuation_amount"],
            "start_weight": start_hist["weight"],
            "end_weight": end_hist["weight"],
            "weight_delta": end_hist["weight"] - start_hist["weight"],
            "history": history,
        }
        exposures.append(item)

    exposures.sort(key=lambda x: x["end_weight"], reverse=True)

    return {"dates": dates, "rows": exposures}
