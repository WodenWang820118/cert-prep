from __future__ import annotations

from collections.abc import Callable, Sequence
import json
from threading import Lock
from typing import Any, TypeVar

import ollama

from exam_prep_backend.domains.mock_exams.deterministic_parser import (
    extract_jlpt_question_blocks,
    source_text_for_prompt,
)
from exam_prep_backend.domains.mock_exams.models import (
    AnswerKeySource,
    DraftSuggestion,
    SourceChunk,
)
from exam_prep_backend.domains.mock_exams.normalization import dedupe_suggestions
from exam_prep_backend.domains.mock_exams.ports import ModelPullProgress, ProviderHealth
from exam_prep_backend.domains.mock_exams.reasoning_parser import (
    EXAM_ITEMS_SCHEMA,
    draft_suggestion_from_item,
    json_response,
)
from exam_prep_backend.domains.runtime_installations import resolve_ollama_executable
from exam_prep_backend.errors import ProviderUnavailableError


STREAMING_PREWARM_KEEP_ALIVE = "5m"
T = TypeVar("T")


class OllamaProvider:
    """Ollama-backed mock exam draft provider and model-download transport."""

    provider = "ollama"

    def __init__(
        self,
        host: str,
        model: str,
        timeout_seconds: float,
        fallback_models: Sequence[str] = (),
    ) -> None:
        self.host = host
        self.model = model
        self.fallback_models = tuple(
            dict.fromkeys(
                fallback.strip()
                for fallback in fallback_models
                if fallback.strip() and fallback.strip() != model
            )
        )
        self._client = ollama.Client(host=host, timeout=timeout_seconds)
        self._model_lock = Lock()
        self._unusable_models: set[str] = set()
        self._runtime_effective_model: str | None = None
        self._last_primary_failure: str | None = None
        self._runtime_fallback_reason: str | None = None

    def health(self) -> ProviderHealth:
        """Return Ollama process and configured-model availability."""

        try:
            model_names = self._installed_model_names()
        except Exception as exc:
            if resolve_ollama_executable() is None:
                detail = "Ollama is not installed."
                unavailable_reason = "ollama_missing"
            else:
                detail = f"Ollama unavailable: {exc}"
                unavailable_reason = "ollama_not_running"
            return ProviderHealth(
                provider=self.provider,
                model=self.model,
                available=False,
                detail=detail,
                unavailable_reason=unavailable_reason,
                configured_model=self.model,
                fallback_models=self.fallback_models,
            )

        effective_model = self._effective_model_from(model_names)
        available = effective_model is not None
        fallback_reason = self._fallback_reason(effective_model)
        detail = self._health_detail(effective_model)
        return ProviderHealth(
            provider=self.provider,
            model=self.model,
            available=available,
            detail=detail,
            unavailable_reason=None if available else "model_missing",
            configured_model=self.model,
            effective_model=effective_model,
            fallback_models=self.fallback_models,
            fallback_reason=fallback_reason,
        )

    def generate_drafts(self, chunks: Sequence[SourceChunk], limit: int) -> list[DraftSuggestion]:
        """Generate drafts by combining deterministic extraction with reasoning fallback."""

        if not chunks:
            return []

        extracted = extract_jlpt_question_blocks(chunks, limit)
        if len(extracted) >= limit:
            return extracted

        generated = self.generate_reasoning_drafts(chunks, limit - len(extracted))
        return dedupe_suggestions([*extracted, *generated], limit)

    def generate_reasoning_drafts(
        self,
        chunks: Sequence[SourceChunk],
        limit: int,
        *,
        num_ctx: int = 8192,
        num_predict: int = 4096,
        keep_alive: str | float | None = STREAMING_PREWARM_KEEP_ALIVE,
    ) -> list[DraftSuggestion]:
        """Ask Ollama for structured JSON drafts and validate grounded results."""

        if not chunks or limit <= 0:
            return []

        source = source_text_for_prompt(chunks, limit)
        payload = self._with_model_fallback(
            lambda model: json_response(
                self._client.chat(
                    model=model,
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
                    options={
                        "temperature": 0,
                        "num_ctx": num_ctx,
                        "num_predict": num_predict,
                    },
                    think=False,
                    keep_alive=keep_alive,
                )
            )
        )
        raw_items = payload.get("items", [])
        if not isinstance(raw_items, list):
            return []

        chunks_by_page = {chunk.page_number: chunk for chunk in chunks}
        chunks_by_id = {chunk.id: chunk for chunk in chunks}
        suggestions: list[DraftSuggestion] = []
        for raw_item in raw_items:
            suggestion = draft_suggestion_from_item(raw_item, chunks_by_page, chunks_by_id)
            if suggestion is None:
                continue
            suggestions.append(suggestion)
            if len(suggestions) >= limit:
                break
        return suggestions

    def prewarm(self) -> None:
        """Keep the configured Ollama model warm without downloading missing models."""

        health = self.health()
        if not health.available or not health.effective_model:
            return

        try:
            self._with_model_fallback(
                lambda model: self._client.chat(
                    model=model,
                    messages=[{"role": "user", "content": "Reply with ok."}],
                    options={"temperature": 0, "num_ctx": 512, "num_predict": 1},
                    think=False,
                    keep_alive=STREAMING_PREWARM_KEEP_ALIVE,
                )
            )
        except ProviderUnavailableError:
            return

    def generate_fast_first_draft(
        self,
        source_chunk: SourceChunk,
        candidate: DraftSuggestion,
        *,
        num_ctx: int = 1024,
        num_predict: int = 128,
    ) -> DraftSuggestion | None:
        """Ask Ollama to complete one extracted draft with answer/rationale JSON."""

        payload = self._with_model_fallback(
            lambda model: _json_object_response_or_unavailable(
                self._client.chat(
                    model=model,
                    messages=[
                        {
                            "role": "user",
                            "content": _fast_first_prompt(candidate),
                        }
                    ],
                    format="json",
                    options={
                        "temperature": 0,
                        "num_ctx": num_ctx,
                        "num_predict": num_predict,
                    },
                    think=False,
                    keep_alive=STREAMING_PREWARM_KEEP_ALIVE,
                )
            )
        )
        answer = _answer_from_payload(payload.get("answer"), candidate.choices)
        if answer is None:
            return None

        rationale = payload.get("rationale")
        rationale_text = (
            rationale.strip()
            if isinstance(rationale, str) and rationale.strip()
            else "Qwen inferred the answer from the visible stem and choices."
        )
        return DraftSuggestion(
            chunk_id=source_chunk.id,
            question=candidate.question,
            choices=candidate.choices,
            answer=answer,
            answer_key_source=AnswerKeySource.AI_INFERRED,
            rationale=rationale_text,
            citation_page=source_chunk.page_number,
            source_excerpt=candidate.source_excerpt,
            confidence=_confidence_from_payload(payload.get("confidence")),
            source_order=candidate.source_order,
            source_question_number=candidate.source_question_number,
            item_kind=candidate.item_kind,
            group_key=candidate.group_key,
            group_prompt=candidate.group_prompt,
        )

    def pull_model(self, progress) -> None:
        """Pull the configured Ollama model after explicit user confirmation."""

        for update in self._client.pull(self.model, stream=True):
            progress(pull_progress(update))

    def _available_effective_model(self) -> str:
        health = self.health()
        if health.available and health.effective_model:
            return health.effective_model
        raise ProviderUnavailableError(health.detail)

    def _effective_model_from(self, model_names: set[str]) -> str | None:
        unusable_models = self._runtime_unusable_models()
        runtime_effective_model = self._runtime_selected_model()
        if (
            runtime_effective_model
            and runtime_effective_model in model_names
            and runtime_effective_model not in unusable_models
        ):
            return runtime_effective_model
        for candidate in (self.model, *self.fallback_models):
            if candidate in unusable_models:
                continue
            if candidate in model_names:
                return candidate
        return None

    def _fallback_reason(self, effective_model: str | None) -> str | None:
        if effective_model is None or effective_model == self.model:
            return None
        runtime_reason = self._runtime_reason_for(effective_model)
        if runtime_reason:
            return runtime_reason
        return f"Configured model {self.model} is missing; using fallback {effective_model}."

    def _health_detail(self, effective_model: str | None) -> str:
        if effective_model is None:
            return "model not found"
        if effective_model == self.model:
            return "model available"
        return f"model available via fallback {effective_model}"

    def _installed_model_names(self) -> set[str]:
        return extract_model_names(self._client.list())

    def _available_model_candidates(self) -> tuple[str, ...]:
        try:
            model_names = self._installed_model_names()
        except Exception as exc:
            raise ProviderUnavailableError(f"Ollama unavailable: {exc}") from exc

        unusable_models = self._runtime_unusable_models()
        candidates = tuple(
            candidate
            for candidate in (self.model, *self.fallback_models)
            if candidate in model_names and candidate not in unusable_models
        )
        if candidates:
            return candidates

        health = self.health()
        raise ProviderUnavailableError(health.detail)

    def _with_model_fallback(self, operation: Callable[[str], T]) -> T:
        errors: list[str] = []
        for model in self._available_model_candidates():
            try:
                result = operation(model)
            except Exception as exc:
                errors.append(f"{model}: {_short_error(exc)}")
                self._mark_model_unusable(model, exc)
                continue

            self._record_model_success(model)
            return result

        detail = "Ollama unavailable for configured and fallback models"
        if errors:
            detail = f"{detail}: {'; '.join(errors)}"
        raise ProviderUnavailableError(detail)

    def _mark_model_unusable(self, model: str, exc: Exception) -> None:
        with self._model_lock:
            self._unusable_models.add(model)
            if model == self.model:
                self._last_primary_failure = _short_error(exc)
            if self._runtime_effective_model == model:
                self._runtime_effective_model = None
                self._runtime_fallback_reason = None

    def _record_model_success(self, model: str) -> None:
        with self._model_lock:
            if model == self.model:
                self._runtime_effective_model = None
                self._runtime_fallback_reason = None
                return

            self._runtime_effective_model = model
            if self._last_primary_failure:
                self._runtime_fallback_reason = (
                    f"Configured model {self.model} was unavailable during generation "
                    f"({_short_error_text(self._last_primary_failure)}); using fallback {model}."
                )
            else:
                self._runtime_fallback_reason = (
                    f"Configured model {self.model} is missing; using fallback {model}."
                )

    def _runtime_unusable_models(self) -> set[str]:
        with self._model_lock:
            return set(self._unusable_models)

    def _runtime_selected_model(self) -> str | None:
        with self._model_lock:
            return self._runtime_effective_model

    def _runtime_reason_for(self, effective_model: str) -> str | None:
        with self._model_lock:
            if self._runtime_effective_model != effective_model:
                return None
            return self._runtime_fallback_reason


def _fast_first_prompt(candidate: DraftSuggestion) -> str:
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


def _json_object_response(response: Any) -> dict[str, Any]:
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


def _json_object_response_or_unavailable(response: Any) -> dict[str, Any]:
    payload = _json_object_response(response)
    if not payload:
        raise ProviderUnavailableError("Ollama returned invalid JSON.")
    return payload


def _answer_from_payload(value: Any, choices: Sequence[str]) -> str | None:
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


def _normalize_answer(value: str) -> str:
    return " ".join(value.strip().lower().split())


def _confidence_from_payload(value: Any) -> float | None:
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


def _short_error(exc: Exception) -> str:
    return _short_error_text(str(exc) or exc.__class__.__name__)


def _short_error_text(value: str) -> str:
    return " ".join(value.split())[:240]


def extract_model_names(response: Any) -> set[str]:
    """Extract model names from the shapes returned by Ollama clients."""

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


def pull_progress(response: Any) -> ModelPullProgress:
    """Normalize streamed Ollama pull progress into domain progress values."""

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
