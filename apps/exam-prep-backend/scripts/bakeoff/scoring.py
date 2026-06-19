from __future__ import annotations

from collections import Counter
from collections.abc import Sequence
import json
import re

from exam_prep_backend.domains.exam_content import QuestionItemKind
from exam_prep_backend.domains.mock_exams.models import (
    AnswerKeySource,
    DraftSuggestion,
    SourceChunk,
)
from exam_prep_backend.domains.mock_exams.provider import _draft_suggestion_from_item

from bakeoff.config import DEFAULT_LIMIT
from bakeoff.data import GroupExpectation, group_expectation


def score_model_content(
    *,
    model: str,
    content: object,
    chunks: Sequence[SourceChunk],
    latency_ms: int | None,
    limit: int = DEFAULT_LIMIT,
) -> dict[str, object]:
    """Score one raw model response for JSON validity, citations, and grouping."""
    decoded = decode_model_payload(content)
    expectation = group_expectation(chunks)
    base: dict[str, object] = {
        "model": model,
        "provider": "ollama",
        "latency_ms": latency_ms,
        "json_valid": decoded["json_valid"],
        "json_recovered": decoded["json_recovered"],
    }
    payload = decoded["payload"]
    if not isinstance(payload, dict):
        return base | {
            "status": "invalid_json",
            "json_error": decoded["json_error"],
            "citation_validity": citation_validity([], 0),
            "group_detection": group_detection([], expectation),
            "manual_review_burden": manual_review_burden([], 0, expectation),
            "accepted_items": [],
        }

    raw_items = payload.get("items")
    if not isinstance(raw_items, list):
        return base | {
            "status": "invalid_items",
            "json_error": None,
            "citation_validity": citation_validity([], 1),
            "group_detection": group_detection([], expectation),
            "manual_review_burden": manual_review_burden([], 1, expectation),
            "accepted_items": [],
        }

    chunks_by_page = {chunk.page_number: chunk for chunk in chunks}
    chunks_by_id = {chunk.id: chunk for chunk in chunks}
    accepted: list[DraftSuggestion] = []
    for raw_item in raw_items:
        suggestion = _draft_suggestion_from_item(raw_item, chunks_by_page, chunks_by_id)
        if suggestion is None:
            continue
        accepted.append(suggestion)
        if len(accepted) >= limit:
            break

    rejected_count = max(0, len(raw_items) - len(accepted))
    return base | {
        "status": "scored",
        "json_error": None,
        "citation_validity": citation_validity(accepted, len(raw_items)),
        "group_detection": group_detection(accepted, expectation),
        "manual_review_burden": manual_review_burden(
            accepted,
            rejected_count,
            expectation,
        ),
        "accepted_items": [sanitized_item(item) for item in accepted],
    }


def decode_model_payload(content: object) -> dict[str, object]:
    """Decode strict JSON, allowing recovery from responses wrapped in think tags."""
    if not isinstance(content, str):
        return {
            "payload": None,
            "json_valid": False,
            "json_recovered": False,
            "json_error": "response content was not a string",
        }

    try:
        payload = json.loads(content)
        return {
            "payload": payload if isinstance(payload, dict) else None,
            "json_valid": isinstance(payload, dict),
            "json_recovered": False,
            "json_error": None if isinstance(payload, dict) else "JSON payload was not an object",
        }
    except json.JSONDecodeError as exc:
        strict_error = exc.msg

    recovered_content = extract_json_object_without_thought(content)
    if recovered_content is not None:
        try:
            payload = json.loads(recovered_content)
            return {
                "payload": payload if isinstance(payload, dict) else None,
                "json_valid": False,
                "json_recovered": isinstance(payload, dict),
                "json_error": None
                if isinstance(payload, dict)
                else "Recovered JSON payload was not an object",
            }
        except json.JSONDecodeError as exc:
            strict_error = exc.msg

    return {
        "payload": None,
        "json_valid": False,
        "json_recovered": False,
        "json_error": strict_error,
    }


def extract_json_object_without_thought(content: str) -> str | None:
    without_think = re.sub(r"(?is)<think>.*?</think>", "", content)
    start = without_think.find("{")
    end = without_think.rfind("}")
    if start < 0 or end <= start:
        return None
    return without_think[start : end + 1]


def citation_validity(
    accepted: Sequence[DraftSuggestion],
    total_items: int,
) -> dict[str, object]:
    invalid = max(0, total_items - len(accepted))
    denominator = total_items or 1
    return {
        "total_items": total_items,
        "valid_items": len(accepted),
        "invalid_items": invalid,
        "valid_ratio": round(len(accepted) / denominator, 4),
    }


def group_detection(
    accepted: Sequence[DraftSuggestion],
    expectation: GroupExpectation,
) -> dict[str, object]:
    detected_keys = sorted({item.group_key for item in accepted if item.group_key})
    detected_group_items = sum(
        1
        for item in accepted
        if item.item_kind is QuestionItemKind.GROUPED_QUESTION or item.group_key
    )
    missing_group_context = sum(
        1
        for item in accepted
        if item.citation_page in expectation.grouped_pages and not item.group_key
    )
    expected_keys = set(expectation.expected_group_keys)
    return {
        "expected_group_keys": list(expectation.expected_group_keys),
        "expected_group_items": expectation.expected_group_items,
        "detected_group_keys": detected_keys,
        "detected_group_items": detected_group_items,
        "detected_expected_groups": sorted(expected_keys.intersection(detected_keys)),
        "missing_group_context_items": missing_group_context,
    }


def manual_review_burden(
    accepted: Sequence[DraftSuggestion],
    rejected_count: int,
    expectation: GroupExpectation,
) -> dict[str, object]:
    reasons: Counter[str] = Counter()
    accepted_needing_review = 0
    for item in accepted:
        item_reasons = set()
        if item.answer_key_source is AnswerKeySource.AI_INFERRED:
            item_reasons.add("ai_inferred_answer")
        if item.confidence is None or item.confidence < 0.75:
            item_reasons.add("low_confidence")
        if item.citation_page in expectation.grouped_pages and not item.group_key:
            item_reasons.add("missing_group_context")
        if item_reasons:
            accepted_needing_review += 1
            reasons.update(item_reasons)

    if rejected_count:
        reasons["rejected_or_unusable_item"] += rejected_count

    total_items = len(accepted) + rejected_count
    requiring_review = accepted_needing_review + rejected_count
    return {
        "total_items": total_items,
        "items_requiring_review": requiring_review,
        "accepted_items_needing_review": accepted_needing_review,
        "rejected_items": rejected_count,
        "review_ratio": round(requiring_review / (total_items or 1), 4),
        "reasons": dict(sorted(reasons.items())),
    }


def sanitized_item(item: DraftSuggestion) -> dict[str, object]:
    return {
        "chunk_id": item.chunk_id,
        "citation_page": item.citation_page,
        "source_question_number": item.source_question_number,
        "item_kind": item.item_kind.value,
        "group_key": item.group_key,
        "has_group_prompt": item.group_prompt is not None,
        "answer_key_source": item.answer_key_source.value,
        "confidence": item.confidence,
    }


def unavailable_model_result(
    model: str,
    status: str,
    exc: Exception,
    expectation: GroupExpectation,
) -> dict[str, object]:
    return {
        "model": model,
        "provider": "ollama",
        "status": status,
        "json_valid": None,
        "json_recovered": None,
        "json_error": type(exc).__name__,
        "citation_validity": citation_validity([], 0),
        "group_detection": group_detection([], expectation),
        "latency_ms": None,
        "manual_review_burden": manual_review_burden([], 0, expectation),
        "accepted_items": [],
    }
