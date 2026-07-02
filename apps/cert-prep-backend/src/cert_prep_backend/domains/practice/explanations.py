from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from cert_prep_backend.api.errors import ProviderUnavailableError
from cert_prep_backend.domains.mock_exams.ports import ProviderHealth, provider_capability
from cert_prep_backend.domains.practice.models import WrongAnswer


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

    def to_record(self) -> dict[str, object]:
        return {
            "question": self.question,
            "selected_answer": self.selected_answer,
            "correct_answer": self.correct_answer,
            "rationale": self.rationale,
            "citation_page": self.citation_page,
            "source_excerpt": self.source_excerpt,
        }


@dataclass(frozen=True, slots=True)
class WrongAnswerExplanation:
    attempt_id: str
    explanation: str
    provider: str
    model: str
    grounded_fields: WrongAnswerGroundedFields
    fallback: bool

    def to_record(self) -> dict[str, object]:
        return {
            "attempt_id": self.attempt_id,
            "explanation": self.explanation,
            "provider": self.provider,
            "model": self.model,
            "grounded_fields": self.grounded_fields.to_record(),
            "fallback": self.fallback,
        }


@runtime_checkable
class PracticeExplanationProvider(Protocol):
    def explain_wrong_answer(self, fields: WrongAnswerGroundedFields) -> str:
        """Return a concise user-facing explanation grounded in the provided fields."""
        pass


def explain_wrong_answer(provider: object, wrong_answer: WrongAnswer) -> dict:
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
        ).to_record()

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
            ).to_record()

    return WrongAnswerExplanation(
        attempt_id=wrong_answer.attempt_id,
        explanation=_deterministic_explanation(fields),
        provider=metadata.provider,
        model=metadata.model,
        grounded_fields=fields,
        fallback=True,
    ).to_record()


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


def _deterministic_explanation(fields: WrongAnswerGroundedFields) -> str:
    correct_answer = fields.correct_answer or "the recorded correct answer"
    explanation = (
        f"The selected answer, {fields.selected_answer!r}, does not match the correct "
        f"answer, {correct_answer!r}."
    )
    if fields.rationale:
        explanation = f"{explanation} {fields.rationale.strip()}"
    if fields.citation_page is not None:
        explanation = f"{explanation} See citation page {fields.citation_page}."
    if fields.source_excerpt:
        explanation = f"{explanation} Source excerpt: {fields.source_excerpt.strip()}"
    return explanation
