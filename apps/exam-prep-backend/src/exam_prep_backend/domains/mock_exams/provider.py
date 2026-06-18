from __future__ import annotations

from collections.abc import Sequence

from exam_prep_backend.config import Settings
from exam_prep_backend.domains.mock_exams.deterministic_parser import (
    MAX_PROMPT_SOURCE_CHARS,
    extract_jlpt_question_blocks as _extract_jlpt_question_blocks,
    source_text_for_prompt as _source_text_for_prompt,
)
from exam_prep_backend.domains.mock_exams.fake_provider import FakeLLMProvider
from exam_prep_backend.domains.mock_exams.models import (
    DraftGenerationStrategy,
    DraftSuggestion,
    SourceChunk,
)
from exam_prep_backend.domains.mock_exams.normalization import (
    as_ai_reasoning_draft as _as_ai_reasoning_draft,
    dedupe_suggestions as _dedupe_suggestions,
)
from exam_prep_backend.domains.mock_exams.ollama_transport import (
    OllamaProvider,
    extract_model_names as _extract_model_names,
    pull_progress as _pull_progress,
)
from exam_prep_backend.domains.mock_exams.reasoning_parser import (
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
            timeout_seconds=settings.ollama_timeout_seconds,
        )
    return FakeLLMProvider(model=settings.ollama_model)


def generate_drafts_for_strategy(
    provider,
    chunks: Sequence[SourceChunk],
    limit: int,
    strategy: DraftGenerationStrategy,
) -> list[DraftSuggestion]:
    """Generate draft suggestions for the explicit draft endpoint strategy."""

    deterministic = _extract_jlpt_question_blocks(chunks, limit)
    if strategy == DraftGenerationStrategy.DETERMINISTIC_ONLY:
        return deterministic
    if len(deterministic) >= limit:
        return deterministic

    remaining = limit - len(deterministic)
    if isinstance(provider, OllamaProvider):
        generated = provider.generate_reasoning_drafts(chunks, remaining)
    else:
        generated = provider.generate_drafts(chunks, remaining)
    generated = [_as_ai_reasoning_draft(suggestion) for suggestion in generated]
    return _dedupe_suggestions([*deterministic, *generated], limit)


__all__ = [
    "EXAM_ITEMS_SCHEMA",
    "FakeLLMProvider",
    "MAX_PROMPT_SOURCE_CHARS",
    "OllamaProvider",
    "_as_ai_reasoning_draft",
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
