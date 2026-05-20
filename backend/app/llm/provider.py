import json
import subprocess
from abc import ABC, abstractmethod
from collections.abc import Iterator
from dataclasses import dataclass

import httpx

from app.core.config import LLM_PROVIDER, LOCAL_LLM_COMMAND, NVIDIA_API_KEY, NVIDIA_BASE_URL, NVIDIA_MODEL


@dataclass(frozen=True)
class LLMResponse:
    content: str
    provider: str
    tool_calls: list[dict] | None = None


@dataclass(frozen=True)
class LLMMessage:
    role: str
    content: str
    tool_calls: list[dict] | None = None
    tool_call_id: str | None = None
    name: str | None = None

    def to_openai_message(self) -> dict:
        message: dict = {"role": self.role, "content": self.content}
        if self.tool_calls is not None:
            message["tool_calls"] = self.tool_calls
        if self.tool_call_id is not None:
            message["tool_call_id"] = self.tool_call_id
        if self.name is not None:
            message["name"] = self.name
        return message


@dataclass(frozen=True)
class LLMTool:
    name: str
    description: str
    parameters: dict

    def to_openai_tool(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


class LLMProvider(ABC):
    @abstractmethod
    def chat(self, messages: list[LLMMessage], tools: list[LLMTool] | None = None, tool_choice: str | dict | None = None) -> LLMResponse:
        raise NotImplementedError

    def stream_chat(
        self,
        messages: list[LLMMessage],
        tools: list[LLMTool] | None = None,
        tool_choice: str | dict | None = None,
    ) -> Iterator[str]:
        response = self.chat(messages, tools=tools, tool_choice=tool_choice)
        if response.content:
            yield response.content


class MockProvider(LLMProvider):
    def chat(self, messages: list[LLMMessage], tools: list[LLMTool] | None = None, tool_choice: str | dict | None = None) -> LLMResponse:
        has_context = any("현재 화면 컨텍스트" in message.content for message in messages)
        return LLMResponse(
            provider="mock",
            content=(
                "데모 응답입니다. "
                + ("현재 화면 컨텍스트를 함께 받아 " if has_context else "")
                + "요청된 분석 의도를 표/차트 상태로 변환하는 흐름을 검증합니다."
            ),
        )


class LocalCliProvider(LLMProvider):
    def __init__(self, command: list[str]) -> None:
        self.command = command

    def chat(self, messages: list[LLMMessage], tools: list[LLMTool] | None = None, tool_choice: str | dict | None = None) -> LLMResponse:
        prompt = "\n\n".join(f"[{message.role}]\n{message.content}" for message in messages)
        completed = subprocess.run(
            self.command + [prompt],
            check=True,
            capture_output=True,
            text=True,
            timeout=120,
        )
        return LLMResponse(provider="local-cli", content=completed.stdout.strip())


class NvidiaProvider(LLMProvider):
    def __init__(self, api_key: str, base_url: str, model: str) -> None:
        if not api_key:
            raise RuntimeError("NVIDIA_API_KEY is required when LLM_PROVIDER=nvidia")
        if not model:
            raise RuntimeError("NVIDIA_MODEL is required when LLM_PROVIDER=nvidia")
        self.api_key = api_key
        self.base_url = base_url
        self.model = model

    def chat(self, messages: list[LLMMessage], tools: list[LLMTool] | None = None, tool_choice: str | dict | None = None) -> LLMResponse:
        payload = {
            "model": self.model,
            "messages": [message.to_openai_message() for message in messages],
        }
        if tools:
            payload["tools"] = [tool.to_openai_tool() for tool in tools]
            payload["tool_choice"] = tool_choice or "auto"

        response = httpx.post(
            f"{self.base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Accept": "application/json",
            },
            json=payload,
            timeout=120,
        )
        response.raise_for_status()
        data = response.json()
        message = data["choices"][0]["message"]
        content = message.get("content") or ""
        if isinstance(content, list):
            content = "\n".join(
                item.get("text", json.dumps(item, ensure_ascii=False))
                for item in content
                if isinstance(item, dict)
            )
        return LLMResponse(provider="nvidia", content=str(content).strip(), tool_calls=message.get("tool_calls"))

    def stream_chat(
        self,
        messages: list[LLMMessage],
        tools: list[LLMTool] | None = None,
        tool_choice: str | dict | None = None,
    ) -> Iterator[str]:
        payload = {
            "model": self.model,
            "messages": [message.to_openai_message() for message in messages],
            "stream": True,
        }
        if tools:
            payload["tools"] = [tool.to_openai_tool() for tool in tools]
            payload["tool_choice"] = tool_choice or "auto"

        timeout = httpx.Timeout(connect=10, read=20, write=10, pool=10)
        with httpx.stream(
            "POST",
            f"{self.base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Accept": "text/event-stream",
            },
            json=payload,
            timeout=timeout,
        ) as response:
            response.raise_for_status()
            for line in response.iter_lines():
                if not line:
                    continue
                if line.startswith("data:"):
                    line = line.removeprefix("data:").strip()
                if line == "[DONE]":
                    break
                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    continue
                choices = data.get("choices")
                if not isinstance(choices, list) or not choices:
                    continue
                first_choice = choices[0]
                if not isinstance(first_choice, dict):
                    continue
                if first_choice.get("finish_reason"):
                    break
                delta = first_choice.get("delta") or {}
                if not isinstance(delta, dict):
                    continue
                content = delta.get("content")
                if isinstance(content, str):
                    yield content
                elif isinstance(content, list):
                    for item in content:
                        if isinstance(item, dict) and isinstance(item.get("text"), str):
                            yield item["text"]


def get_provider() -> LLMProvider:
    if LLM_PROVIDER == "nvidia":
        return NvidiaProvider(api_key=NVIDIA_API_KEY, base_url=NVIDIA_BASE_URL, model=NVIDIA_MODEL)
    if LLM_PROVIDER == "local-cli":
        if not LOCAL_LLM_COMMAND:
            raise RuntimeError("LOCAL_LLM_COMMAND is required when LLM_PROVIDER=local-cli")
        return LocalCliProvider(LOCAL_LLM_COMMAND.split())
    return MockProvider()
