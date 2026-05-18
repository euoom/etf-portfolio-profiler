import json
import subprocess
from abc import ABC, abstractmethod
from dataclasses import dataclass

import httpx

from app.core.config import LLM_PROVIDER, LOCAL_LLM_COMMAND, NVIDIA_API_KEY, NVIDIA_BASE_URL, NVIDIA_MODEL


@dataclass(frozen=True)
class LLMResponse:
    content: str
    provider: str


class LLMProvider(ABC):
    @abstractmethod
    def chat(self, prompt: str) -> LLMResponse:
        raise NotImplementedError


class MockProvider(LLMProvider):
    def chat(self, prompt: str) -> LLMResponse:
        return LLMResponse(
            provider="mock",
            content=(
                "데모 응답입니다. 현재는 로컬 CLI 또는 API provider를 연결하기 전이므로, "
                "요청된 분석 의도를 표/차트 상태로 변환하는 흐름을 검증합니다."
            ),
        )


class LocalCliProvider(LLMProvider):
    def __init__(self, command: list[str]) -> None:
        self.command = command

    def chat(self, prompt: str) -> LLMResponse:
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

    def chat(self, prompt: str) -> LLMResponse:
        response = httpx.post(
            f"{self.base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Accept": "application/json",
            },
            json={
                "model": self.model,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=120,
        )
        response.raise_for_status()
        data = response.json()
        content = data["choices"][0]["message"]["content"]
        if isinstance(content, list):
            content = "\n".join(
                item.get("text", json.dumps(item, ensure_ascii=False))
                for item in content
                if isinstance(item, dict)
            )
        return LLMResponse(provider="nvidia", content=str(content).strip())


def get_provider() -> LLMProvider:
    if LLM_PROVIDER == "nvidia":
        return NvidiaProvider(api_key=NVIDIA_API_KEY, base_url=NVIDIA_BASE_URL, model=NVIDIA_MODEL)
    if LLM_PROVIDER == "local-cli":
        if not LOCAL_LLM_COMMAND:
            raise RuntimeError("LOCAL_LLM_COMMAND is required when LLM_PROVIDER=local-cli")
        return LocalCliProvider(LOCAL_LLM_COMMAND.split())
    return MockProvider()
