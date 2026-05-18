from fastapi.testclient import TestClient

import app.api.routes as routes
from app.main import app


def test_unhandled_api_error_returns_json_with_cors(monkeypatch) -> None:
    def raise_unexpected_error(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(routes, "_collect_missing_recent_holdings", raise_unexpected_error)

    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get(
            "/api/analysis/holdings-pivot",
            params={"ksd_fund": "KR70183J0002", "days": 5},
            headers={"Origin": "http://127.0.0.1:5173"},
        )

    assert response.status_code == 500
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:5173"
    assert response.json() == {
        "detail": "Internal server error",
        "path": "/api/analysis/holdings-pivot",
    }
