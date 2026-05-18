from fastapi.testclient import TestClient

import app.api.routes as routes
from app.main import app
from app.services.tiger_collector import TigerProduct


def test_collect_tiger_products_one_item(monkeypatch) -> None:
    class FakeTigerCollector:
        def fetch_products(self, list_count: int = 2000) -> list[TigerProduct]:
            assert list_count == 1
            return [
                TigerProduct(
                    ksd_fund="KR70183J0002",
                    name="TIGER test ETF",
                    ticker="0183J0",
                    asset_class="equity",
                    category="test",
                    net_assets_krw_100m=1.0,
                    nav_price=10000.0,
                    listed_on="2026-01-01",
                )
            ]

        def close(self) -> None:
            return None

    monkeypatch.setattr(routes, "TigerCollector", FakeTigerCollector)

    with TestClient(app) as client:
        response = client.post("/api/collect/tiger/products", params={"list_count": 1})

    assert response.status_code == 200
    assert response.json() == {"collected": 1}
