from fastapi.testclient import TestClient

from app.api import routes
from app.llm.provider import LLMResponse
from app.main import app


def test_chat_uses_mock_provider_without_secret() -> None:
    with TestClient(app) as client:
        response = client.post(
            "/api/chat",
            json={
                "message": "최근 비중 변화가 큰 종목 찾아줘",
                "ksd_fund": "KR70183J0002",
                "view_context": {
                    "mode": "cross",
                    "period": "5영업일",
                    "sections": [
                        {
                            "title": "종목별 변동 상위",
                            "rows": [
                                {
                                    "종목명": "SK하이닉스",
                                    "비중변화": {"raw": 1.2, "label": "+1.20%p"},
                                }
                            ],
                        }
                    ],
                },
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["provider"] == "mock"
    assert payload["message"]
    assert "현재 화면 컨텍스트" in payload["message"]
    assert payload["suggested_view"]["filters"]["ksd_fund"] == "KR70183J0002"


def test_system_prompt_requires_korean_without_mixed_language() -> None:
    assert "한국어를 기본 언어" in routes.SYSTEM_PROMPT
    assert "중국어, 일본어, 러시아어" in routes.SYSTEM_PROMPT
    assert "원문 고유명사" in routes.SYSTEM_PROMPT
    assert "TIGER`는 항상 대문자" in routes.SYSTEM_PROMPT
    assert "제목, 표 헤더, 강조 라벨" in routes.SYSTEM_PROMPT
    assert "最大" in routes.SYSTEM_PROMPT


def test_system_prompt_guides_cash_like_holdings() -> None:
    assert "현금성 항목" in routes.SYSTEM_PROMPT
    assert "수량, 최근 금액, 수량/금액 변화율보다 금액 변화, 비중 변화" in routes.SYSTEM_PROMPT


def test_system_prompt_hides_internal_tool_names() -> None:
    assert "도구명, 함수명, API 경로" in routes.SYSTEM_PROMPT
    assert "get_etf_detail" in routes.SYSTEM_PROMPT
    assert "상세 화면" in routes.SYSTEM_PROMPT


def test_system_prompt_separates_weight_and_quantity_changes() -> None:
    assert "비중 변화와 수량 변화는 서로 다른 개념" in routes.SYSTEM_PROMPT
    assert "수량 변화 필드" in routes.SYSTEM_PROMPT


def test_system_prompt_requires_metric_unit_labels() -> None:
    assert "단위 라벨을 생략하지 않는다" in routes.SYSTEM_PROMPT
    assert "비중 변화는 항상 `%p`" in routes.SYSTEM_PROMPT
    assert "수량 변화율은 항상 `%`" in routes.SYSTEM_PROMPT


def test_system_prompt_requires_krw_for_valuation_amounts() -> None:
    assert "원화(KRW)" in routes.SYSTEM_PROMPT
    assert "달러, USD, 만 달러" in routes.SYSTEM_PROMPT


def test_system_prompt_prevents_over_grouping_different_etf_types() -> None:
    assert "서로 다른 유형을 하나의 범주로 단정하지 않는다" in routes.SYSTEM_PROMPT


def test_system_prompt_prefers_absolute_weight_delta_ranking_for_asset_questions() -> None:
    assert "비중 변화 절대값 기준 단일 랭킹" in routes.SYSTEM_PROMPT


def test_system_prompt_prioritizes_visible_table_for_current_screen_questions() -> None:
    assert "사용자가 \"이 화면\"이라고 말하면" in routes.SYSTEM_PROMPT
    assert "표/목록 데이터에서 눈에 띄는 변화가 우선" in routes.SYSTEM_PROMPT


def test_system_prompt_prevents_unfounded_causal_explanations() -> None:
    assert "ETF 환매, 자금 유입, 리밸런싱, 구조적 요인" in routes.SYSTEM_PROMPT
    assert "원인은 확정할 수 없습니다" in routes.SYSTEM_PROMPT


def test_system_prompt_uses_natural_korean_for_three_item_summaries() -> None:
    assert "눈에 띄는 변화 3가지" in routes.SYSTEM_PROMPT
    assert "상위 3개 변화" in routes.SYSTEM_PROMPT


def test_chat_prompt_includes_thread_history() -> None:
    prompt = routes._chat_user_prompt(
        "그럼 바로전에 내가 뭐라고 말했어?",
        {"mode": "list", "period": "5영업일"},
        [
            {"role": "user", "content": "안녕"},
            {"role": "assistant", "content": "안녕하세요."},
            {"role": "user", "content": "최근 변동 ETF를 요약해줘"},
        ],
    )

    assert "이전 대화:" in prompt
    assert "사용자: 안녕" in prompt
    assert "AI: 안녕하세요." in prompt
    assert "현재 사용자 질문" not in prompt
    assert "사용자 질문:" in prompt
    assert "그럼 바로전에 내가 뭐라고 말했어?" in prompt


def test_general_chat_prompt_includes_thread_history() -> None:
    request = routes.ChatRequest(
        message="내가 방금 뭐라고 했지?",
        history=[{"role": "user", "content": "안녕"}],
    )
    messages = routes._messages_for_general_chat(request)
    joined = "\n".join(message.content for message in messages)

    assert "이전 대화" in joined
    assert "사용자: 안녕" in joined
    assert "현재 사용자 질문" in joined


def test_etf_list_tool_extremes_include_unit_labels() -> None:
    rows = routes._summarize_etf_list_rows(
        [
            {
                "ksd_fund": "KRFUND000001",
                "etf_name": "ETF One",
                "etf_type": "equity",
                "change_score": 10.0,
                "max_quantity_increase": {"asset_code": "AAA", "asset_name": "Asset AAA", "value": 12.2},
                "max_quantity_decrease": None,
                "max_weight_increase": {"asset_code": "BBB", "asset_name": "Asset BBB", "value": 1.8},
                "max_weight_decrease": None,
            }
        ]
    )

    row = rows[0]
    assert "change_score" not in row
    assert row["변동점수"] == 10.0
    assert row["max_quantity_increase"]["metric"] == "quantity_delta_ratio"
    assert row["max_quantity_increase"]["unit"] == "%"
    assert row["max_quantity_increase"]["value_label"] == "+12.20%"
    assert row["max_weight_increase"]["metric"] == "weight_delta"
    assert row["max_weight_increase"]["unit"] == "%p"
    assert row["max_weight_increase"]["value_label"] == "+1.80%p"


def test_etf_detail_tool_includes_quantity_and_valuation_delta_fields() -> None:
    rows = routes._summarize_pivot_rows(
        [
            {
                "asset_code": "AAA",
                "asset_name": "Asset AAA",
                "weight_delta": 1.2,
                "quantity_delta": 3.0,
                "quantity_delta_ratio": 10.0,
                "valuation_amount_delta": 1500.0,
                "valuation_amount_delta_ratio": 12.5,
            }
        ]
    )

    assert rows == [
        {
            "asset_code": "AAA",
            "asset_name": "Asset AAA",
            "weight_delta": 1.2,
            "quantity_delta": 3.0,
            "quantity_delta_ratio": 10.0,
            "valuation_amount_delta_krw": 1500.0,
            "valuation_amount_delta_ratio": 12.5,
        }
    ]


def test_asset_list_tool_uses_display_labels_and_hides_cash_quantity_delta() -> None:
    rows = routes._summarize_asset_list_rows(
        [
            {
                "asset_code": "A000660",
                "asset_name": "SK하이닉스",
                "asset_type": "stock",
                "latest_etf_count": 8,
                "weight_delta": 4.79,
                "quantity_delta": -38,
                "valuation_amount_delta": -47620000,
                "latest_exposures": [],
            },
            {
                "asset_code": "CASH",
                "asset_name": "원화예금",
                "asset_type": "cash",
                "latest_etf_count": 21,
                "weight_delta": 1.92,
                "quantity_delta": 199330000,
                "valuation_amount_delta": 199330000,
                "latest_exposures": [],
            },
            {
                "asset_code": "TRS",
                "asset_name": "CD금리투자KIS TRS 19",
                "asset_type": "fixed_income",
                "latest_etf_count": 1,
                "weight_delta": 1.8,
                "quantity_delta": 2075211,
                "valuation_amount_delta": 2080000,
                "latest_exposures": [],
            },
        ]
    )

    assert rows[0]["유형"] == "주식"
    assert rows[0]["quantity_delta"] == -38
    assert rows[1]["유형"] == "현금성"
    assert rows[1]["quantity_delta"] is None
    assert rows[2]["유형"] == "채권/금리형"
    assert all("asset_type" not in row for row in rows)


def test_chat_tool_call_loop_executes_validated_internal_tool(monkeypatch) -> None:
    calls = []

    class FakeProvider:
        def chat(self, messages, tools=None, tool_choice=None):
            calls.append({"messages": messages, "tools": tools, "tool_choice": tool_choice})
            if len(calls) == 1:
                return LLMResponse(provider="fake", content='{"intent":"current_view","confidence":0.9,"reason":"test"}')
            if len(calls) == 2:
                return LLMResponse(
                    provider="fake",
                    content="",
                    tool_calls=[
                        {
                            "id": "call-test",
                            "type": "function",
                            "function": {
                                "name": "get_etf_detail",
                                "arguments": '{"ksd_fund":"KRFUND000001","days":5}',
                            },
                        }
                    ],
                )
            tool_message = next(message for message in messages if message.role == "tool")
            assert "ETF One" in tool_message.content
            return LLMResponse(provider="fake", content="ETF One 상세 데이터를 확인했습니다.")

    monkeypatch.setattr(routes, "get_provider", lambda: FakeProvider())
    monkeypatch.setattr(
        routes,
        "_execute_get_etf_detail",
        lambda arguments: {
            "ok": True,
            "tool": "get_etf_detail",
            "ksd_fund": arguments["ksd_fund"],
            "etf_name": "ETF One",
            "dates": ["2026-05-19", "2026-05-20"],
            "rows": [],
        },
    )

    with TestClient(app) as client:
        response = client.post("/api/chat", json={"message": "KRFUND000001 자세히 봐줘"})

    assert response.status_code == 200
    assert response.json()["message"] == "ETF One 상세 데이터를 확인했습니다."
    assert len(calls) == 3
    assert calls[0]["tool_choice"] == "none"
    assert calls[1]["tool_choice"] == "auto"
    assert calls[2]["tool_choice"] == "none"


def test_chat_skips_intent_resolution_for_greeting(monkeypatch) -> None:
    calls = []

    class FakeProvider:
        def chat(self, messages, tools=None, tool_choice=None):
            calls.append({"messages": messages, "tools": tools, "tool_choice": tool_choice})
            assert tools is None
            assert all("현재 화면 컨텍스트" not in message.content for message in messages)
            return LLMResponse(provider="fake", content="안녕하세요. ETF 데이터를 함께 살펴볼게요.")

    monkeypatch.setattr(routes, "get_provider", lambda: FakeProvider())

    with TestClient(app) as client:
        response = client.post("/api/chat", json={"message": "안녕"})

    assert response.status_code == 200
    assert response.json()["message"] == "안녕하세요. ETF 데이터를 함께 살펴볼게요."
    assert len(calls) == 1
    assert calls[0]["tool_choice"] == "none"


def test_asset_etf_exposure_question_is_forced_to_asset_detail_without_llm_intent() -> None:
    class ExplodingProvider:
        def chat(self, messages, tools=None, tool_choice=None):
            raise AssertionError("intent resolver should not be called for deterministic asset detail questions")

    request = routes.ChatRequest(
        message="SK하이닉스는 어떤 ETF에서 비중 변화가 컸어?",
        view_context={
            "selected_asset": {"asset_code": "000660", "asset_name": "SK하이닉스"},
        },
    )

    intent = routes._resolve_chat_intent(ExplodingProvider(), request)

    assert intent.intent == "asset_detail"
    assert intent.entity_code == "000660"
    assert intent.entity_name == "SK하이닉스"


def test_named_asset_exposure_question_uses_asset_detail_without_selected_asset(monkeypatch) -> None:
    class ExplodingProvider:
        def chat(self, messages, tools=None, tool_choice=None):
            raise AssertionError("intent resolver should not be called for named asset detail questions")

    monkeypatch.setattr(
        routes,
        "_find_asset_mentioned_in_text",
        lambda text: {"asset_code": "000660", "asset_name": "SK하이닉스"},
    )
    request = routes.ChatRequest(
        message="SK하이닉스는 어떤 ETF에서 비중 변화가 컸어?",
        view_context={
            "mode": "list",
            "selected_fund": "KR70183J0002",
            "selected_fund_name": "TIGER 미국우주테크",
        },
    )

    intent = routes._resolve_chat_intent(ExplodingProvider(), request)

    assert intent.intent == "asset_detail"
    assert intent.entity_code == "000660"
    assert intent.entity_name == "SK하이닉스"


def test_intent_answer_messages_exclude_current_view_context() -> None:
    request = routes.ChatRequest(
        message="SK하이닉스는 어떤 ETF에서 비중 변화가 컸어?",
        view_context={
            "mode": "asset",
            "selected_asset": {"asset_code": "000660", "asset_name": "SK하이닉스"},
            "sections": [{"title": "오염될 화면 컨텍스트", "rows": [{"비중변화": "+4.79%p"}]}],
        },
    )
    messages = routes._messages_for_intent_answer(
        request,
        [
            routes.LLMMessage(
                role="user",
                content='{"tool":"get_asset_detail","rows":[{"etf_name":"TIGER 반도체TOP10레버리지","weight_delta":2.08}]}',
            )
        ],
    )
    joined = "\n".join(message.content for message in messages)

    assert "오염될 화면 컨텍스트" not in joined
    assert "+4.79%p" not in joined
    assert "TIGER 반도체TOP10레버리지" in joined


def test_chat_exposes_four_screen_based_tools_only() -> None:
    tool_names = [tool.name for tool in routes._chat_tools()]

    assert tool_names == [
        "get_etf_list",
        "get_etf_detail",
        "get_asset_list",
        "get_asset_detail",
    ]


def test_chat_tool_dispatches_screen_based_tools(monkeypatch) -> None:
    called = []

    monkeypatch.setattr(routes, "_execute_get_etf_list", lambda arguments: called.append(("etf_list", arguments)) or {"ok": True})
    monkeypatch.setattr(routes, "_execute_get_etf_detail", lambda arguments: called.append(("etf_detail", arguments)) or {"ok": True})
    monkeypatch.setattr(routes, "_execute_get_asset_list", lambda arguments: called.append(("asset_list", arguments)) or {"ok": True})
    monkeypatch.setattr(routes, "_execute_get_asset_exposures", lambda arguments: called.append(("asset_detail", arguments)) or {"ok": True})

    routes._execute_chat_tool("get_etf_list", {"days": 5})
    routes._execute_chat_tool("get_etf_detail", {"ksd_fund": "KRFUND000001"})
    routes._execute_chat_tool("get_asset_list", {"limit": 8})
    routes._execute_chat_tool("get_asset_detail", {"asset_code": "A005930"})

    assert called == [
        ("etf_list", {"days": 5}),
        ("etf_detail", {"ksd_fund": "KRFUND000001"}),
        ("asset_list", {"limit": 8}),
        ("asset_detail", {"asset_code": "A005930"}),
    ]


def test_etf_detail_tool_prefers_exact_selected_etf_name_over_partial_wrong_code() -> None:
    request = routes.ChatRequest(
        message="TIGER 미국나스닥100 구성종목에서 뭐가 크게 바뀌었어?",
        ksd_fund="KR7133690008",
        view_context={
            "selected_fund": "KR7133690008",
            "selected_fund_name": "TIGER 미국나스닥100",
        },
    )

    resolved = routes._resolve_etf_detail_arguments(
        {
            "ksd_fund": "KR7486290000",
            "etf_name": "TIGER 미국나스닥100타겟데일리커버드콜",
            "days": 5,
        },
        request,
    )

    assert resolved["ksd_fund"] == "KR7133690008"
    assert resolved["etf_name"] == "TIGER 미국나스닥100"


def test_chat_forces_exact_etf_detail_before_model_auto_choice(monkeypatch) -> None:
    calls = []

    class FakeProvider:
        def chat(self, messages, tools=None, tool_choice=None):
            calls.append({"messages": messages, "tool_choice": tool_choice})
            assert tool_choice == "none"
            assert any("TIGER 미국나스닥100" in message.content for message in messages)
            assert not any("타겟데일리커버드콜" in message.content for message in messages if message.content.startswith("서버가"))
            return LLMResponse(provider="fake", content="TIGER 미국나스닥100 상세 답변")

    monkeypatch.setattr(routes, "get_provider", lambda: FakeProvider())
    monkeypatch.setattr(
        routes,
        "_find_etf_mentioned_in_text",
        lambda text: {"ksd_fund": "KR7133690008", "name": "TIGER 미국나스닥100"},
    )
    monkeypatch.setattr(
        routes,
        "_execute_get_etf_detail",
        lambda arguments: {
            "ok": True,
            "tool": "get_etf_detail",
            "ksd_fund": arguments["ksd_fund"],
            "etf_name": arguments["etf_name"],
            "rows": [{"asset_name": "Cisco Systems Inc", "weight_delta": 0.39}],
        },
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/chat",
            json={
                "message": "TIGER 미국나스닥100 구성종목에서 뭐가 크게 바뀌었어?",
                "view_context": {
                    "mode": "list",
                    "period": "5영업일",
                    "sections": [
                        {
                            "title": "ETF별 변동 상위",
                            "rows": [
                                {
                                    "ETF": "TIGER 미국나스닥100타겟데일리커버드콜",
                                    "KSD": "KR7486290000",
                                }
                            ],
                        }
                    ],
                },
            },
        )

    assert response.status_code == 200
    assert response.json()["message"] == "TIGER 미국나스닥100 상세 답변"
    assert len(calls) == 2


def test_chat_forces_asset_list_for_asset_ranking_question(monkeypatch) -> None:
    calls = []

    class FakeProvider:
        def chat(self, messages, tools=None, tool_choice=None):
            calls.append({"messages": messages, "tool_choice": tool_choice})
            assert tool_choice == "none"
            joined = "\n".join(message.content for message in messages)
            assert "종목별 변동 랭킹 질문" in joined
            assert "선택된 ETF 상세 데이터로 범위를 좁히지 마세요" in joined
            assert "SK하이닉스" in joined
            return LLMResponse(provider="fake", content="종목별 절대값 랭킹 답변")

    monkeypatch.setattr(routes, "get_provider", lambda: FakeProvider())
    monkeypatch.setattr(
        routes,
        "_execute_get_asset_list",
        lambda arguments: {
            "ok": True,
            "tool": "get_asset_list",
            "rows": [
                {
                    "asset_code": "A000660",
                    "asset_name": "SK하이닉스",
                    "weight_delta": 4.79,
                    "quantity_delta": -0.85,
                }
            ],
        },
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/chat",
            json={
                "message": "최근 5영업일간 비중 변화 큰 종목 찾아줘",
                "ksd_fund": "KR70183J0002",
                "view_context": {
                    "mode": "list",
                    "period": "5영업일",
                    "selected_fund": "KR70183J0002",
                    "selected_fund_name": "TIGER 미국우주테크",
                },
            },
        )

    assert response.status_code == 200
    assert response.json()["message"] == "종목별 절대값 랭킹 답변"
    assert len(calls) == 2


def test_chat_stream_returns_first_response_when_tool_is_not_needed(monkeypatch) -> None:
    calls = []

    class FakeProvider:
        def chat(self, messages, tools=None, tool_choice=None):
            calls.append(("chat", tool_choice))
            return LLMResponse(provider="fake", content="첫 응답")

    monkeypatch.setattr(routes, "get_provider", lambda: FakeProvider())

    with TestClient(app) as client:
        response = client.post("/api/chat/stream", json={"message": "요약해줘"})

    assert response.status_code == 200
    assert response.text == "첫 응답"
    assert calls == [("chat", "none"), ("chat", "auto")]


def test_chat_stream_chunks_first_response_when_tool_is_not_needed(monkeypatch) -> None:
    monkeypatch.setattr(routes.time, "sleep", lambda seconds: None)
    chunks = list(routes._chunk_text("abcdefghijklmnopqrstuvwxyz0123456789", chunk_size=10))

    assert chunks == ["abcdefghij", "klmnopqrst", "uvwxyz0123", "456789"]


def test_chat_stream_streams_final_answer_after_tool_call(monkeypatch) -> None:
    calls = []

    class FakeProvider:
        def chat(self, messages, tools=None, tool_choice=None):
            calls.append(("chat", tool_choice))
            return LLMResponse(
                provider="fake",
                content="",
                tool_calls=[
                    {
                        "id": "call-test",
                        "type": "function",
                        "function": {
                            "name": "get_etf_detail",
                            "arguments": '{"ksd_fund":"KRFUND000001"}',
                        },
                    }
                ],
            )

        def stream_chat(self, messages, tools=None, tool_choice=None):
            calls.append(("stream", tool_choice))
            yield "최종 "
            yield "응답"

    monkeypatch.setattr(routes, "get_provider", lambda: FakeProvider())
    monkeypatch.setattr(routes, "_execute_get_etf_detail", lambda arguments: {"ok": True, "tool": "get_etf_detail", "rows": []})

    with TestClient(app) as client:
        response = client.post("/api/chat/stream", json={"message": "ETF 상세 봐줘"})

    assert response.status_code == 200
    assert response.text == "데이터를 확인하는 중입니다...\n\n최종 응답"
    assert calls == [("chat", "none"), ("chat", "auto"), ("stream", "none")]
