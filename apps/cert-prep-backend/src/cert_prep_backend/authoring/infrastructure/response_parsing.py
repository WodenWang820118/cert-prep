from __future__ import annotations

from collections.abc import Sequence
import json
import re
from typing import Any

from cert_prep_backend.authoring.domain.models import DraftSuggestion
from cert_prep_backend.platform.errors import ProviderUnavailableError

RATIONALE_LANGUAGE_INSTRUCTION = (
    "解說（rationale）必須用繁體中文（台灣用語）撰寫，不可用日文或英文；日文原文只放在「」裡引用。"
)

_READING_CHOICE_PATTERN = re.compile(
    r"^\s*(?:[0-9０-９]+[.．、\)）]?\s*)?"
    r"[\u3040-\u309f\u30a0-\u30ffー][\u3040-\u309f\u30a0-\u30ffー \t\u3000]*$"
)


def is_reading_question(choices: Sequence[str]) -> bool:
    if not choices:
        return False
    return all(
        isinstance(choice, str) and bool(_READING_CHOICE_PATTERN.match(choice))
        for choice in choices
    )


def fast_first_prompt(candidate: DraftSuggestion) -> str:
    choices = "\n".join(str(choice) for choice in candidate.choices)
    if is_reading_question(candidate.choices):
        return (
            "Return only compact JSON with keys target, reading, answer, rationale, confidence. "
            "First find the target word in the question (the word whose reading is asked). "
            "Write its correct reading in hiragana in reading. "
            "Then set answer to the visible choice whose text matches that reading, "
            "exactly as shown. "
            "Rationale must be concise and user-facing.\n"
            f"Question: {candidate.question}\n"
            f"Choices:\n{choices}\n"
            f"Source excerpt:\n{candidate.source_excerpt}\n"
            f"{RATIONALE_LANGUAGE_INSTRUCTION}"
        )
    return (
        "Return only compact JSON with keys answer, rationale, confidence. "
        "Answer must be one of the visible choices, exactly as shown, or its leading number. "
        "Rationale must be concise and user-facing; do not include hidden reasoning.\n"
        f"Question: {candidate.question}\n"
        f"Choices:\n{choices}\n"
        f"Source excerpt:\n{candidate.source_excerpt}\n"
        "Pick the best answer from the choices.\n"
        f"{RATIONALE_LANGUAGE_INSTRUCTION}"
    )


def fast_first_retry_prompt(candidate: DraftSuggestion) -> str:
    choices = "\n".join(str(choice) for choice in candidate.choices)
    if is_reading_question(candidate.choices):
        return (
            "Return one JSON object only with target, reading, answer, rationale, "
            "and confidence. Do not write Markdown, analysis, or prose. "
            "First find the target word in the question (the word whose reading is asked). "
            "Write its correct reading in hiragana in reading. "
            "Then set answer to the visible choice whose text matches that reading, "
            "exactly as shown. "
            "Rationale must be concise and user-facing.\n"
            f"Question: {candidate.question[:800]}\n"
            f"Choices:\n{choices}\n"
            f"{RATIONALE_LANGUAGE_INSTRUCTION}"
        )
    return (
        "Return one JSON object only with answer, rationale, and confidence. "
        "Do not write Markdown, analysis, or prose. "
        "Answer must be one of the four visible choices.\n"
        f"Question: {candidate.question[:800]}\n"
        f"Choices:\n{choices}\n"
        "Choose the best visible answer.\n"
        f"{RATIONALE_LANGUAGE_INSTRUCTION}"
    )


def json_object(content: object) -> dict[str, Any]:
    if not isinstance(content, str):
        return {}
    try:
        payload = json.loads(content)
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}


def json_object_or_unavailable(content: object, *, provider_label: str) -> dict[str, Any]:
    payload = json_object(content)
    if not payload:
        raise ProviderUnavailableError(f"{provider_label} returned invalid JSON.")
    return payload


def answer_from_payload(value: Any, choices: Sequence[str]) -> str | None:
    if not isinstance(value, str | int | float):
        return None
    answer = str(value).strip()
    if not answer:
        return None

    normalized_answer = _normalize_answer(answer)
    for choice in choices:
        if _normalize_answer(choice) == normalized_answer:
            return choice

    if answer.isdigit():
        for choice in choices:
            if choice.strip().startswith(answer):
                return choice

    for choice in choices:
        normalized_choice = _normalize_answer(choice)
        if normalized_answer in normalized_choice or normalized_choice in normalized_answer:
            return choice
    return None


def confidence_from_payload(value: Any) -> float | None:
    if isinstance(value, int | float):
        return max(0.0, min(1.0, float(value)))
    if isinstance(value, str):
        value_lower = value.strip().lower()
        if value_lower in {"high", "confident"}:
            return 0.8
        if value_lower in {"medium", "moderate"}:
            return 0.6
        if value_lower in {"low", "uncertain"}:
            return 0.4
        try:
            return max(0.0, min(1.0, float(value_lower)))
        except ValueError:
            return None
    return None


def _normalize_answer(value: str) -> str:
    return " ".join(value.strip().lower().split())
