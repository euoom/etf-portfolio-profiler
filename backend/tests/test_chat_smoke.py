from fastapi.testclient import TestClient

from app.main import app


def test_chat_uses_mock_provider_without_secret() -> None:
    with TestClient(app) as client:
        response = client.post(
            "/api/chat",
            json={"message": "최근 비중 변화가 큰 종목 찾아줘", "ksd_fund": "KR70183J0002"},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["provider"] == "mock"
    assert payload["message"]
    assert payload["suggested_view"]["filters"]["ksd_fund"] == "KR70183J0002"
