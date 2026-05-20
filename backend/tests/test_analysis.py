import json

from app.services import analysis
from app.db.database import get_connection, init_db
from app.services.analysis import asset_exposures, cross_etf_weight_changes
from app.services.storage import insert_holdings_snapshot, upsert_products
from app.services.tiger_collector import TigerHolding, TigerHoldingsSnapshot, TigerProduct


def test_cross_etf_changes_skip_partial_latest_date() -> None:
    init_db()
    with get_connection() as conn:
        upsert_products(
            conn,
            [
                TigerProduct("KRFUND000001", "ETF One", "000001", "주식", "테마", None, None, None),
                TigerProduct("KRFUND000002", "ETF Two", "000002", "주식", "테마", None, None, None),
            ],
        )
        for base_date in ("2026-05-14", "2026-05-15"):
            insert_holdings_snapshot(conn, _snapshot("KRFUND000001", base_date, "AAA", 100, 100_000, 10))
            insert_holdings_snapshot(conn, _snapshot("KRFUND000002", base_date, "BBB", 200, 200_000, 20))
        insert_holdings_snapshot(conn, _snapshot("KRFUND000001", "2026-05-18", "AAA", 120, 120_000, 12))

        result = cross_etf_weight_changes(conn, days=2, limit=10)

    assert result["dates"] == ["2026-05-14", "2026-05-15"]
    assert all(row["end_valuation_amount"] > 0 for row in result["rows"])


def test_asset_classification_override_file(monkeypatch, tmp_path) -> None:
    override_path = tmp_path / "asset_classification_overrides.json"
    override_path.write_text(
        json.dumps(
            {
                "by_asset_code": {
                    "ABC US EQUITY": {"asset_type": "listed_product", "note": "test override"},
                },
                "by_asset_name": {
                    "Manual Bond": "fixed_income",
                },
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(analysis, "ASSET_CLASSIFICATION_OVERRIDES_PATH", override_path)
    analysis._load_asset_classification_overrides.cache_clear()

    assert analysis._classify_asset("ABC US EQUITY", "Ordinary Stock Name") == "listed_product"
    assert analysis._classify_asset("MANUAL", "Manual Bond") == "fixed_income"

    analysis._load_asset_classification_overrides.cache_clear()


def test_etf_classification_override_file(monkeypatch, tmp_path) -> None:
    override_path = tmp_path / "etf_classification_overrides.json"
    override_path.write_text(
        json.dumps(
            {
                "by_ksd_fund": {
                    "KRFUND000001": {"etf_type": "income", "note": "test override"},
                },
                "by_etf_name": {
                    "Manual Money Market ETF": "money_market",
                },
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(analysis, "ETF_CLASSIFICATION_OVERRIDES_PATH", override_path)
    analysis._load_etf_classification_overrides.cache_clear()

    assert analysis._classify_etf("KRFUND000001", "Plain ETF", "주식", "테마") == "income"
    assert analysis._classify_etf("KRFUND000002", "Manual Money Market ETF", "주식", "테마") == "money_market"

    analysis._load_etf_classification_overrides.cache_clear()


def test_asset_exposures_can_filter_by_name_when_codes_overlap() -> None:
    init_db()
    with get_connection() as conn:
        upsert_products(
            conn,
            [
                TigerProduct("KRFUND000101", "ETF Shared One", "000101", "주식", "테마", None, None, None),
                TigerProduct("KRFUND000102", "ETF Shared Two", "000102", "주식", "테마", None, None, None),
            ],
        )
        for base_date in ("2026-05-14", "2026-05-15"):
            insert_holdings_snapshot(conn, _snapshot("KRFUND000101", base_date, "-", 100, 100_000, 10, "Shared Bond A"))
            insert_holdings_snapshot(conn, _snapshot("KRFUND000102", base_date, "-", 200, 200_000, 20, "Shared Bond B"))

        result = asset_exposures(conn, asset_code="-", asset_name="Shared Bond A", days=2)

    assert [row["etf_name"] for row in result["rows"]] == ["ETF Shared One"]
    assert result["rows"][0]["end_weight"] == 10


def _snapshot(
    ksd_fund: str,
    base_date: str,
    asset_code: str,
    quantity: float,
    valuation_amount: float,
    weight: float,
    asset_name: str | None = None,
) -> TigerHoldingsSnapshot:
    return TigerHoldingsSnapshot(
        ksd_fund=ksd_fund,
        base_date=base_date,
        holdings=[
            TigerHolding(
                asset_code=asset_code,
                asset_name=asset_name or f"Asset {asset_code}",
                quantity=quantity,
                valuation_amount=valuation_amount,
                weight=weight,
                period_return=None,
            )
        ],
        raw_html=f"{ksd_fund}-{base_date}-{asset_code}",
        content_hash=f"{ksd_fund}-{base_date}-{asset_code}",
    )
