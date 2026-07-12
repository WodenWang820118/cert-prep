from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any, TypeVar

from cert_prep_backend.domains.mock_exams.deterministic_parser import (
    extract_jlpt_question_blocks,
    source_text_for_prompt,
)
from cert_prep_backend.domains.mock_exams.model_fallback import ModelFallbackEngine
from cert_prep_backend.domains.mock_exams.models import (
    AnswerKeySource,
    DraftSuggestion,
    SourceChunk,
)
from cert_prep_backend.domains.mock_exams.normalization import dedupe_suggestions
from cert_prep_backend.domains.mock_exams.ollama_client import OllamaClient
from cert_prep_backend.domains.mock_exams.ports import ProviderHealth
from cert_prep_backend.domains.mock_exams.reasoning_parser import (
    EXAM_ITEMS_SCHEMA,
    draft_suggestion_from_item,
    json_response,
)
from cert_prep_backend.domains.mock_exams.response_parsing import (
    answer_from_payload,
    confidence_from_payload,
    fast_first_prompt,
    is_non_fatal_generation_error,
    is_runtime_model_failure,
    json_object_response_or_unavailable,
    short_error,
)
from cert_prep_backend.api.errors import ProviderUnavailableError
from cert_prep_contracts.llm_profiles import OllamaProfileSelection
from cert_prep_ollama.models import extract_model_names, pull_progress
from cert_prep_ollama.server import ensure_ollama_server_running, resolve_ollama_executable


STREAMING_PREWARM_KEEP_ALIVE = "5m"
STREAMING_RELEASE_KEEP_ALIVE = 0
# Transient Ollama failures often reflect memory pressure; retry after a quiet window.
MODEL_RETRY_AFTER_SECONDS = 300.0
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
        profile_selection: OllamaProfileSelection | None = None,
        client: Any | None = None,
    ) -> None:
        self.host = host
        self.model = model
        self.profile_selection = profile_selection
        self._fallback_engine = ModelFallbackEngine(
            primary_model=model,
            fallback_models=fallback_models,
            retry_after_seconds=MODEL_RETRY_AFTER_SECONDS,
            error_shortener=short_error,
        )
        self.fallback_models = self._fallback_engine.fallback_models
        self._client = client or OllamaClient(host=host, timeout_seconds=timeout_seconds)

    @property
    def supports_ollama_runtime_installation(self) -> bool:
        return True

    @property
    def starts_on_generation(self) -> bool:
        return False

    def streaming_generation_kwargs(self) -> dict[str, Any]:
        return {"keep_alive": STREAMING_RELEASE_KEEP_ALIVE}

    def health(self) -> ProviderHealth:
        """Return Ollama process and configured-model availability."""

        try:
            model_names = self._installed_model_names()
        except Exception as exc:
            executable = resolve_ollama_executable()
            if executable is None:
                detail = "Ollama is not installed."
                unavailable_reason = "ollama_missing"
            else:
                if ensure_ollama_server_running(self.host, executable=executable):
                    try:
                        model_names = self._installed_model_names()
                    except Exception as retry_exc:
                        detail = f"Ollama unavailable: {retry_exc}"
                        unavailable_reason = "ollama_not_running"
                    else:
                        return self._health_from_model_names(model_names)
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
                **self._profile_health_fields(),
            )

        return self._health_from_model_names(model_names)

    def _health_from_model_names(self, model_names: set[str]) -> ProviderHealth:
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
            **self._profile_health_fields(),
        )

    def _profile_health_fields(self) -> dict[str, object]:
        selection = self.profile_selection
        if selection is None:
            return {}
        return {
            "profile_id": selection.profile_id,
            "base_model": selection.selected_profile.base_model,
            "modelfile_sha256": selection.modelfile_sha256,
            "profile_reason": selection.reason,
            "profile_warnings": selection.warnings,
        }

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
        keep_alive: str | float | int | None = STREAMING_PREWARM_KEEP_ALIVE,
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

    def generate_fast_first_draft(
        self,
        source_chunk: SourceChunk,
        candidate: DraftSuggestion,
        *,
        num_ctx: int = 1024,
        num_predict: int = 128,
        keep_alive: str | float | int | None = STREAMING_PREWARM_KEEP_ALIVE,
    ) -> DraftSuggestion | None:
        """Ask Ollama to complete one extracted draft with answer/rationale JSON."""

        try:
            payload = self._with_model_fallback(
                lambda model: json_object_response_or_unavailable(
                    self._client.chat(
                        model=model,
                        messages=[
                            {
                                "role": "user",
                                "content": fast_first_prompt(candidate),
                            }
                        ],
                        format="json",
                        options={
                            "temperature": 0,
                            "num_ctx": num_ctx,
                            "num_predict": num_predict,
                        },
                        think=False,
                        keep_alive=keep_alive,
                    ),
                    provider_label="Ollama",
                )
            )
        except ProviderUnavailableError as exc:
            if is_non_fatal_generation_error(exc):
                return None
            raise
        answer = answer_from_payload(payload.get("answer"), candidate.choices)
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
            confidence=confidence_from_payload(payload.get("confidence")),
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

    def _effective_model_from(self, model_names: set[str]) -> str | None:
        return self._fallback_engine.effective_model_from(model_names)

    def _fallback_reason(self, effective_model: str | None) -> str | None:
        return self._fallback_engine.fallback_reason(effective_model)

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

        candidates = self._fallback_engine.available_model_candidates(model_names)
        if candidates:
            return candidates

        raise ProviderUnavailableError(self._health_detail(None))

    def _with_model_fallback(self, operation: Callable[[str], T]) -> T:
        errors: list[str] = []
        for model in self._available_model_candidates():
            try:
                result = operation(model)
            except Exception as exc:
                errors.append(f"{model}: {short_error(exc)}")
                if is_runtime_model_failure(exc):
                    self._mark_model_unusable(model, exc)
                continue

            self._record_model_success(model)
            return result

        detail = "Ollama unavailable for configured and fallback models"
        if errors:
            detail = f"{detail}: {'; '.join(errors)}"
        raise ProviderUnavailableError(detail)

    def _mark_model_unusable(self, model: str, exc: Exception) -> None:
        self._fallback_engine.mark_model_unusable(model, exc)

    def _record_model_success(self, model: str) -> None:
        self._fallback_engine.record_model_success(model)

    def _runtime_unusable_models(self) -> set[str]:
        return self._fallback_engine.runtime_unusable_models()
