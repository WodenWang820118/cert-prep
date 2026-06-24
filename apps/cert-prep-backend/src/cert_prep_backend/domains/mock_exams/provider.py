from __future__ import annotations

from collections.abc import Sequence

from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.mock_exams.deterministic_parser import (
    MAX_PROMPT_SOURCE_CHARS,
    extract_jlpt_question_blocks as _extract_jlpt_question_blocks,
    source_text_for_prompt as _source_text_for_prompt,
)
from cert_prep_backend.domains.mock_exams.fake_provider import FakeLLMProvider
from cert_prep_backend.domains.mock_exams.fastflowlm_transport import FastFlowLMProvider
from cert_prep_backend.domains.mock_exams.models import (
    DraftGenerationStrategy,
    DraftSuggestion,
    SourceChunk,
)
from cert_prep_backend.domains.mock_exams.normalization import (
    as_editable_question as _as_editable_question,
    dedupe_suggestions as _dedupe_suggestions,
)
from cert_prep_backend.domains.mock_exams.ollama_transport import (
    OllamaProvider,
    extract_model_names as _extract_model_names,
    pull_progress as _pull_progress,
)
from cert_prep_backend.domains.mock_exams.reasoning_parser import (
    EXAM_ITEMS_SCHEMA,
    draft_suggestion_from_item as _draft_suggestion_from_item,
    json_response as _json_response,
)


def provider_from_settings(settings: Settings):
    """Create the configured mock exam provider."""

    if settings.llm_provider == "ollama":
        return OllamaProvider(
            host=settings.ollama_host,
            model=settings.ollama_model,
            fallback_models=settings.ollama_fallback_models,
            timeout_seconds=settings.ollama_timeout_seconds,
        )
    if settings.llm_provider == "fastflowlm":
        return FastFlowLMProvider(
            base_url=settings.fastflowlm_base_url,
            model=settings.fastflowlm_model,
            fallback_models=settings.fastflowlm_fallback_models,
            timeout_seconds=settings.fastflowlm_timeout_seconds,
            model_pull_timeout_seconds=settings.runtime_install_timeout_seconds,
            primary_min_available_ram_bytes=(
                settings.fastflowlm_primary_min_available_ram_bytes
            ),
        )
    return FakeLLMProvider(model=settings.ollama_model)


def generate_drafts_for_strategy(
    provider,
    chunks: Sequence[SourceChunk],
    limit: int,
    strategy: DraftGenerationStrategy,
) -> list[DraftSuggestion]:
    """Generate immediately playable question suggestions for a document."""

    deterministic = _extract_jlpt_question_blocks(chunks, limit)
    if strategy == DraftGenerationStrategy.DETERMINISTIC_ONLY:
        return _playable_suggestions(deterministic, limit)

    if isinstance(provider, OllamaProvider):
        generated = provider.generate_reasoning_drafts(chunks, limit)
    else:
        generated = provider.generate_drafts(chunks, limit)
    generated = [_as_editable_question(suggestion) for suggestion in generated]
    return _dedupe_suggestions(
        [*_playable_suggestions(deterministic, limit), *generated],
        limit,
    )


def _playable_suggestions(
    suggestions: Sequence[DraftSuggestion], limit: int
) -> list[DraftSuggestion]:
    return [
        suggestion
        for suggestion in suggestions
        if suggestion.answer
        and suggestion.answer in suggestion.choices
        and suggestion.rationale
    ][:limit]


__all__ = [
    "EXAM_ITEMS_SCHEMA",
    "FakeLLMProvider",
    "FastFlowLMProvider",
    "MAX_PROMPT_SOURCE_CHARS",
    "OllamaProvider",
    "_as_editable_question",
    "_dedupe_suggestions",
    "_draft_suggestion_from_item",
    "_extract_jlpt_question_blocks",
    "_extract_model_names",
    "_json_response",
    "_pull_progress",
    "_source_text_for_prompt",
    "generate_drafts_for_strategy",
    "provider_from_settings",
]
