from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol

import ollama

from exam_prep_backend.config import Settings
from exam_prep_backend.errors import ProviderUnavailableError


@dataclass(frozen=True)
class ProviderHealth:
    provider: str
    model: str
    available: bool
    detail: str


@dataclass(frozen=True)
class SourceChunk:
    id: str
    page_number: int
    text: str
    source_excerpt: str


@dataclass(frozen=True)
class DraftSuggestion:
    chunk_id: str
    question: str
    choices: list[str]
    answer: str
    rationale: str
    citation_page: int
    source_excerpt: str


class LLMProvider(Protocol):
    provider: str
    model: str

    def health(self) -> ProviderHealth:
        pass

    def generate_drafts(self, chunks: Sequence[SourceChunk], limit: int) -> list[DraftSuggestion]:
        pass


class FakeLLMProvider:
    provider = "fake"

    def __init__(self, model: str = "gemma4:12b") -> None:
        self.model = model

    def health(self) -> ProviderHealth:
        return ProviderHealth(
            provider=self.provider,
            model=self.model,
            available=True,
            detail="deterministic local fake provider",
        )

    def generate_drafts(self, chunks: Sequence[SourceChunk], limit: int) -> list[DraftSuggestion]:
        suggestions: list[DraftSuggestion] = []
        for chunk in chunks[:limit]:
            excerpt = chunk.source_excerpt or chunk.text[:500]
            suggestions.append(
                DraftSuggestion(
                    chunk_id=chunk.id,
                    question="Which action best applies the cited exam concept?",
                    choices=[
                        "Apply the cited concept",
                        "Ignore the cited source",
                        "Choose an unrelated control",
                        "Remove all safeguards",
                    ],
                    answer="Apply the cited concept",
                    rationale=f"The cited source supports applying this concept: {excerpt}",
                    citation_page=chunk.page_number,
                    source_excerpt=excerpt,
                )
            )
        return suggestions


class OllamaProvider:
    provider = "ollama"

    def __init__(self, host: str, model: str) -> None:
        self.host = host
        self.model = model
        self._client = ollama.Client(host=host)

    def health(self) -> ProviderHealth:
        try:
            response = self._client.list()
        except Exception as exc:
            return ProviderHealth(
                provider=self.provider,
                model=self.model,
                available=False,
                detail=f"Ollama unavailable: {exc}",
            )

        model_names = _extract_model_names(response)
        available = self.model in model_names
        detail = "model available" if available else "model not found"
        return ProviderHealth(
            provider=self.provider,
            model=self.model,
            available=available,
            detail=detail,
        )

    def generate_drafts(self, chunks: Sequence[SourceChunk], limit: int) -> list[DraftSuggestion]:
        raise ProviderUnavailableError("Ollama draft generation is not enabled for local tests.")


def provider_from_settings(settings: Settings) -> LLMProvider:
    if settings.llm_provider == "ollama":
        return OllamaProvider(host=settings.ollama_host, model=settings.ollama_model)
    return FakeLLMProvider(model=settings.ollama_model)


def _extract_model_names(response: Any) -> set[str]:
    models = getattr(response, "models", None)
    if models is None and isinstance(response, dict):
        models = response.get("models", [])
    names: set[str] = set()
    for model in models or []:
        name = getattr(model, "model", None)
        if name is None and isinstance(model, dict):
            name = model.get("model") or model.get("name")
        if isinstance(name, str):
            names.add(name)
    return names
