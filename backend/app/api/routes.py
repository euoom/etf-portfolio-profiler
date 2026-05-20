from typing import Any
import json
import logging
import time

from pydantic import BaseModel
import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from app.db.database import get_connection
from app.llm.provider import LLMMessage, LLMTool, get_provider
from app.services.analysis import asset_exposures, cross_etf_weight_changes, etf_change_summary, holdings_pivot, list_etfs, weight_changes
from app.services.storage import insert_holdings_snapshot, snapshot_exists, upsert_products
from app.services.tiger_collector import TigerCollector, recent_weekdays


router = APIRouter()
logger = logging.getLogger(__name__)


class ChatRequest(BaseModel):
    message: str
    ksd_fund: str | None = None
    view_context: dict[str, Any] | None = None
    history: list[dict[str, str]] | None = None


class ChatIntent(BaseModel):
    intent: str
    confidence: float = 0
    entity_name: str | None = None
    entity_code: str | None = None
    reason: str | None = None


SYSTEM_PROMPT = """
너는 ETF Portfolio Profiler의 AI 데이터 설명자이다.
사용자가 현재 보고 있는 ETF/종목 분석 화면의 데이터 변화와 관찰점을 설명한다.
매수, 매도, 보유 결정을 권고하지 말고 화면 컨텍스트에 포함된 팩트와 수치 변화만 근거로 답한다.
투자 조언을 직접 요구받으면 결정을 대신하지 않는다고 밝히고, 확인할 만한 데이터 관찰점으로 답변을 우회한다.
화면 컨텍스트에 없는 종목 코드, ETF 코드, 수치를 지어내지 않는다.
수량, 평가액, 비중의 방향이 서로 다를 때는 제공된 수치 차이만 설명하고 ETF 환매, 자금 유입, 리밸런싱, 구조적 요인 같은 원인을 단정하지 않는다.
원인을 추정해야 한다면 "가능성이 있습니다"가 아니라 "이 데이터만으로 원인은 확정할 수 없습니다"라고 말한다.
비중 변화와 수량 변화는 서로 다른 개념이다.
비중이 증가하거나 감소해도 수량이 같은 방향으로 변했다고 단정하지 않는다.
수량 변화 필드가 제공되지 않았거나 `null`이면 수량 증가/감소를 언급하지 않는다.
단위 라벨을 생략하지 않는다.
비중 변화는 항상 `%p`로 표기하고, 수량 변화율은 항상 `%`로 표기한다.
비중 변화와 수량 변화율을 모두 단순 `%`로 쓰지 않는다.
금액, 평가액, valuation_amount 관련 필드는 모두 원화(KRW) 기준이다.
금액을 달러, USD, 만 달러로 바꾸거나 환산하지 않는다.
금액을 설명할 때는 원, 만원, 억원 같은 원화 단위만 사용한다.
여러 ETF나 종목을 묶어 요약할 때는 각 행의 ETF 유형/자산 유형을 확인하고, 서로 다른 유형을 하나의 범주로 단정하지 않는다.
사용자가 "이 화면"이라고 말하면 현재 선택 ETF 같은 화면 메타보다 화면의 표/목록 데이터에서 눈에 띄는 변화가 우선이다.
종목별 비중 변화 질문은 증가/감소 표를 따로 나누기보다 비중 변화 절대값 기준 단일 랭킹을 우선 사용한다.
3개를 요약할 때 제목은 "눈에 띄는 변화 3가지"나 "상위 3개 변화"처럼 자연스러운 한국어로 쓴다.
도구명, 함수명, API 경로, 내부 구현명은 사용자에게 노출하지 않는다.
`get_etf_detail`, `get_etf_list`, `get_asset_detail`, `get_asset_list` 같은 이름 대신 "상세 화면", "관련 ETF", "종목 상세"처럼 사용자 언어로 표현한다.
원화예금, 예금, 현금, CASH 같은 현금성 항목은 주식 수량처럼 해석하지 않는다.
현금성 항목은 수량, 최근 금액, 수량/금액 변화율보다 금액 변화, 비중 변화, 현금 포지션 방향 중심으로 설명한다.
한국어를 기본 언어로 사용해 간결하게 답한다.
영문 기업명, ETF명, 티커, 수치 단위 같은 원문 고유명사는 그대로 유지해도 된다.
ETF 브랜드명 `TIGER`는 항상 대문자로 표기한다.
중국어, 일본어, 러시아어 등 한국어가 아닌 설명 문장이나 단어를 섞지 않는다.
제목, 표 헤더, 강조 라벨에도 `最大`, `幅度`, `迹象`, `関連`, ` фон드` 같은 비한국어 조각을 절대 쓰지 않는다.
비한국어 단어가 필요해 보이면 자연스러운 한국어 표현으로 바꿔 쓴다.
""".strip()


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


def _chat_user_prompt(message: str, view_context: dict[str, Any] | None, history: list[dict[str, str]] | None = None) -> str:
    context_markdown = _view_context_to_markdown(view_context)
    history_markdown = _chat_history_to_markdown(history)
    if not context_markdown:
        if not history_markdown:
            return message
        return f"""
이전 대화:
{history_markdown}

현재 사용자 질문:
{message}

답변 지침:
- 이전 대화는 같은 채팅 패널 안에서 이어진 참고 맥락입니다.
- 현재 사용자 질문에 직접 답하되, 필요한 경우 이전 질문과 답변을 짧게 참조하세요.
""".strip()
    return f"""
이전 대화:
{history_markdown or "- 없음"}

사용자 질문:
{message}

현재 화면 컨텍스트:
{context_markdown}

답변 지침:
- 위 컨텍스트에 있는 수치와 항목만 근거로 설명하세요.
- 특정 ETF나 자산의 자세한 정보가 필요하면 제공된 도구를 호출하세요.
- 화면에서 눈에 띄는 변화, 증가/감소 방향, 비교할 만한 후보를 짧게 정리하세요.
- 비중 변화와 수량 변화는 별개이므로, 수량 변화 필드가 있을 때만 수량 증가/감소를 설명하세요.
- 단위 라벨을 생략하지 마세요. 비중 변화는 `%p`, 수량 변화율은 `%`, 금액은 원화 단위로 표기하세요.
- 금액/평가액/valuation_amount 필드는 모두 원화(KRW)입니다. 달러나 USD로 표현하지 말고 원/만원/억원 단위로만 설명하세요.
- 여러 ETF/종목을 묶어 요약할 때 서로 다른 유형을 하나의 유형으로 단정하지 마세요.
- 종목별 비중 변화 질문에서는 증가/감소를 분리하기보다 절대값이 큰 순서의 단일 표를 먼저 제시하세요.
- 이전 대화가 있으면 같은 채팅 패널 안의 참고 맥락으로만 사용하고, 현재 화면 데이터와 충돌하면 현재 화면 데이터와 서버 조회 결과를 우선하세요.
- 도구명, 함수명, API명은 답변에 쓰지 말고 사용자 화면 기준 표현으로 설명하세요.
- 매수/매도/보유 판단을 권고하지 마세요.
""".strip()


def _view_context_to_markdown(view_context: dict[str, Any] | None) -> str:
    if not view_context:
        return ""

    lines = ["## 화면 메타"]
    for key in ("mode", "period", "selected_fund", "selected_fund_name", "selected_asset", "chart_metric"):
        value = view_context.get(key)
        if value not in (None, "", [], {}):
            lines.append(f"- {key}: {_format_context_value(value)}")

    filters = view_context.get("filters")
    if isinstance(filters, dict) and filters:
        lines.append(f"- filters: {_format_context_value(filters)}")

    sections = view_context.get("sections")
    if isinstance(sections, list):
        for section in sections:
            if not isinstance(section, dict):
                continue
            title = str(section.get("title") or "데이터")
            rows = section.get("rows")
            lines.append("")
            lines.append(f"## {title}")
            if isinstance(rows, list) and rows:
                lines.extend(_rows_to_markdown_table(rows))
            else:
                lines.append("- 데이터 없음")

    return "\n".join(lines)


def _chat_history_to_markdown(history: list[dict[str, str]] | None, limit: int = 6, max_chars: int = 700) -> str:
    if not history:
        return ""
    lines = []
    for item in history[-limit:]:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").strip()
        content = _truncate_history_content(str(item.get("content") or "").strip(), max_chars)
        if role not in {"user", "assistant"} or not content:
            continue
        label = "사용자" if role == "user" else "AI"
        lines.append(f"- {label}: {content}")
    return "\n".join(lines)


def _truncate_history_content(content: str, max_chars: int) -> str:
    normalized = " ".join(content.split())
    if len(normalized) <= max_chars:
        return normalized
    return f"{normalized[:max_chars].rstrip()}..."


def _rows_to_markdown_table(rows: list[Any]) -> list[str]:
    dict_rows = [row for row in rows if isinstance(row, dict)]
    if not dict_rows:
        return ["- 데이터 없음"]
    headers = list(dict_rows[0].keys())[:8]
    table = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    for row in dict_rows[:12]:
        table.append("| " + " | ".join(_format_context_value(row.get(header)) for header in headers) + " |")
    return table


def _format_context_value(value: Any) -> str:
    if value is None:
        return "-"
    if isinstance(value, float):
        return f"{value:.4g}"
    if isinstance(value, (str, int, bool)):
        return str(value).replace("|", "/")
    if isinstance(value, dict):
        preferred = value.get("label")
        if preferred is not None:
            return _format_context_value(preferred)
        return ", ".join(f"{key}={_format_context_value(item)}" for key, item in value.items())
    if isinstance(value, list):
        return ", ".join(_format_context_value(item) for item in value[:5])
    return str(value).replace("|", "/")


def _chat_tools() -> list[LLMTool]:
    return [
        LLMTool(
            name="get_etf_list",
            description="ETF별 목록과 변동 랭킹을 조회한다. 최근 변동이 큰 ETF, ETF 유형별 요약, ETF 목록 화면 질문에 사용한다.",
            parameters={
                "type": "object",
                "properties": {
                    "days": {"type": "integer", "description": "조회할 최근 영업일 수", "default": 5},
                    "limit": {"type": "integer", "description": "반환할 ETF 수", "default": 10},
                },
            },
        ),
        LLMTool(
            name="get_etf_detail",
            description="선택한 ETF의 구성종목 상세 변화 데이터를 조회한다. ETF별 목록에서 특정 ETF를 자세히 설명할 때 사용한다.",
            parameters={
                "type": "object",
                "properties": {
                    "ksd_fund": {"type": "string", "description": "ETF KSD fund code. 화면에 선택된 ETF가 있으면 그 코드를 우선 사용한다."},
                    "etf_name": {"type": "string", "description": "사용자가 언급한 ETF 이름. 정확한 이름 후보가 있으면 함께 전달한다."},
                    "days": {"type": "integer", "description": "조회할 최근 영업일 수", "default": 5},
                },
            },
        ),
        LLMTool(
            name="get_asset_list",
            description="종목별/자산별 변동 랭킹을 조회한다. 최근 변동이 큰 종목, 자산군별 요약, 종목 목록 화면 질문에 사용한다.",
            parameters={
                "type": "object",
                "properties": {
                    "days": {"type": "integer", "description": "조회할 최근 영업일 수", "default": 5},
                    "limit": {"type": "integer", "description": "반환할 자산 수", "default": 10},
                },
            },
        ),
        LLMTool(
            name="get_asset_detail",
            description="선택한 자산이 어떤 ETF에 얼마나 편입되어 있는지 상세 노출 데이터를 조회한다.",
            parameters={
                "type": "object",
                "properties": {
                    "asset_code": {"type": "string", "description": "자산 코드"},
                    "asset_name": {"type": "string", "description": "자산명"},
                    "days": {"type": "integer", "description": "조회할 최근 영업일 수", "default": 5},
                },
                "required": ["asset_code"],
            },
        ),
    ]


def _answer_with_tools(provider, messages: list[LLMMessage], request: ChatRequest | None = None) -> Any:
    if request and not _should_resolve_data_intent(request.message):
        return provider.chat(_messages_for_general_chat(request), tools=None, tool_choice="none")

    tools = _chat_tools()
    intent_messages = _intent_data_messages(provider, request)
    if intent_messages:
        return provider.chat(_messages_for_intent_answer(request, intent_messages), tools=tools, tool_choice="none")

    first_response = provider.chat(messages, tools=tools, tool_choice="auto")
    if not first_response.tool_calls:
        return first_response

    tool_messages = _execute_tool_calls(first_response.tool_calls, request)
    final_messages = [
        *messages,
        LLMMessage(role="assistant", content=first_response.content, tool_calls=first_response.tool_calls),
        *tool_messages,
    ]
    return provider.chat(final_messages, tools=tools, tool_choice="none")


def _messages_for_chat(request: ChatRequest) -> list[LLMMessage]:
    return [
        LLMMessage(role="system", content=SYSTEM_PROMPT),
        LLMMessage(role="user", content=_chat_user_prompt(request.message, request.view_context, request.history)),
    ]


def _messages_for_intent_answer(request: ChatRequest, intent_messages: list[LLMMessage]) -> list[LLMMessage]:
    return [
        LLMMessage(role="system", content=SYSTEM_PROMPT),
        LLMMessage(
            role="user",
            content=(
                f"사용자 질문:\n{request.message}\n\n"
                "서버가 질문 의도에 맞는 데이터를 이미 조회했습니다. "
                "아래 조회 결과만 근거로 답변하고, 현재 화면 컨텍스트나 다른 랭킹 데이터를 섞지 마세요."
            ),
        ),
        *intent_messages,
    ]


def _messages_for_general_chat(request: ChatRequest) -> list[LLMMessage]:
    return [
        LLMMessage(
            role="system",
            content=(
                f"{SYSTEM_PROMPT}\n"
                "사용자가 인사나 일반 대화를 하면 현재 화면 데이터 분석을 먼저 시작하지 말고 짧고 자연스럽게 응답한다. "
                "이전 대화가 있으면 같은 채팅 패널 안의 맥락으로 참고하되, 사용자가 분석을 요청할 수 있음을 한 문장으로만 안내한다."
            ),
        ),
        LLMMessage(role="user", content=_chat_user_prompt(request.message, None, request.history)),
    ]


def _stream_answer_with_tools(provider, messages: list[LLMMessage], request: ChatRequest | None = None):
    if request and not _should_resolve_data_intent(request.message):
        yield from provider.stream_chat(_messages_for_general_chat(request), tools=None, tool_choice="none")
        return

    tools = _chat_tools()
    intent_messages = _intent_data_messages(provider, request)
    if intent_messages:
        yield "데이터를 확인하는 중입니다...\n\n"
        yield from provider.stream_chat(_messages_for_intent_answer(request, intent_messages), tools=tools, tool_choice="none")
        return

    first_response = provider.chat(messages, tools=tools, tool_choice="auto")
    if not first_response.tool_calls:
        yield from _chunk_text(first_response.content)
        return

    yield "데이터를 확인하는 중입니다...\n\n"
    tool_messages = _execute_tool_calls(first_response.tool_calls, request)
    final_messages = [
        *messages,
        LLMMessage(role="assistant", content=first_response.content, tool_calls=first_response.tool_calls),
        *tool_messages,
    ]
    yield from provider.stream_chat(final_messages, tools=tools, tool_choice="none")


def _chunk_text(text: str, chunk_size: int = 28):
    for index in range(0, len(text), chunk_size):
        yield text[index : index + chunk_size]
        time.sleep(0.03)


def _intent_data_messages(provider, request: ChatRequest | None) -> list[LLMMessage]:
    if not request:
        return []
    if not _should_resolve_data_intent(request.message):
        _log_chat_debug("skip_intent", request=request, extra={"reason": "no_data_intent"})
        return []
    _log_chat_debug("resolve_start", request=request)
    intent = _resolve_chat_intent(provider, request)
    _log_chat_debug(
        "resolve_done",
        request=request,
        extra={
            "intent": intent.intent,
            "confidence": intent.confidence,
            "entity_name": intent.entity_name,
            "entity_code": intent.entity_code,
            "reason": intent.reason,
        },
    )
    return _data_messages_for_intent(intent, request)


def _resolve_chat_intent(provider, request: ChatRequest) -> ChatIntent:
    fallback = _fallback_chat_intent(request)
    if fallback.intent == "asset_detail":
        return fallback
    try:
        response = provider.chat(_intent_messages(request), tool_choice="none")
        parsed = _parse_intent_json(response.content)
        if parsed:
            return _validate_chat_intent(parsed, request, fallback)
    except Exception:
        return fallback
    return fallback


def _intent_messages(request: ChatRequest) -> list[LLMMessage]:
    view_context = request.view_context if isinstance(request.view_context, dict) else {}
    payload = {
        "question": request.message,
        "screen_mode": view_context.get("mode"),
        "selected_fund": view_context.get("selected_fund"),
        "selected_fund_name": view_context.get("selected_fund_name"),
        "selected_asset": view_context.get("selected_asset"),
        "period": view_context.get("period"),
        "available_intents": ["current_view", "etf_list", "etf_detail", "asset_list", "asset_detail"],
    }
    return [
        LLMMessage(
            role="system",
            content=(
                "너는 ETF Portfolio Profiler의 질문 의도 분류기이다. "
                "답변 본문을 만들지 말고 JSON 객체만 반환한다. "
                "허용 intent: current_view, etf_list, etf_detail, asset_list, asset_detail. "
                "종목/자산의 변동 랭킹 질문은 asset_list, 특정 ETF 구성종목/상세 질문은 etf_detail, "
                "특정 종목이 어떤 ETF에 편입됐는지 묻는 질문은 asset_detail, ETF 랭킹 질문은 etf_list로 분류한다."
            ),
        ),
        LLMMessage(
            role="user",
            content=(
                f"{json.dumps(payload, ensure_ascii=False)}\n\n"
                "반환 형식: {\"intent\":\"asset_list\",\"confidence\":0.0,\"entity_name\":null,\"entity_code\":null,\"reason\":\"...\"}"
            ),
        ),
    ]


def _parse_intent_json(content: str) -> dict[str, Any] | None:
    text = (content or "").strip()
    if not text:
        return None
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:].strip()
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end < start:
        return None
    try:
        parsed = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _validate_chat_intent(parsed: dict[str, Any], request: ChatRequest, fallback: ChatIntent) -> ChatIntent:
    intent = str(parsed.get("intent") or "").strip()
    allowed = {"current_view", "etf_list", "etf_detail", "asset_list", "asset_detail"}
    if intent not in allowed:
        return fallback
    try:
        confidence = float(parsed.get("confidence") or 0)
    except (TypeError, ValueError):
        confidence = 0
    entity_name = str(parsed.get("entity_name") or "").strip() or None
    entity_code = str(parsed.get("entity_code") or "").strip() or None

    if not _should_resolve_data_intent(request.message):
        return ChatIntent(intent="current_view", confidence=1, reason="서버 규칙: 분석 데이터 조회 의도 없음")
    if fallback.intent != "current_view" and confidence < 0.55:
        return fallback
    if intent == "etf_detail" and not (_find_etf_mentioned_in_text(request.message) or entity_name or entity_code or _selected_fund_from_context(request)):
        return fallback
    if intent == "asset_detail" and not (entity_name or entity_code or _selected_asset_from_context(request)):
        return fallback
    return ChatIntent(
        intent=intent,
        confidence=confidence,
        entity_name=entity_name,
        entity_code=entity_code,
        reason=str(parsed.get("reason") or "").strip() or None,
    )


def _fallback_chat_intent(request: ChatRequest) -> ChatIntent:
    if not _should_resolve_data_intent(request.message):
        return ChatIntent(intent="current_view", confidence=1, reason="서버 규칙: 분석 데이터 조회 의도 없음")
    if _looks_like_asset_detail_question(request):
        selected_asset = _selected_asset_from_context(request) or _find_asset_mentioned_in_text(request.message) or {}
        return ChatIntent(
            intent="asset_detail",
            confidence=0.9,
            entity_name=selected_asset.get("asset_name"),
            entity_code=selected_asset.get("asset_code"),
            reason="서버 규칙: 특정 종목의 ETF별 비중 변화 질문",
        )
    if _looks_like_asset_list_question(request.message):
        return ChatIntent(intent="asset_list", confidence=0.75, reason="서버 규칙: 종목별 변동 랭킹 질문")
    if _looks_like_etf_detail_question(request.message) and _find_etf_mentioned_in_text(request.message):
        return ChatIntent(intent="etf_detail", confidence=0.75, reason="서버 규칙: 정확한 ETF명 상세 질문")
    return ChatIntent(intent="current_view", confidence=0.5, reason="서버 규칙: 현재 화면 컨텍스트")


def _data_messages_for_intent(intent: ChatIntent, request: ChatRequest) -> list[LLMMessage]:
    if intent.intent == "asset_list":
        return _asset_list_messages(request, intent)
    if intent.intent == "etf_detail":
        return _etf_detail_messages(request, intent)
    if intent.intent == "etf_list":
        return _etf_list_messages(request, intent)
    if intent.intent == "asset_detail":
        return _asset_detail_messages(request, intent)
    return []


def _should_resolve_data_intent(message: str) -> bool:
    normalized = _normalize_etf_name(message)
    if not normalized:
        return False
    if normalized in {"안녕", "안녕하세요", "하이", "고마워", "감사", "감사합니다", "땡큐", "THANKS", "THANKYOU", "HELLO", "HI"}:
        return False
    analysis_keywords = (
        "ETF",
        "종목",
        "자산",
        "구성",
        "구성종목",
        "비중",
        "수량",
        "금액",
        "변화",
        "변동",
        "증가",
        "감소",
        "상위",
        "랭킹",
        "요약",
        "분석",
        "상세",
        "자세히",
        "편입",
        "화면",
        "차트",
        "데이터",
        "리밸런싱",
        "TIGER",
        "KRFUND",
    )
    return any(keyword in normalized for keyword in analysis_keywords)


def _etf_list_messages(request: ChatRequest, intent: ChatIntent) -> list[LLMMessage]:
    result = _execute_get_etf_list({"days": _period_days_from_context(request.view_context), "limit": 12})
    return [
        _tool_context_message(
            "ETF별 변동 랭킹",
            intent,
            result,
            (
                "ETF별 랭킹을 기준으로 답변하세요. "
                "max_quantity_* 항목은 수량 변화율이며 value_label의 `%` 단위를 그대로 쓰세요. "
                "max_weight_* 항목은 비중 변화이며 value_label의 `%p` 단위를 그대로 쓰세요."
            ),
        )
    ]


def _etf_detail_messages(request: ChatRequest, intent: ChatIntent) -> list[LLMMessage]:
    mentioned_etf = _find_etf_mentioned_in_text(request.message)
    selected_fund = _selected_fund_from_context(request)
    arguments = {
        "ksd_fund": (mentioned_etf or {}).get("ksd_fund") or intent.entity_code or selected_fund,
        "etf_name": (mentioned_etf or {}).get("name") or intent.entity_name,
        "days": _period_days_from_context(request.view_context),
    }
    result = _execute_get_etf_detail(arguments)
    return [
        _tool_context_message(
            "ETF 상세 데이터",
            intent,
            result,
            "아래 JSON의 ETF만 기준으로 답변하고, 현재 화면 목록의 비슷한 이름 ETF를 근거로 섞지 마세요.",
        )
    ]


def _asset_list_messages(request: ChatRequest, intent: ChatIntent) -> list[LLMMessage]:
    result = _execute_get_asset_list({"days": _period_days_from_context(request.view_context), "limit": 12})
    return [
        _tool_context_message(
            "종목별 변동 랭킹",
            intent,
            result,
            "아래 JSON의 종목별 랭킹을 기준으로 답변하고, 현재 선택된 ETF 상세 데이터로 범위를 좁히지 마세요. 비중 변화는 절대값이 큰 순서의 단일 랭킹으로 먼저 제시하세요.",
        )
    ]


def _asset_detail_messages(request: ChatRequest, intent: ChatIntent) -> list[LLMMessage]:
    selected_asset = _selected_asset_from_context(request)
    arguments = {
        "asset_code": intent.entity_code or (selected_asset or {}).get("asset_code"),
        "asset_name": intent.entity_name or (selected_asset or {}).get("asset_name"),
        "days": _period_days_from_context(request.view_context),
    }
    result = _execute_get_asset_exposures(arguments)
    return [
        _tool_context_message(
            "종목 상세 데이터",
            intent,
            result,
            (
                "아래 JSON의 rows 배열만 기준으로 ETF별 비중 변화를 답변하세요. "
                "rows는 이미 weight_delta 절대값이 큰 순서입니다. "
                "종목별 전체 랭킹의 weight_delta, 현재 화면 컨텍스트, 다른 ETF 구성종목 변화 수치를 섞지 마세요. "
                "ETF별 비중 변화는 rows[].weight_delta만 사용하세요."
            ),
        )
    ]


def _tool_context_message(title: str, intent: ChatIntent, result: dict, instruction: str) -> LLMMessage:
    _log_chat_debug(
        "tool_context",
        extra={
            "title": title,
            "intent": intent.intent,
            "tool": result.get("tool"),
            "ok": result.get("ok"),
            "row_count": len(result.get("rows") or []),
            "first_rows": _compact_rows(result.get("rows") or []),
        },
    )
    return LLMMessage(
        role="user",
        content=(
            f"서버가 질문 의도를 `{intent.intent}`로 확정해 {title}를 먼저 조회했습니다.\n"
            f"의도 판단 근거: {intent.reason or '-'}\n"
            f"{instruction}\n"
            f"{json.dumps(result, ensure_ascii=False)}"
        ),
    )


def _log_chat_debug(event: str, request: ChatRequest | None = None, extra: dict[str, Any] | None = None) -> None:
    view_context = request.view_context if request and isinstance(request.view_context, dict) else {}
    payload: dict[str, Any] = {
        "event": event,
    }
    if request:
        payload.update(
            {
                "message": request.message,
                "mode": view_context.get("mode"),
                "selected_fund": view_context.get("selected_fund"),
                "selected_fund_name": view_context.get("selected_fund_name"),
                "selected_asset": view_context.get("selected_asset"),
                "period": view_context.get("period"),
            }
        )
    if extra:
        payload.update(extra)
    logger.warning("[chat-debug] %s", json.dumps(payload, ensure_ascii=False, default=str))


def _compact_rows(rows: list[Any], limit: int = 3) -> list[dict[str, Any]]:
    compacted = []
    for row in rows[:limit]:
        if not isinstance(row, dict):
            continue
        compacted.append(
            {
                key: row.get(key)
                for key in (
                    "etf_name",
                    "asset_name",
                    "weight_delta",
                    "end_weight",
                    "quantity_delta",
                    "valuation_amount_delta_krw",
                    "change_score",
                )
                if key in row
            }
        )
    return compacted


def _selected_fund_from_context(request: ChatRequest) -> str | None:
    view_context = request.view_context if isinstance(request.view_context, dict) else {}
    selected = str(view_context.get("selected_fund") or request.ksd_fund or "").strip()
    return selected or None


def _selected_asset_from_context(request: ChatRequest) -> dict[str, str] | None:
    view_context = request.view_context if isinstance(request.view_context, dict) else {}
    selected = view_context.get("selected_asset")
    if not isinstance(selected, dict):
        return None
    asset_code = str(selected.get("asset_code") or "").strip()
    asset_name = str(selected.get("asset_name") or "").strip()
    if not asset_code:
        return None
    return {"asset_code": asset_code, "asset_name": asset_name}



def _looks_like_etf_detail_question(message: str) -> bool:
    normalized = _normalize_etf_name(message)
    if not normalized:
        return False
    detail_keywords = (
        "구성종목",
        "상세",
        "비중",
        "수량",
        "편입",
        "변화",
        "변동",
        "증가",
        "감소",
        "바뀌",
        "바뀐",
        "바뀌었",
    )
    return any(keyword in normalized for keyword in detail_keywords)


def _looks_like_asset_list_question(message: str) -> bool:
    normalized = _normalize_etf_name(message)
    if not normalized:
        return False
    has_asset_scope = any(keyword in normalized for keyword in ("종목", "자산"))
    has_change_scope = any(keyword in normalized for keyword in ("비중", "변화", "변동", "증가", "감소", "큰", "상위"))
    has_detail_scope = any(keyword in normalized for keyword in ("구성종목", "상세", "편입", "어떤ETF"))
    return has_asset_scope and has_change_scope and not has_detail_scope


def _looks_like_asset_detail_question(request: ChatRequest) -> bool:
    normalized = _normalize_etf_name(request.message)
    if not normalized:
        return False
    selected_asset = _selected_asset_from_context(request)
    mentioned_asset = _find_asset_mentioned_in_text(request.message)
    has_asset_hint = bool(selected_asset or mentioned_asset) or any(keyword in normalized for keyword in ("종목", "자산"))
    asks_etf_exposure = any(keyword in normalized for keyword in ("어떤ETF", "ETF에서", "ETF별", "편입ETF"))
    asks_change = any(keyword in normalized for keyword in ("비중", "변화", "변동", "증가", "감소", "큰"))
    return has_asset_hint and asks_etf_exposure and asks_change


def _period_days_from_context(view_context: dict[str, Any] | None) -> int:
    if not isinstance(view_context, dict):
        return 5
    period = str(view_context.get("period") or "")
    digits = "".join(character for character in period if character.isdigit())
    return _safe_days(digits) if digits else 5


def _execute_tool_calls(tool_calls: list[dict], request: ChatRequest | None = None) -> list[LLMMessage]:
    messages = []
    for tool_call in tool_calls[:3]:
        call_id = str(tool_call.get("id") or "")
        function = tool_call.get("function") if isinstance(tool_call, dict) else None
        name = function.get("name") if isinstance(function, dict) else None
        raw_arguments = function.get("arguments") if isinstance(function, dict) else "{}"
        try:
            arguments = json.loads(raw_arguments or "{}")
        except json.JSONDecodeError:
            arguments = {}
        result = _execute_chat_tool(str(name or ""), arguments, request)
        messages.append(
            LLMMessage(
                role="tool",
                content=json.dumps(result, ensure_ascii=False),
                tool_call_id=call_id,
                name=str(name or "unknown"),
            )
        )
    return messages


def _execute_chat_tool(name: str, arguments: dict[str, Any], request: ChatRequest | None = None) -> dict:
    if name == "get_etf_list":
        return _execute_get_etf_list(arguments)
    if name == "get_etf_detail":
        arguments = _resolve_etf_detail_arguments(arguments, request)
        return _execute_get_etf_detail(arguments)
    if name == "get_asset_list":
        return _execute_get_asset_list(arguments)
    if name in ("get_asset_detail", "get_asset_exposures"):
        return _execute_get_asset_exposures(arguments)
    return {"ok": False, "error": f"지원하지 않는 도구입니다: {name}"}


def _resolve_etf_detail_arguments(arguments: dict[str, Any], request: ChatRequest | None) -> dict[str, Any]:
    resolved = dict(arguments)
    if request:
        mentioned_etf = _find_etf_mentioned_in_text(request.message)
        if mentioned_etf:
            resolved["ksd_fund"] = mentioned_etf["ksd_fund"]
            resolved["etf_name"] = mentioned_etf["name"]
            return resolved

    requested_name = str(resolved.get("etf_name") or "").strip()
    if requested_name:
        exact_etf = _find_etf_by_exact_name(requested_name)
        if exact_etf:
            resolved["ksd_fund"] = exact_etf["ksd_fund"]
            resolved["etf_name"] = exact_etf["name"]
            return resolved

    view_context = request.view_context if request else None
    if not isinstance(view_context, dict):
        return resolved

    selected_fund = str(view_context.get("selected_fund") or request.ksd_fund or "").strip()
    selected_fund_name = str(view_context.get("selected_fund_name") or "").strip()
    if not selected_fund or not selected_fund_name:
        return resolved

    user_message = request.message if request else ""
    if _text_mentions_exact_etf(user_message, selected_fund_name) or requested_name == selected_fund_name:
        resolved["ksd_fund"] = selected_fund
        resolved["etf_name"] = selected_fund_name
    return resolved


def _find_etf_mentioned_in_text(text: str) -> dict[str, str] | None:
    normalized_text = _normalize_etf_name(text)
    if not normalized_text:
        return None
    with get_connection() as conn:
        rows = conn.execute("SELECT ksd_fund, name FROM etf").fetchall()
    matches = [
        {"ksd_fund": row["ksd_fund"], "name": row["name"]}
        for row in rows
        if _normalize_etf_name(row["name"]) in normalized_text
    ]
    if not matches:
        return None
    matches.sort(key=lambda item: len(_normalize_etf_name(item["name"])), reverse=True)
    return matches[0]


def _find_etf_by_exact_name(etf_name: str) -> dict[str, str] | None:
    normalized_name = _normalize_etf_name(etf_name)
    if not normalized_name:
        return None
    with get_connection() as conn:
        rows = conn.execute("SELECT ksd_fund, name FROM etf").fetchall()
    for row in rows:
        if _normalize_etf_name(row["name"]) == normalized_name:
            return {"ksd_fund": row["ksd_fund"], "name": row["name"]}
    return None


def _find_asset_mentioned_in_text(text: str) -> dict[str, str] | None:
    normalized_text = _normalize_etf_name(text)
    if not normalized_text:
        return None
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT asset_code, asset_name
            FROM etf_daily_holding
            GROUP BY asset_code, asset_name
            """
        ).fetchall()
    matches = []
    for row in rows:
        asset_code = str(row["asset_code"] or "").strip()
        asset_name = str(row["asset_name"] or "").strip()
        if not asset_code or not asset_name:
            continue
        normalized_name = _normalize_etf_name(asset_name)
        if normalized_name in normalized_text or _normalize_etf_name(asset_code) in normalized_text:
            matches.append({"asset_code": asset_code, "asset_name": asset_name})
    if not matches:
        return None
    matches.sort(key=lambda item: len(_normalize_etf_name(item["asset_name"])), reverse=True)
    return matches[0]


def _text_mentions_exact_etf(text: str, etf_name: str) -> bool:
    if not text or not etf_name:
        return False
    return _normalize_etf_name(etf_name) in _normalize_etf_name(text)


def _normalize_etf_name(value: str) -> str:
    return "".join(value.split()).upper()


def _execute_get_etf_list(arguments: dict[str, Any]) -> dict:
    days = _safe_days(arguments.get("days"))
    limit = _safe_limit(arguments.get("limit"))
    with get_connection() as conn:
        summary = etf_change_summary(conn, days=days, limit=limit)
    return {
        "ok": True,
        "tool": "get_etf_list",
        "dates": summary["dates"],
        "rows": _summarize_etf_list_rows(summary["rows"]),
    }


def _execute_get_etf_detail(arguments: dict[str, Any]) -> dict:
    ksd_fund = str(arguments.get("ksd_fund") or "").strip()
    days = _safe_days(arguments.get("days"))
    if not ksd_fund:
        return {"ok": False, "error": "ksd_fund가 필요합니다."}
    with get_connection() as conn:
        etf_row = conn.execute("SELECT name FROM etf WHERE ksd_fund = ?", (ksd_fund,)).fetchone()
        if not etf_row:
            return {"ok": False, "error": "존재하지 않는 ETF 코드입니다.", "ksd_fund": ksd_fund}
        detail = holdings_pivot(conn, ksd_fund=ksd_fund, days=days)
    return {
        "ok": True,
        "tool": "get_etf_detail",
        "ksd_fund": ksd_fund,
        "etf_name": etf_row["name"],
        "dates": detail["dates"],
        "rows": _summarize_pivot_rows(detail["rows"]),
    }


def _execute_get_asset_list(arguments: dict[str, Any]) -> dict:
    days = _safe_days(arguments.get("days"))
    limit = _safe_limit(arguments.get("limit"))
    with get_connection() as conn:
        summary = cross_etf_weight_changes(conn, days=days, limit=limit)
    return {
        "ok": True,
        "tool": "get_asset_list",
        "dates": summary["dates"],
        "rows": _summarize_asset_list_rows(summary["rows"]),
    }


def _execute_get_asset_exposures(arguments: dict[str, Any]) -> dict:
    asset_code = str(arguments.get("asset_code") or "").strip()
    asset_name = arguments.get("asset_name")
    asset_name = str(asset_name).strip() if asset_name not in (None, "") else None
    days = _safe_days(arguments.get("days"))
    if not asset_code:
        return {"ok": False, "error": "asset_code가 필요합니다."}
    with get_connection() as conn:
        exists = conn.execute(
            """
            SELECT 1
            FROM etf_daily_holding
            WHERE asset_code = ?
              AND (? IS NULL OR asset_name = ?)
            LIMIT 1
            """,
            (asset_code, asset_name, asset_name),
        ).fetchone()
        if not exists:
            return {"ok": False, "error": "존재하지 않는 자산입니다.", "asset_code": asset_code, "asset_name": asset_name}
        detail = asset_exposures(conn, asset_code=asset_code, asset_name=asset_name, days=days)
    return {
        "ok": True,
        "tool": "get_asset_detail",
        "asset_code": asset_code,
        "asset_name": asset_name,
        "dates": detail["dates"],
        "rows": _summarize_asset_exposure_rows(detail["rows"]),
    }


def _safe_days(value: Any) -> int:
    try:
        days = int(value)
    except (TypeError, ValueError):
        return 5
    return min(20, max(1, days))


def _safe_limit(value: Any) -> int:
    try:
        limit = int(value)
    except (TypeError, ValueError):
        return 10
    return min(30, max(1, limit))


def _summarize_etf_list_rows(rows: list[dict]) -> list[dict]:
    return [
        {
            "ksd_fund": row["ksd_fund"],
            "etf_name": row["etf_name"],
            "etf_type": row.get("etf_type"),
            "변동점수": row["change_score"],
            "max_quantity_increase": _summarize_extreme(row.get("max_quantity_increase"), "quantity_delta_ratio"),
            "max_quantity_decrease": _summarize_extreme(row.get("max_quantity_decrease"), "quantity_delta_ratio"),
            "max_weight_increase": _summarize_extreme(row.get("max_weight_increase"), "weight_delta"),
            "max_weight_decrease": _summarize_extreme(row.get("max_weight_decrease"), "weight_delta"),
        }
        for row in rows[:12]
    ]


def _summarize_extreme(value: dict | None, metric: str) -> dict | None:
    if not value:
        return None
    raw_value = value.get("value")
    unit = "%" if metric == "quantity_delta_ratio" else "%p"
    return {
        "asset_code": value.get("asset_code"),
        "asset_name": value.get("asset_name"),
        "metric": metric,
        "unit": unit,
        "value": raw_value,
        "value_label": _format_signed_value(raw_value, unit),
    }


def _format_signed_value(value: Any, unit: str) -> str | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return f"{number:+.2f}{unit}"


def _summarize_pivot_rows(rows: list[dict]) -> list[dict]:
    return [
        {
            "asset_code": row["asset_code"],
            "asset_name": row["asset_name"],
            "weight_delta": row["weight_delta"],
            "quantity_delta": row.get("quantity_delta"),
            "quantity_delta_ratio": row.get("quantity_delta_ratio"),
            "valuation_amount_delta_krw": row.get("valuation_amount_delta"),
            "valuation_amount_delta_ratio": row.get("valuation_amount_delta_ratio"),
        }
        for row in rows[:12]
    ]


def _summarize_asset_list_rows(rows: list[dict]) -> list[dict]:
    return [
        {
            "asset_code": row["asset_code"],
            "asset_name": row["asset_name"],
            "유형": _asset_type_label(row.get("asset_type")),
            "latest_etf_count": row["latest_etf_count"],
            "weight_delta": row["weight_delta"],
            "quantity_delta": _display_quantity_delta(row.get("asset_type"), row.get("quantity_delta")),
            "valuation_amount_delta_krw": row["valuation_amount_delta"],
            "latest_exposures": row.get("latest_exposures", [])[:3],
        }
        for row in rows[:12]
    ]


def _summarize_asset_exposure_rows(rows: list[dict]) -> list[dict]:
    return [
        {
            "ksd_fund": row["ksd_fund"],
            "etf_name": row["etf_name"],
            "end_weight": row["end_weight"],
            "weight_delta": row["weight_delta"],
            "quantity_delta": row["quantity_delta"],
            "valuation_amount_delta_krw": row["valuation_amount_delta"],
        }
        for row in rows[:12]
    ]


def _asset_type_label(asset_type: Any) -> str:
    labels = {
        "stock": "주식",
        "cash": "현금성",
        "fixed_income": "채권/금리형",
        "listed_product": "상장상품",
        "derivative": "파생상품",
        "other": "기타",
    }
    return labels.get(str(asset_type or "").strip(), "기타")


def _display_quantity_delta(asset_type: Any, quantity_delta: Any) -> Any:
    if str(asset_type or "").strip() == "cash":
        return None
    return quantity_delta


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


@router.get("/analysis/asset-exposures")
def get_asset_exposures(
    asset_code: str,
    asset_name: str | None = None,
    days: int = 3,
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict:
    with get_connection() as conn:
        return asset_exposures(
            conn,
            asset_code=asset_code,
            asset_name=asset_name,
            days=days,
            start_date=start_date,
            end_date=end_date,
        )


@router.post("/chat")
def chat(request: ChatRequest) -> dict:
    try:
        provider = get_provider()
        response = _answer_with_tools(provider, _messages_for_chat(request), request)
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


@router.post("/chat/stream")
def chat_stream(request: ChatRequest) -> StreamingResponse:
    try:
        provider = get_provider()
        messages = _messages_for_chat(request)
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    def generate():
        try:
            yield from _stream_answer_with_tools(provider, messages, request)
        except httpx.HTTPStatusError as exc:
            yield f"\n\n응답을 가져오지 못했습니다. {exc.response.text}"
        except httpx.HTTPError as exc:
            yield f"\n\n응답을 가져오지 못했습니다. {exc}"
        except Exception as exc:
            yield f"\n\n응답 스트림이 중단되었습니다. 잠시 후 다시 시도해 주세요. ({exc})"

    return StreamingResponse(generate(), media_type="text/plain; charset=utf-8")
