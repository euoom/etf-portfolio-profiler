from fastapi.testclient import TestClient

from app.main import app


def test_collect_tiger_products_one_item() -> None:
    with TestClient(app) as client:
        response = client.post("/api/collect/tiger/products", params={"list_count": 1})

    assert response.status_code == 200
    assert response.json()["collected"] >= 1
