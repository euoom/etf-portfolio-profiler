from pydantic import BaseModel
from fastapi import APIRouter, HTTPException

from app.db.database import get_connection
from app.llm.provider import get_provider
from app.services.analysis import holdings_pivot, list_etfs, weight_changes
from app.services.storage import insert_holdings_snapshot, upsert_products
from app.services.tiger_collector import TigerCollector


router = APIRouter()


class ChatRequest(BaseModel):
    message: str
    ksd_fund: str | None = None


@router.post("/collect/tiger/products")
def collect_tiger_products() -> dict:
    collector = TigerCollector()
    try:
        products = collector.fetch_products()
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
        snapshots = collector.fetch_recent_holdings_snapshots(ksd_fund=ksd_fund, days=days)
    finally:
        collector.close()

    with get_connection() as conn:
        upsert_products(conn, products)
        results = []
        for snapshot in snapshots:
            snapshot_id = insert_holdings_snapshot(conn, snapshot)
            results.append(
                {
                    "snapshot_id": snapshot_id,
                    "base_date": snapshot.base_date,
                    "holdings": len(snapshot.holdings),
                    "content_hash": snapshot.content_hash,
                }
            )

    return {"ksd_fund": ksd_fund, "days": days, "snapshots": results}


@router.get("/etfs")
def get_etfs() -> list[dict]:
    with get_connection() as conn:
        return list_etfs(conn)


@router.get("/analysis/weight-changes")
def get_weight_changes(ksd_fund: str, days: int = 3) -> list[dict]:
    with get_connection() as conn:
        return weight_changes(conn, ksd_fund=ksd_fund, days=days)


@router.get("/analysis/holdings-pivot")
def get_holdings_pivot(ksd_fund: str, days: int = 3) -> dict:
    with get_connection() as conn:
        return holdings_pivot(conn, ksd_fund=ksd_fund, days=days)


@router.post("/chat")
def chat(request: ChatRequest) -> dict:
    provider = get_provider()
    response = provider.chat(request.message)
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
