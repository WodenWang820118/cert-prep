from __future__ import annotations

from collections.abc import Sequence
import json
from typing import Any

from cert_prep_backend.api.errors import ProviderUnavailableError
from cert_prep_backend.domains.mock_exams.models import DraftSuggestion


def fast_first_prompt(candidate: DraftSuggestion) -> str:
    choices = "\n".join(str(choice) for choice in candidate.choices)
    return (
        "Return only compact JSON with keys answer, rationale, confidence. "
        "Answer must be one of the visible choices or its leading number. "
        "Rationale must be concise and user-facing; do not include hidden reasoning.\n"
        f"Question: {candidate.question}\n"
        f"Choices:\n{choices}\n"
        f"Source excerpt:\n{candidate.source_excerpt}\n"
        "Pick the best answer from the choices."
    )


def json_object_response(response: Any) -> dict[str, Any]:
    content = getattr(getattr(response, "message", None), "content", None)
    if content is None and isinstance(response, dict):
        message = response.get("message")
        if isinstance(message, dict):
            content = message.get("content")
    if not isinstance(content, str):
        return {}
    try:
        payload = json.loads(content)
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}


def json_object_response_or_unavailable(response: Any, *, provider_label: str) -> dict[str, Any]:
    payload = json_object_response(response)
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


def short_error(exc: Exception) -> str:
    return short_error_text(str(exc) or exc.__class__.__name__)


def short_error_text(value: str) -> str:
    return " ".join(value.split())[:240]


def is_non_fatal_generation_error(exc: Exception) -> bool:
    error = short_error(exc).lower()
    return any(
        marker in error
        for marker in (
            "invalid json",
            "unreadable response",
            "non-object json response",
            "timed out",
            "timeout",
        )
    )


def is_runtime_model_failure(exc: Exception) -> bool:
    return not is_non_fatal_generation_error(exc)


def _normalize_answer(value: str) -> str:
    return " ".join(value.strip().lower().split())
