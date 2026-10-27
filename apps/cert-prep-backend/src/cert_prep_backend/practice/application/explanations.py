from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Protocol, runtime_checkable

from cert_prep_backend.platform.errors import ProviderUnavailableError
from cert_prep_backend.ai_providers.domain.provider import (
    JsonChatProvider,
    ProviderHealth,
    provider_capability,
)
from cert_prep_backend.practice.domain.wrong_answer import WrongAnswer

EXPLANATION_LANGUAGE_INSTRUCTION = (
    "Write the explanation in Traditional Chinese (繁體中文) as used in Taiwan, "
    "and quote words from the source, such as the Japanese word being read, "
    "in their original script."
)


@dataclass(frozen=True, slots=True)
class WrongAnswerGroundedFields:
    question: str
    selected_answer: str
    correct_answer: str | None
    rationale: str | None
    citation_page: int | None
    source_excerpt: str | None

    @classmethod
    def from_wrong_answer(cls, wrong_answer: WrongAnswer) -> WrongAnswerGroundedFields:
        return cls(
            question=wrong_answer.question,
            selected_answer=wrong_answer.selected_answer,
            correct_answer=wrong_answer.correct_answer,
            rationale=wrong_answer.rationale,
            citation_page=wrong_answer.citation_page,
            source_excerpt=wrong_answer.source_excerpt,
        )



@dataclass(frozen=True, slots=True)
class WrongAnswerExplanation:
    attempt_id: str
    explanation: str
    provider: str
    model: str
    grounded_fields: WrongAnswerGroundedFields
    fallback: bool



@runtime_checkable
class PracticeExplanationProvider(Protocol):
    def explain_wrong_answer(self, fields: WrongAnswerGroundedFields) -> str:
        """Return a concise user-facing explanation grounded in the provided fields.

        The model prompt is ``explanation_prompt``.
        """
        pass


def explain_wrong_answer(provider: object, wrong_answer: WrongAnswer) -> WrongAnswerExplanation:
    fields = WrongAnswerGroundedFields.from_wrong_answer(wrong_answer)
    metadata = _provider_metadata(provider)
    explanation_provider = provider_capability(provider, PracticeExplanationProvider)

    if metadata.provider == "fake":
        return WrongAnswerExplanation(
            attempt_id=wrong_answer.attempt_id,
            explanation=_deterministic_explanation(fields),
            provider=metadata.provider,
            model=metadata.model,
            grounded_fields=fields,
            fallback=False,
        )

    if metadata.available and explanation_provider is not None:
        try:
            generated = explanation_provider.explain_wrong_answer(fields).strip()
        except ProviderUnavailableError:
            generated = ""
        if generated:
            return WrongAnswerExplanation(
                attempt_id=wrong_answer.attempt_id,
                explanation=generated,
                provider=metadata.provider,
                model=metadata.model,
                grounded_fields=fields,
                fallback=False,
            )

    if metadata.available:
        generated = _explanation_from_model(provider, fields)
        if generated:
            return WrongAnswerExplanation(
                attempt_id=wrong_answer.attempt_id,
                explanation=generated,
                provider=metadata.provider,
                model=metadata.model,
                grounded_fields=fields,
                fallback=False,
            )

    return WrongAnswerExplanation(
        attempt_id=wrong_answer.attempt_id,
        explanation=_deterministic_explanation(fields),
        provider=metadata.provider,
        model=metadata.model,
        grounded_fields=fields,
        fallback=True,
    )


@dataclass(frozen=True, slots=True)
class _ProviderMetadata:
    provider: str
    model: str
    available: bool


def _provider_metadata(provider: object) -> _ProviderMetadata:
    provider_name = str(getattr(provider, "provider", "unknown") or "unknown")
    model_name = str(getattr(provider, "model", "unknown") or "unknown")

    try:
        health = provider.health()
    except (ProviderUnavailableError, RuntimeError, OSError):
        return _ProviderMetadata(provider=provider_name, model=model_name, available=False)

    if isinstance(health, ProviderHealth):
        return _ProviderMetadata(
            provider=health.provider or provider_name,
            model=health.effective_model or health.model or model_name,
            available=health.available,
        )
    return _ProviderMetadata(provider=provider_name, model=model_name, available=True)


def explanation_prompt(fields: WrongAnswerGroundedFields) -> str:
    """Prompt for Discuss mistake with AI. The reply is JSON with an explanation string."""

    correct_answer = fields.correct_answer or ""
    rationale = fields.rationale or ""
    page = "" if fields.citation_page is None else str(fields.citation_page)
    excerpt = fields.source_excerpt or ""
    return (
        f"{EXPLANATION_LANGUAGE_INSTRUCTION} "
        "Explain why the selected answer does not match the correct answer, "
        "using only the grounded fields below. "
        "Return a JSON object with one string field named explanation.\n"
        f"Question: {fields.question}\n"
        f"Selected answer: {fields.selected_answer}\n"
        f"Correct answer: {correct_answer}\n"
        f"Rationale: {rationale}\n"
        f"Citation page: {page}\n"
        f"Source excerpt: {excerpt}"
    )


def _explanation_from_model(provider: object, fields: WrongAnswerGroundedFields) -> str:
    chat_provider = provider_capability(provider, JsonChatProvider)
    if chat_provider is None:
        return ""
    prompt = explanation_prompt(fields)
    try:
        content = chat_provider.json_chat_session(
            lambda chat: chat(
                [{"role": "user", "content": prompt}],
                num_ctx=2048,
                num_predict=512,
            )
        )
    except ProviderUnavailableError:
        return ""
    return _explanation_text(content)


def _explanation_text(content: object) -> str:
    if not isinstance(content, str):
        return ""
    text = content.strip()
    if not text:
        return ""
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return text
    if isinstance(payload, dict):
        explanation = payload.get("explanation")
        if isinstance(explanation, str) and explanation.strip():
            return explanation.strip()
    return ""


def _deterministic_explanation(fields: WrongAnswerGroundedFields) -> str:
    correct_answer = fields.correct_answer or "記錄的正確答案"
    explanation = f"你選的「{fields.selected_answer}」與正確答案「{correct_answer}」不符。"
    if fields.rationale:
        explanation = f"{explanation}{fields.rationale.strip()}"
    if fields.citation_page is not None:
        explanation = f"{explanation} 請參考第 {fields.citation_page} 頁。"
    if fields.source_excerpt:
        explanation = f"{explanation} 原文：{fields.source_excerpt.strip()}"
    return explanation
