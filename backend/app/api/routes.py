from pydantic import BaseModel
import httpx
from fastapi import APIRouter, HTTPException

from app.db.database import get_connection
from app.llm.provider import get_provider
from app.services.analysis import cross_etf_weight_changes, etf_change_summary, holdings_pivot, list_etfs, weight_changes
from app.services.storage import insert_holdings_snapshot, snapshot_exists, upsert_products
from app.services.tiger_collector import TigerCollector, recent_weekdays


router = APIRouter()


class ChatRequest(BaseModel):
    message: str
    ksd_fund: str | None = None


def _collect_missing_recent_holdings(ksd_fund: str, days: int) -> dict:
    collector = TigerCollector()
    try:
        fix_dates = recent_weekdays(collector.latest_fix_date(ksd_fund), days)
        with get_connection() as conn:
            existing_dates = {
                fix_date
                for fix_date in fix_dates
                if snapshot_exists(conn, ksd_fund, fix_date.replace(".", "-"))
            }

        snapshots = []
        unavailable = []
        for fix_date in fix_dates:
            if fix_date in existing_dates:
                continue

            snapshot = collector.fetch_holdings_snapshot(ksd_fund=ksd_fund, fix_date=fix_date)
            if not snapshot.holdings:
                unavailable.append(fix_date.replace(".", "-"))
                continue

            with get_connection() as conn:
                snapshot_id = insert_holdings_snapshot(conn, snapshot)
            snapshots.append(
                {
                    "snapshot_id": snapshot_id,
                    "base_date": snapshot.base_date,
                    "holdings": len(snapshot.holdings),
                    "content_hash": snapshot.content_hash,
                }
            )
    finally:
        collector.close()

    return {
        "business_dates": [fix_date.replace(".", "-") for fix_date in fix_dates],
        "snapshots": snapshots,
        "skipped": [fix_date.replace(".", "-") for fix_date in fix_dates if fix_date in existing_dates],
        "unavailable": unavailable,
    }


@router.post("/collect/tiger/products")
def collect_tiger_products(list_count: int = 2000) -> dict:
    collector = TigerCollector()
    try:
        products = collector.fetch_products(list_count=list_count)
    finally:
        collector.close()
    with get_connection() as conn:
        count = upsert_products(conn, products)
    return {"collected": count}


@router.post("/collect/tiger/holdings/{ksd_fund}")
def collect_tiger_holdings(ksd_fund: str, fix_date: str | None = None) -> dict:
    collector = TigerCollector()
    try:
        snapshot = collector.fetch_holdings_snapshot(ksd_fund=ksd_fund, fix_date=fix_date)
    finally:
        collector.close()
    try:
        with get_connection() as conn:
            snapshot_id = insert_holdings_snapshot(conn, snapshot)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "snapshot_id": snapshot_id,
        "ksd_fund": snapshot.ksd_fund,
        "base_date": snapshot.base_date,
        "holdings": len(snapshot.holdings),
        "content_hash": snapshot.content_hash,
    }


@router.post("/collect/tiger/holdings/{ksd_fund}/recent")
def collect_recent_tiger_holdings(ksd_fund: str, days: int = 3) -> dict:
    collector = TigerCollector()
    try:
        products = collector.fetch_products()
    finally:
        collector.close()

    with get_connection() as conn:
        upsert_products(conn, products)

    result = _collect_missing_recent_holdings(ksd_fund, days)
    return {
        "ksd_fund": ksd_fund,
        "days": days,
        **result,
    }


@router.post("/collect/tiger/recent-watchlist")
def collect_recent_tiger_watchlist(days: int = 3, limit: int = 5) -> dict:
    collector = TigerCollector()
    try:
        products = collector.fetch_products()
        with get_connection() as conn:
            upsert_products(conn, products)
            funds = conn.execute(
                """
                SELECT ksd_fund, name
                FROM etf
                WHERE brand = 'TIGER'
                ORDER BY COALESCE(net_assets_krw_100m, 0) DESC, name
                LIMIT ?
                """,
                (limit,),
            ).fetchall()

        results = []
        for fund in funds:
            ksd_fund = fund["ksd_fund"]
            fix_dates = recent_weekdays(collector.latest_fix_date(ksd_fund), days)
            fund_result = {"ksd_fund": ksd_fund, "name": fund["name"], "snapshots": [], "skipped": []}
            for fix_date in fix_dates:
                base_date = fix_date.replace(".", "-")
                with get_connection() as conn:
                    if snapshot_exists(conn, ksd_fund, base_date):
                        fund_result["skipped"].append(base_date)
                        continue

                snapshot = collector.fetch_holdings_snapshot(ksd_fund=ksd_fund, fix_date=fix_date)
                if not snapshot.holdings:
                    continue

                with get_connection() as conn:
                    snapshot_id = insert_holdings_snapshot(conn, snapshot)
                fund_result["snapshots"].append(
                    {
                        "snapshot_id": snapshot_id,
                        "base_date": snapshot.base_date,
                        "holdings": len(snapshot.holdings),
                    }
                )
            results.append(fund_result)
    finally:
        collector.close()

    return {"days": days, "limit": limit, "funds": results}


@router.get("/etfs")
def get_etfs() -> list[dict]:
    with get_connection() as conn:
        return list_etfs(conn)


@router.get("/analysis/weight-changes")
def get_weight_changes(ksd_fund: str, days: int = 3) -> list[dict]:
    with get_connection() as conn:
        return weight_changes(conn, ksd_fund=ksd_fund, days=days)


@router.get("/analysis/holdings-pivot")
def get_holdings_pivot(ksd_fund: str, days: int = 3, start_date: str | None = None, end_date: str | None = None) -> dict:
    if start_date is None and end_date is None:
        _collect_missing_recent_holdings(ksd_fund, days)
    with get_connection() as conn:
        return holdings_pivot(conn, ksd_fund=ksd_fund, days=days, start_date=start_date, end_date=end_date)


@router.get("/analysis/cross-etf-weight-changes")
def get_cross_etf_weight_changes(days: int = 3, limit: int = 40, start_date: str | None = None, end_date: str | None = None) -> dict:
    with get_connection() as conn:
        return cross_etf_weight_changes(conn, days=days, limit=limit, start_date=start_date, end_date=end_date)


@router.get("/analysis/etf-change-summary")
def get_etf_change_summary(days: int = 3, limit: int = 100, start_date: str | None = None, end_date: str | None = None) -> dict:
    with get_connection() as conn:
        return etf_change_summary(conn, days=days, limit=limit, start_date=start_date, end_date=end_date)


@router.post("/chat")
def chat(request: ChatRequest) -> dict:
    try:
        provider = get_provider()
        response = provider.chat(request.message)
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=exc.response.text) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "provider": response.provider,
        "message": response.content,
        "suggested_view": {
            "rows": ["asset_name"],
            "columns": ["base_date"],
            "values": ["weight_delta"],
            "filters": {"ksd_fund": request.ksd_fund, "days": 3},
        },
    }
