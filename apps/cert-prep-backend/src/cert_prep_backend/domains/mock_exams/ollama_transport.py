from __future__ import annotations

from collections.abc import Callable, Sequence
import logging
from threading import local
from typing import Any, TypeVar

from cert_prep_backend.domains.mock_exams.deterministic_parser import (
    extract_jlpt_question_blocks,
    is_exam_source_chunk,
    source_text_and_chunks_for_prompt,
)
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
    json_object_response_or_unavailable,
    short_error,
)
from cert_prep_contracts.llm import (
    GenerationAttribution,
    LLMExecutionMode,
    LLMExecutionPolicy,
)
from cert_prep_backend.api.errors import ProviderUnavailableError
from cert_prep_contracts.llm_profiles import OllamaProfileSelection
from cert_prep_contracts.runtime import RuntimeRequirementKind
from cert_prep_ollama.models import extract_model_names, pull_progress
from cert_prep_ollama.server import ensure_ollama_server_running, resolve_ollama_executable


STREAMING_PREWARM_KEEP_ALIVE = "5m"
STREAMING_RELEASE_KEEP_ALIVE = 0
T = TypeVar("T")
_LOGGER = logging.getLogger(__name__)


class OllamaProvider:
    """Ollama-backed mock exam draft provider and model-download transport."""

    provider = "ollama"

    def __init__(
        self,
        host: str,
        model: str,
        timeout_seconds: float,
        profile_selection: OllamaProfileSelection | None = None,
        execution_policy: LLMExecutionPolicy | None = None,
        client: Any | None = None,
    ) -> None:
        self.host = host
        self.model = model
        self.fallback_models: tuple[str, ...] = ()
        self.profile_selection = profile_selection
        self.execution_policy = execution_policy or LLMExecutionPolicy()
        self._generation_state = local()
        self._client = client or OllamaClient(host=host, timeout_seconds=timeout_seconds)
        if self.execution_policy.warning is not None:
            _LOGGER.warning("Ollama CPU fallback: %s", self.execution_policy.warning)

    @property
    def runtime_requirement_kind(self) -> RuntimeRequirementKind:
        return RuntimeRequirementKind.OLLAMA

    @property
    def starts_on_generation(self) -> bool:
        return False

    def streaming_generation_kwargs(self) -> dict[str, Any]:
        return {"keep_alive": STREAMING_RELEASE_KEEP_ALIVE}

    def reset_generation_attribution(self) -> None:
        self._generation_state.model = None

    def generation_attribution(self) -> GenerationAttribution:
        model = getattr(self._generation_state, "model", None)
        return GenerationAttribution(
            effective_provider=self.provider if model is not None else None,
            effective_model=model,
            fallback_reason=None,
        )

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
                **self._health_metadata_fields(),
            )

        return self._health_from_model_names(model_names)

    def _health_from_model_names(self, model_names: set[str]) -> ProviderHealth:
        effective_model = self._effective_model_from(model_names)
        available = effective_model is not None
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
            fallback_reason=None,
            **self._health_metadata_fields(),
        )

    def _health_metadata_fields(self) -> dict[str, object]:
        fields: dict[str, object] = {
            "execution_mode": self.execution_policy.mode,
            "execution_warning": self.execution_policy.warning,
        }
        selection = self.profile_selection
        if selection is None:
            return fields
        fields.update(
            {
                "profile_id": selection.profile_id,
                "base_model": selection.selected_profile.base_model,
                "modelfile_sha256": selection.modelfile_sha256,
                "profile_reason": selection.reason,
                "profile_warnings": selection.warnings,
            }
        )
        return fields

    def _chat_options(self, *, num_ctx: int, num_predict: int) -> dict[str, int]:
        options = {
            "temperature": 0,
            "num_ctx": num_ctx,
            "num_predict": num_predict,
        }
        if self.execution_policy.mode == LLMExecutionMode.CPU:
            options["num_gpu"] = 0
        return options

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

        source, prompt_chunks = source_text_and_chunks_for_prompt(chunks, limit)
        return self._with_primary_model(
            lambda model: self._generate_reasoning_drafts_for_model(
                model,
                chunks,
                source,
                prompt_chunks,
                limit=limit,
                num_ctx=num_ctx,
                num_predict=num_predict,
                keep_alive=keep_alive,
            )
        )

    def _generate_reasoning_drafts_for_model(
        self,
        model: str,
        chunks: Sequence[SourceChunk],
        source: str,
        prompt_chunks: Sequence[SourceChunk],
        *,
        limit: int,
        num_ctx: int,
        num_predict: int,
        keep_alive: str | float | int | None,
    ) -> list[DraftSuggestion]:
        payload = self._request_reasoning_payload(
            model,
            _reasoning_user_prompt(source, limit=limit),
            num_ctx=num_ctx,
            num_predict=num_predict,
            keep_alive=keep_alive,
        )

        chunks_by_page = {chunk.page_number: chunk for chunk in prompt_chunks}
        chunks_by_id = {chunk.id: chunk for chunk in prompt_chunks}
        suggestions = _suggestions_from_reasoning_payload(
            payload,
            chunks_by_page=chunks_by_page,
            chunks_by_id=chunks_by_id,
            limit=limit,
        )
        if (
            limit <= 1
            or len(suggestions) >= limit
            or (not suggestions and not any(is_exam_source_chunk(chunk) for chunk in chunks))
        ):
            return suggestions

        missing = limit - len(suggestions)
        supplemental_chunks = _prioritize_supplemental_chunks(
            chunks,
            prompted=prompt_chunks,
            accepted=suggestions,
        )
        supplemental_source, supplemental_prompt_chunks = source_text_and_chunks_for_prompt(
            supplemental_chunks,
            missing,
        )
        supplemental_payload = self._request_reasoning_payload(
            model,
            _supplemental_reasoning_user_prompt(
                supplemental_source,
                limit=missing,
                accepted=suggestions,
            ),
            num_ctx=num_ctx,
            num_predict=num_predict,
            keep_alive=keep_alive,
        )
        supplemental = _suggestions_from_reasoning_payload(
            supplemental_payload,
            chunks_by_page={chunk.page_number: chunk for chunk in supplemental_prompt_chunks},
            chunks_by_id={chunk.id: chunk for chunk in supplemental_prompt_chunks},
            limit=limit,
        )
        return dedupe_suggestions([*suggestions, *supplemental], limit)

    def _request_reasoning_payload(
        self,
        model: str,
        user_prompt: str,
        *,
        num_ctx: int,
        num_predict: int,
        keep_alive: str | float | int | None,
    ) -> dict[str, Any]:
        return json_response(
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
                    {"role": "user", "content": user_prompt},
                ],
                format=EXAM_ITEMS_SCHEMA,
                options=self._chat_options(
                    num_ctx=num_ctx,
                    num_predict=num_predict,
                ),
                think=False,
                keep_alive=keep_alive,
            )
        )

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
            payload = self._with_primary_model(
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
                        options=self._chat_options(
                            num_ctx=num_ctx,
                            num_predict=num_predict,
                        ),
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

    def _available_effective_model(self) -> str:
        health = self.health()
        if health.available and health.effective_model:
            return health.effective_model
        raise ProviderUnavailableError(health.detail)

    def _effective_model_from(self, model_names: set[str]) -> str | None:
        return self.model if self.model in model_names else None

    def _health_detail(self, effective_model: str | None) -> str:
        if effective_model is None:
            return "model not found"
        return "model available"

    def _installed_model_names(self) -> set[str]:
        return extract_model_names(self._client.list())

    def _available_primary_model(self) -> str:
        try:
            model_names = self._installed_model_names()
        except Exception as exc:
            raise ProviderUnavailableError(f"Ollama unavailable: {exc}") from exc

        if self.model in model_names:
            return self.model

        raise ProviderUnavailableError(self._health_detail(None))

    def _with_primary_model(self, operation: Callable[[str], T]) -> T:
        model = self._available_primary_model()
        try:
            result = operation(model)
        except Exception as exc:
            raise ProviderUnavailableError(
                f"Ollama unavailable for configured model {model}: {short_error(exc)}"
            ) from exc
        self._generation_state.model = model
        return result


def _suggestions_from_reasoning_payload(
    payload: dict[str, Any],
    *,
    chunks_by_page: dict[int, SourceChunk],
    chunks_by_id: dict[str, SourceChunk],
    limit: int,
) -> list[DraftSuggestion]:
    raw_items = payload.get("items", [])
    if not isinstance(raw_items, list):
        return []

    suggestions: list[DraftSuggestion] = []
    for raw_item in raw_items:
        suggestion = draft_suggestion_from_item(raw_item, chunks_by_page, chunks_by_id)
        if suggestion is None:
            continue
        suggestions.append(suggestion)
    return dedupe_suggestions(suggestions, limit)


def _prioritize_supplemental_chunks(
    chunks: Sequence[SourceChunk],
    *,
    prompted: Sequence[SourceChunk],
    accepted: Sequence[DraftSuggestion],
) -> list[SourceChunk]:
    prompted_chunk_ids = {chunk.id for chunk in prompted}
    accepted_chunk_ids = {suggestion.chunk_id for suggestion in accepted}
    return [
        *[chunk for chunk in chunks if chunk.id not in prompted_chunk_ids],
        *[
            chunk
            for chunk in chunks
            if chunk.id in prompted_chunk_ids and chunk.id not in accepted_chunk_ids
        ],
        *[chunk for chunk in chunks if chunk.id in accepted_chunk_ids],
    ]


def _reasoning_user_prompt(
    source: str,
    *,
    limit: int,
) -> str:
    return (
        "Return one item for each distinct visible multiple-choice exam item, "
        f"up to {limit}. If at least {limit} valid items are present, return exactly {limit}. "
        "If fewer valid items are present, return only those items, possibly an empty array. "
        "Never invent, duplicate, or split an item merely to reach the requested count. "
        "Inspect the complete supplied source before responding. Each item must have a complete "
        "question stem and at least two visible choices, with each choice in a separate choices "
        "array element. For every item, set answer to the exact choice text, include a concise "
        "user-facing rationale, include confidence as a number from 0 to 1, keep "
        "citation_page from the source page, and include a source_excerpt copied exactly "
        "from the source text. If the source only contains title, note, version, or "
        f"instruction text, return an empty items array for that text.\n\n{source}"
    )


def _supplemental_reasoning_user_prompt(
    source: str,
    *,
    limit: int,
    accepted: Sequence[DraftSuggestion],
) -> str:
    exclusions = "\n".join(
        (
            f"- chunk_id={suggestion.chunk_id}; "
            f"source_question_number={suggestion.source_question_number or 'unknown'}; "
            f"question={suggestion.question[:160]}"
        )
        for suggestion in accepted
    )
    accepted_context = (
        f"Do not repeat these already accepted items:\n{exclusions}\n\n"
        if exclusions
        else "No item from the prior response passed strict validation.\n\n"
    )
    return (
        "This is the single supplemental pass because the prior response did not yield enough "
        "complete grounded items. Return only additional distinct visible multiple-choice exam "
        f"items, up to {limit}. If at least {limit} additional valid items are present, return "
        f"exactly {limit}. Never invent, duplicate, or split an item to reach the count. Each "
        "item must have a complete question stem and at least two visible choices, with every "
        "choice in a separate choices array element. Set answer to the exact choice text, include "
        "a concise user-facing rationale, include confidence from 0 to 1, keep citation_page from "
        "the source page, and copy source_excerpt exactly from the source text. "
        f"{accepted_context}{source}"
    )
