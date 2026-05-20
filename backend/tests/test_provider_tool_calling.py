from app.llm import provider as provider_module
from app.llm.provider import LLMMessage, LLMTool, NvidiaProvider


def test_nvidia_provider_sends_tools_and_parses_tool_calls(monkeypatch) -> None:
    captured = {}

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": "call-test",
                                    "type": "function",
                                    "function": {
                                        "name": "get_etf_detail",
                                        "arguments": '{"ksd_fund":"KRFUND000001"}',
                                    },
                                }
                            ],
                        },
                        "finish_reason": "tool_calls",
                    }
                ]
            }

    def fake_post(url: str, *, headers: dict, json: dict, timeout: int) -> FakeResponse:
        captured["url"] = url
        captured["headers"] = headers
        captured["json"] = json
        captured["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr(provider_module.httpx, "post", fake_post)

    provider = NvidiaProvider(api_key="test-key", base_url="https://example.test/v1", model="minimaxai/minimax-m2.7")
    response = provider.chat(
        [
            LLMMessage(role="system", content="Use tools when needed."),
            LLMMessage(role="user", content="KRFUND000001 상세를 조회해줘."),
        ],
        tools=[
            LLMTool(
                name="get_etf_detail",
                description="Fetch ETF detail by KSD fund code.",
                parameters={
                    "type": "object",
                    "properties": {"ksd_fund": {"type": "string"}},
                    "required": ["ksd_fund"],
                },
            )
        ],
        tool_choice="auto",
    )

    assert captured["url"] == "https://example.test/v1/chat/completions"
    assert captured["json"]["model"] == "minimaxai/minimax-m2.7"
    assert captured["json"]["tool_choice"] == "auto"
    assert captured["json"]["tools"][0]["function"]["name"] == "get_etf_detail"
    assert response.provider == "nvidia"
    assert response.content == ""
    assert response.tool_calls
    assert response.tool_calls[0]["function"]["name"] == "get_etf_detail"


def test_llm_message_serializes_tool_result_message() -> None:
    message = LLMMessage(
        role="tool",
        content='{"ok": true}',
        tool_call_id="call-test",
        name="get_etf_detail",
    )

    assert message.to_openai_message() == {
        "role": "tool",
        "content": '{"ok": true}',
        "tool_call_id": "call-test",
        "name": "get_etf_detail",
    }


def test_nvidia_provider_streams_delta_content(monkeypatch) -> None:
    captured = {}

    class FakeStreamResponse:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback) -> None:
            return None

        def raise_for_status(self) -> None:
            return None

        def iter_lines(self):
            yield 'data: {"choices":[{"delta":{"content":"안녕"}}]}'
            yield 'data: {"choices":[{"delta":{"content":"하세요"}}]}'
            yield 'data: {"choices":[],"usage":{"completion_tokens":2}}'
            yield 'data: {"choices":[{"finish_reason":"stop"}]}'
            raise AssertionError("stream should stop when finish_reason arrives")

    def fake_stream(method: str, url: str, *, headers: dict, json: dict, timeout: int) -> FakeStreamResponse:
        captured["method"] = method
        captured["url"] = url
        captured["headers"] = headers
        captured["json"] = json
        captured["timeout"] = timeout
        return FakeStreamResponse()

    monkeypatch.setattr(provider_module.httpx, "stream", fake_stream)

    provider = NvidiaProvider(api_key="test-key", base_url="https://example.test/v1", model="minimaxai/minimax-m2.7")
    chunks = list(provider.stream_chat([LLMMessage(role="user", content="인사해줘")], tool_choice="none"))

    assert captured["method"] == "POST"
    assert captured["url"] == "https://example.test/v1/chat/completions"
    assert captured["json"]["stream"] is True
    assert captured["timeout"].read == 20
    assert chunks == ["안녕", "하세요"]


def test_nvidia_provider_handles_done_without_space(monkeypatch) -> None:
    class FakeStreamResponse:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback) -> None:
            return None

        def raise_for_status(self) -> None:
            return None

        def iter_lines(self):
            yield 'data:{"choices":[{"delta":{"content":"끝"}}]}'
            yield "data:[DONE]"
            raise AssertionError("stream should stop when compact DONE arrives")

    monkeypatch.setattr(provider_module.httpx, "stream", lambda *args, **kwargs: FakeStreamResponse())

    provider = NvidiaProvider(api_key="test-key", base_url="https://example.test/v1", model="minimaxai/minimax-m2.7")

    assert list(provider.stream_chat([LLMMessage(role="user", content="인사해줘")])) == ["끝"]
