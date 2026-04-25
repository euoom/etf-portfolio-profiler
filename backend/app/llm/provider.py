import subprocess
from abc import ABC, abstractmethod
from dataclasses import dataclass


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


def get_provider() -> LLMProvider:
    return MockProvider()

