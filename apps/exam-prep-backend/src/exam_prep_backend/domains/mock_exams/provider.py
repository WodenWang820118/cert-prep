from __future__ import annotations

from collections.abc import Sequence
import json
import re
from typing import Any

import ollama

from exam_prep_backend.config import DEFAULT_OLLAMA_MODEL
from exam_prep_backend.config import Settings
from exam_prep_backend.domains.exam_content import (
    QuestionItemKind,
    clean_exam_text,
    parse_jlpt_question_blocks,
    question_item_kind_from_value,
)
from exam_prep_backend.domains.runtime_installations import resolve_ollama_executable
from exam_prep_backend.domains.mock_exams.models import (
    AnswerKeySource,
    DraftGenerationStrategy,
    DraftStatus,
    DraftSuggestion,
    SourceChunk,
)
from exam_prep_backend.domains.mock_exams.policies import normalize_answer
from exam_prep_backend.domains.mock_exams.ports import ProviderHealth
from exam_prep_backend.domains.mock_exams.ports import ModelPullProgress
from exam_prep_backend.errors import ProviderUnavailableError


class FakeLLMProvider:
    provider = "fake"

    def __init__(self, model: str = DEFAULT_OLLAMA_MODEL) -> None:
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
            excerpt = chunk.excerpt_or_text_prefix()
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
                    answer_key_source=AnswerKeySource.AI_INFERRED,
                    rationale=f"The cited source supports applying this concept: {excerpt}",
                    citation_page=chunk.page_number,
                    source_excerpt=excerpt,
                    confidence=1.0,
                    source_order=(chunk.page_number * 10_000) + (chunk.chunk_index * 1_000) + 1,
                    item_kind=QuestionItemKind.UNKNOWN,
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
        if resolve_ollama_executable() is None:
            return ProviderHealth(
                provider=self.provider,
                model=self.model,
                available=False,
                detail="Ollama is not installed.",
                unavailable_reason="ollama_missing",
            )
        try:
            response = self._client.list()
        except Exception as exc:
            return ProviderHealth(
                provider=self.provider,
                model=self.model,
                available=False,
                detail=f"Ollama unavailable: {exc}",
                unavailable_reason="ollama_not_running",
            )

        model_names = _extract_model_names(response)
        available = self.model in model_names
        detail = "model available" if available else "model not found"
        return ProviderHealth(
            provider=self.provider,
            model=self.model,
            available=available,
            detail=detail,
            unavailable_reason=None if available else "model_missing",
        )

    def generate_drafts(self, chunks: Sequence[SourceChunk], limit: int) -> list[DraftSuggestion]:
        if not chunks:
            return []

        extracted = _extract_jlpt_question_blocks(chunks, limit)
        if len(extracted) >= limit:
            return extracted

        generated = self.generate_reasoning_drafts(chunks, limit - len(extracted))
        return _dedupe_suggestions([*extracted, *generated], limit)

    def generate_reasoning_drafts(
        self, chunks: Sequence[SourceChunk], limit: int
    ) -> list[DraftSuggestion]:
        if not chunks or limit <= 0:
            return []

        source = _source_text_for_prompt(chunks, limit)
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
                        "ai_inferred. Do not include chain-of-thought, hidden reasoning, or "
                        "analysis. Only include a concise user-facing rationale."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"Create up to {limit} JLPT mock exam items from this page-delimited "
                        "source text. For every item, set answer to the exact choice text, "
                        "include a concise user-facing rationale, include confidence as a "
                        "number from 0 to 1, keep citation_page from the source page, and "
                        "include a source_excerpt copied exactly from the source text. If "
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

    def pull_model(self, progress) -> None:
        """Pull the configured Ollama model after explicit user confirmation."""

        for update in self._client.pull(self.model, stream=True):
            progress(_pull_progress(update))


def provider_from_settings(settings: Settings):
    """Create the configured mock exam provider."""

    if settings.llm_provider == "ollama":
        return OllamaProvider(
            host=settings.ollama_host,
            model=settings.ollama_model,
            timeout_seconds=settings.ollama_timeout_seconds,
        )
    return FakeLLMProvider(model=settings.ollama_model)


def generate_drafts_for_strategy(
    provider,
    chunks: Sequence[SourceChunk],
    limit: int,
    strategy: DraftGenerationStrategy,
) -> list[DraftSuggestion]:
    """Generate draft suggestions for the explicit draft endpoint strategy."""

    deterministic = _extract_jlpt_question_blocks(chunks, limit)
    if strategy == DraftGenerationStrategy.DETERMINISTIC_ONLY:
        return deterministic
    if len(deterministic) >= limit:
        return deterministic

    remaining = limit - len(deterministic)
    if isinstance(provider, OllamaProvider):
        generated = provider.generate_reasoning_drafts(chunks, remaining)
    else:
        generated = provider.generate_drafts(chunks, remaining)
    generated = [_as_ai_reasoning_draft(suggestion) for suggestion in generated]
    return _dedupe_suggestions([*deterministic, *generated], limit)


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


def _pull_progress(response: Any) -> ModelPullProgress:
    status = getattr(response, "status", None)
    completed = getattr(response, "completed", None)
    total = getattr(response, "total", None)
    if isinstance(response, dict):
        status = response.get("status", status)
        completed = response.get("completed", completed)
        total = response.get("total", total)
    return ModelPullProgress(
        status=status if isinstance(status, str) else "downloading model",
        completed=completed if isinstance(completed, int) else None,
        total=total if isinstance(total, int) else None,
    )


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
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    "source_order": {"type": "integer"},
                    "source_question_number": {"type": "string"},
                    "item_kind": {"type": "string"},
                    "group_key": {"type": "string"},
                    "group_prompt": {"type": "string"},
                },
                "required": [
                    "citation_page",
                    "question",
                    "choices",
                    "answer",
                    "answer_key_source",
                    "rationale",
                    "source_excerpt",
                    "confidence",
                ],
            },
        }
    },
    "required": ["items"],
}


MAX_PROMPT_SOURCE_CHARS = 3_000
MAX_PROMPT_CHUNKS = 6


def _source_text_for_prompt(chunks: Sequence[SourceChunk], limit: int) -> str:
    sections: list[str] = []
    used_chars = 0
    max_chunks = max(1, min(MAX_PROMPT_CHUNKS, max(1, limit)))
    candidates = [chunk for chunk in chunks if _is_exam_source_chunk(chunk)]
    if not candidates:
        candidates = list(chunks)

    for chunk in candidates:
        if len(sections) >= max_chunks:
            break
        text = chunk.raw_or_text().strip()
        if not text:
            continue
        section = f"[[chunk_id:{chunk.id} page:{chunk.page_number}]]\n{text}"
        remaining = MAX_PROMPT_SOURCE_CHARS - used_chars
        if remaining <= 0:
            break
        if len(section) > remaining:
            if not sections:
                section = section[:remaining]
            else:
                break
        sections.append(section)
        used_chars += len(section)
    return "\n\n".join(sections)


def _is_exam_source_chunk(chunk: SourceChunk) -> bool:
    text = chunk.raw_or_text().lower()
    rejected_markers = (
        "this test paper has multiple versions",
        "the questions are the same, but the fonts and layouts differ",
        "official wechat",
        "\u8907\u6570\u306e\u30d0\u30fc\u30b8\u30e7\u30f3",
    )
    if any(marker in text for marker in rejected_markers):
        return False
    exam_markers = (
        "\u554f\u984c",
        "\u9078\u3073\u306a\u3055\u3044",
        "\u6700\u3082\u3088\u3044",
        "mondai",
        "choose",
    )
    return any(marker in text for marker in exam_markers)


QUESTION_BLOCK_PATTERN = re.compile(
    r"(?<!\u554f\u984c)(?P<number>\d{1,3})\s+"
    r"(?P<stem>.+?[。？?])\s+"
    r"1\s*(?P<c1>.+?)\s+"
    r"2\s*(?P<c2>.+?)\s+"
    r"3\s*(?P<c3>.+?)\s+"
    r"4\s*(?P<c4>.+?)"
    r"(?=\s+\d{1,3}\s+|$)"
)


def _extract_jlpt_question_blocks(
    chunks: Sequence[SourceChunk], limit: int
) -> list[DraftSuggestion]:
    suggestions: list[DraftSuggestion] = []
    for chunk in chunks:
        if len(suggestions) >= limit:
            break
        if not _is_exam_source_chunk(chunk):
            continue
        for block in parse_jlpt_question_blocks(
            text=chunk.raw_or_text(),
            page_number=chunk.page_number,
            chunk_index=chunk.chunk_index,
        ):
            suggestions.append(
                DraftSuggestion(
                    chunk_id=chunk.id,
                    question=block.stem,
                    choices=block.choices,
                    answer="",
                    answer_key_source=AnswerKeySource.MANUAL,
                    rationale="",
                    citation_page=chunk.page_number,
                    source_excerpt=block.source_excerpt,
                    status=DraftStatus.DRAFT,
                    confidence=1.0,
                    source_order=block.source_order,
                    source_question_number=block.source_question_number,
                    item_kind=block.item_kind,
                    group_key=block.group_key,
                    group_prompt=block.group_prompt,
                )
            )
            if len(suggestions) >= limit:
                break
    return suggestions


def _clean_exam_text(text: str) -> str:
    return clean_exam_text(text)


def _question_block_source_text(text: str) -> str:
    return re.sub(r"^.*?\u9078\u3073\u306a\u3055\u3044[。\.]\s+(?=\d{1,3}\s+)", "", text)


def _looks_like_question_group_instruction(stem: str) -> bool:
    return "\u554f\u984c" in stem or "\u9078\u3073\u306a\u3055\u3044" in stem


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
    rationale = _user_facing_rationale(raw_item.get("rationale"))
    confidence = _confidence(raw_item.get("confidence"))
    if not question or len(choices) < 2 or not answer:
        return None
    if confidence is None:
        return None

    chunk = _chunk_for_item(raw_item, chunks_by_page, chunks_by_id)
    if chunk is None:
        return None

    answer = normalize_answer(answer, choices)
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
    source_question_number = _text(raw_item.get("source_question_number")) or None
    item_kind = question_item_kind_from_value(_text(raw_item.get("item_kind")))
    group_key = _text(raw_item.get("group_key")) or None
    group_prompt = _text(raw_item.get("group_prompt")) or None

    return DraftSuggestion(
        chunk_id=chunk.id,
        question=question,
        choices=choices,
        answer=answer,
        answer_key_source=answer_key_source,
        rationale=rationale or "Selected from the extracted JLPT source.",
        citation_page=chunk.page_number,
        source_excerpt=source_excerpt,
        status=DraftStatus.DRAFT,
        confidence=confidence,
        source_order=_optional_int(raw_item.get("source_order")),
        source_question_number=source_question_number,
        item_kind=item_kind,
        group_key=group_key,
        group_prompt=group_prompt,
    )


def _chunk_for_item(
    raw_item: dict[str, Any],
    chunks_by_page: dict[int, SourceChunk],
    chunks_by_id: dict[str, SourceChunk],
) -> SourceChunk | None:
    chunk_id = _text(raw_item.get("chunk_id"))
    page_number = _optional_int(raw_item.get("citation_page"))
    if chunk_id:
        chunk = chunks_by_id.get(chunk_id)
        if chunk is None:
            return None
        if page_number is not None and page_number != chunk.page_number:
            return None
        return chunk
    if page_number is None:
        return None
    return chunks_by_page.get(page_number)


def _source_excerpt(raw_excerpt: Any, chunk: SourceChunk) -> str:
    excerpt = _text(raw_excerpt)
    if excerpt and excerpt in chunk.raw_or_text():
        return excerpt
    return ""


def _looks_like_exam_item(question: str, choices: list[str], source_excerpt: str) -> bool:
    combined = f"{question} {source_excerpt}".lower()
    japanese_version_notice = (
        "\u3053\u306e\u8a66\u9a13\u554f\u984c\u306b\u306f\u8907\u6570"
        "\u306e\u30d0\u30fc\u30b8\u30e7\u30f3"
    )
    japanese_version_notice_without_prefix = (
        "\u8a66\u9a13\u554f\u984c\u306b\u306f\u8907\u6570"
        "\u306e\u30d0\u30fc\u30b8\u30e7\u30f3"
    )
    rejected_markers = (
        "this test paper has multiple versions",
        japanese_version_notice,
        japanese_version_notice_without_prefix,
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


def _optional_int(value: Any) -> int | None:
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def _confidence(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        confidence = float(value)
    elif isinstance(value, str):
        try:
            confidence = float(value)
        except ValueError:
            return None
    else:
        return None
    if 0 <= confidence <= 1:
        return confidence
    return None


def _user_facing_rationale(value: Any) -> str:
    rationale = _text(value)
    if not rationale:
        return ""
    rationale = re.sub(r"(?is)<think>.*?</think>", "", rationale)
    rationale = re.sub(r"(?im)^.*chain[- ]of[- ]thought.*$", "", rationale)
    rationale = re.sub(r"(?im)^.*hidden reasoning.*$", "", rationale)
    return " ".join(rationale.split())


def _as_ai_reasoning_draft(suggestion: DraftSuggestion) -> DraftSuggestion:
    return DraftSuggestion(
        chunk_id=suggestion.chunk_id,
        question=suggestion.question,
        choices=suggestion.choices,
        answer=suggestion.answer,
        answer_key_source=suggestion.answer_key_source,
        rationale=suggestion.rationale,
        citation_page=suggestion.citation_page,
        source_excerpt=suggestion.source_excerpt,
        status=DraftStatus.DRAFT,
        confidence=suggestion.confidence,
        source_order=suggestion.source_order,
        source_question_number=suggestion.source_question_number,
        item_kind=suggestion.item_kind,
        group_key=suggestion.group_key,
        group_prompt=suggestion.group_prompt,
    )


def _dedupe_suggestions(
    suggestions: Sequence[DraftSuggestion], limit: int
) -> list[DraftSuggestion]:
    deduped: list[DraftSuggestion] = []
    seen: set[tuple[str, str, str]] = set()
    for suggestion in suggestions:
        key = (
            suggestion.chunk_id,
            suggestion.source_question_number or "",
            suggestion.question.strip().casefold(),
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(suggestion)
        if len(deduped) >= limit:
            break
    return deduped
