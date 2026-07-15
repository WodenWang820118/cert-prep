from __future__ import annotations

import json
import re
from typing import Any

from cert_prep_backend.domains.exam_content import question_item_kind_from_value
from cert_prep_backend.domains.mock_exams.models import DraftSuggestion, SourceChunk
from cert_prep_backend.domains.mock_exams.normalization import normalize_answer
from cert_prep_backend.api.errors import ProviderUnavailableError


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


def json_response(response: Any) -> dict[str, Any]:
    """Read and validate the JSON object returned by Ollama chat responses."""

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


def draft_suggestion_from_item(
    raw_item: Any,
    chunks_by_page: dict[int, SourceChunk],
    chunks_by_id: dict[str, SourceChunk],
) -> DraftSuggestion | None:
    """Validate one reasoning JSON item and map it to a grounded draft suggestion."""

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
    if not excerpt:
        return ""

    source = chunk.raw_or_text()
    if excerpt in source:
        return excerpt
    return _whitespace_aligned_source_excerpt(excerpt, source)


def _whitespace_aligned_source_excerpt(excerpt: str, source: str) -> str:
    excerpt_without_whitespace = "".join(
        character for character in excerpt if not character.isspace()
    )
    if not excerpt_without_whitespace:
        return ""

    source_characters: list[str] = []
    source_indices: list[int] = []
    for index, character in enumerate(source):
        if character.isspace():
            continue
        source_characters.append(character)
        source_indices.append(index)

    start = "".join(source_characters).find(excerpt_without_whitespace)
    if start < 0:
        return ""
    end = start + len(excerpt_without_whitespace) - 1
    return source[source_indices[start] : source_indices[end] + 1]


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
