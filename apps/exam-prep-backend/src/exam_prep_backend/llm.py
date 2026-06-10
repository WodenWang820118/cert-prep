from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
import json
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
    answer_key_source: str
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
                    answer_key_source="ai_inferred",
                    rationale=f"The cited source supports applying this concept: {excerpt}",
                    citation_page=chunk.page_number,
                    source_excerpt=excerpt,
                )
            )
        return suggestions


class OllamaProvider:
    provider = "ollama"

    def __init__(self, host: str, model: str, timeout_seconds: float) -> None:
        self.host = host
        self.model = model
        self._client = ollama.Client(host=host, timeout=timeout_seconds)

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
        if not chunks:
            return []

        source = _source_text_for_prompt(chunks)
        response = self._client.chat(
            model=self.model,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You convert OCR text from an uploaded JLPT exam into practice-ready "
                        "mock exam questions. Preserve actual exam questions and choices. "
                        "Ignore cover pages, title pages, notes, version notices, copyright "
                        "notices, and general instructions; do not invent questions from them. "
                        "Only output real multiple-choice exam items with a question stem and "
                        "visible choices. If an explicit answer key is present, use it. If it "
                        "is absent, infer the correct answer and mark answer_key_source as "
                        "ai_inferred."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"Create up to {limit} JLPT mock exam items from this page-delimited "
                        "source text. For every item, set answer to the exact choice text, "
                        "include a concise rationale, keep citation_page from the source page, "
                        "and include a source_excerpt copied exactly from the source text. If "
                        "the source only contains title, note, version, or instruction text, "
                        "return an empty items array for that text.\n\n"
                        f"{source}"
                    ),
                },
            ],
            format=EXAM_ITEMS_SCHEMA,
            options={"temperature": 0, "num_ctx": 8192, "num_predict": 4096},
            think=False,
        )
        payload = _json_response(response)
        raw_items = payload.get("items", [])
        if not isinstance(raw_items, list):
            return []

        chunks_by_page = {chunk.page_number: chunk for chunk in chunks}
        chunks_by_id = {chunk.id: chunk for chunk in chunks}
        suggestions: list[DraftSuggestion] = []
        for raw_item in raw_items:
            suggestion = _draft_suggestion_from_item(raw_item, chunks_by_page, chunks_by_id)
            if suggestion is None:
                continue
            suggestions.append(suggestion)
            if len(suggestions) >= limit:
                break
        return suggestions


def provider_from_settings(settings: Settings) -> LLMProvider:
    if settings.llm_provider == "ollama":
        return OllamaProvider(
            host=settings.ollama_host,
            model=settings.ollama_model,
            timeout_seconds=settings.ollama_timeout_seconds,
        )
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


EXAM_ITEMS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "chunk_id": {"type": "string"},
                    "citation_page": {"type": "integer"},
                    "question": {"type": "string"},
                    "choices": {"type": "array", "items": {"type": "string"}},
                    "answer": {"type": "string"},
                    "answer_key_source": {"type": "string"},
                    "rationale": {"type": "string"},
                    "source_excerpt": {"type": "string"},
                },
                "required": [
                    "citation_page",
                    "question",
                    "choices",
                    "answer",
                    "answer_key_source",
                    "rationale",
                    "source_excerpt",
                ],
            },
        }
    },
    "required": ["items"],
}


def _source_text_for_prompt(chunks: Sequence[SourceChunk]) -> str:
    sections = []
    for chunk in chunks:
        sections.append(f"[[chunk_id:{chunk.id} page:{chunk.page_number}]]\n{chunk.text}")
    return "\n\n".join(sections)


def _json_response(response: Any) -> dict[str, Any]:
    message = getattr(response, "message", None)
    content = None
    if isinstance(message, dict):
        content = message.get("content")
    elif message is not None:
        content = getattr(message, "content", None)
    if content is None and isinstance(response, dict):
        content = response.get("message", {}).get("content")
    if not isinstance(content, str):
        raise ProviderUnavailableError("Ollama returned an unreadable response.")
    try:
        payload = json.loads(content)
    except json.JSONDecodeError as exc:
        raise ProviderUnavailableError("Ollama returned invalid JSON.") from exc
    if not isinstance(payload, dict):
        raise ProviderUnavailableError("Ollama returned a non-object JSON response.")
    return payload


def _draft_suggestion_from_item(
    raw_item: Any,
    chunks_by_page: dict[int, SourceChunk],
    chunks_by_id: dict[str, SourceChunk],
) -> DraftSuggestion | None:
    if not isinstance(raw_item, dict):
        return None

    question = _text(raw_item.get("question"))
    choices = _unique_texts(raw_item.get("choices"))
    answer = _text(raw_item.get("answer"))
    rationale = _text(raw_item.get("rationale"))
    if not question or len(choices) < 2 or not answer:
        return None

    chunk = _chunk_for_item(raw_item, chunks_by_page, chunks_by_id)
    if chunk is None:
        return None

    answer = _normalize_answer(answer, choices)
    if answer not in choices:
        return None

    source_excerpt = _source_excerpt(raw_item.get("source_excerpt"), chunk)
    if not source_excerpt:
        return None
    if not _looks_like_exam_item(question, choices, source_excerpt):
        return None

    answer_key_source = _text(raw_item.get("answer_key_source"))
    if answer_key_source not in {"pdf", "ai_inferred"}:
        answer_key_source = "ai_inferred"

    return DraftSuggestion(
        chunk_id=chunk.id,
        question=question,
        choices=choices,
        answer=answer,
        answer_key_source=answer_key_source,
        rationale=rationale or "Selected from the extracted JLPT source.",
        citation_page=chunk.page_number,
        source_excerpt=source_excerpt,
    )


def _chunk_for_item(
    raw_item: dict[str, Any],
    chunks_by_page: dict[int, SourceChunk],
    chunks_by_id: dict[str, SourceChunk],
) -> SourceChunk | None:
    chunk_id = _text(raw_item.get("chunk_id"))
    if chunk_id in chunks_by_id:
        return chunks_by_id[chunk_id]

    page_number = raw_item.get("citation_page")
    if isinstance(page_number, int) and page_number in chunks_by_page:
        return chunks_by_page[page_number]
    if isinstance(page_number, str) and page_number.isdigit():
        return chunks_by_page.get(int(page_number))
    return next(iter(chunks_by_page.values()), None)


def _source_excerpt(raw_excerpt: Any, chunk: SourceChunk) -> str:
    excerpt = _text(raw_excerpt)
    if excerpt and excerpt in chunk.text:
        return excerpt
    return chunk.source_excerpt or chunk.text[:500]


def _looks_like_exam_item(question: str, choices: list[str], source_excerpt: str) -> bool:
    combined = f"{question} {source_excerpt}".lower()
    rejected_markers = (
        "this test paper has multiple versions",
        "この試験問題には複数のバージョン",
        "試験問題には複数のバージョン",
        "copyright",
        "general instructions",
        "do not open",
    )
    if any(marker in combined for marker in rejected_markers):
        return False

    has_question_marker = any(marker in combined for marker in ("question", "mondai", "jlpt"))
    has_choice_marker = any(_starts_with_choice_marker(choice) for choice in choices)
    return has_question_marker or has_choice_marker or len(choices) >= 2


def _starts_with_choice_marker(text: str) -> bool:
    stripped = text.strip()
    return any(
        stripped.startswith(marker)
        for marker in ("1", "2", "3", "4", "A", "B", "C", "D", "(1)", "(2)", "(3)", "(4)")
    )


def _normalize_answer(answer: str, choices: list[str]) -> str:
    if answer in choices:
        return answer

    normalized = answer.strip().rstrip(".:")
    letter_to_index = {"A": 0, "B": 1, "C": 2, "D": 3, "1": 0, "2": 1, "3": 2, "4": 3}
    index = letter_to_index.get(normalized.upper())
    if index is not None and index < len(choices):
        return choices[index]

    for choice in choices:
        stripped = choice.strip()
        if stripped.startswith(f"{normalized}.") or stripped.startswith(f"{normalized} "):
            return choice
    return answer


def _unique_texts(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    items: list[str] = []
    for item in value:
        text = _text(item)
        if text and text not in items:
            items.append(text)
    return items


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""
