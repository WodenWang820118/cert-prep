"""How Question Authoring writes drafts: the writer for a language model, and the strategies."""

from __future__ import annotations

from collections.abc import Sequence

from cert_prep_backend.ai_providers.domain.generation_errors import (
    is_non_fatal_generation_error,
)
from cert_prep_backend.ai_providers.domain.provider import (
    JsonChatProvider,
    provider_capability,
)
from cert_prep_backend.authoring.domain.deterministic_parser import extract_jlpt_question_blocks
from cert_prep_backend.authoring.domain.models import (
    DraftGenerationResult,
    DraftGenerationStrategy,
    DraftSuggestion,
    SourceChunk,
    UnavailableDraftBlock,
)
from cert_prep_backend.authoring.domain.normalization import (
    as_editable_question,
    dedupe_suggestions,
)
from cert_prep_backend.authoring.domain.ports import (
    DraftGenerationProvider,
    FastFirstDraftProvider,
    ReasoningDraftProvider,
)
from cert_prep_backend.authoring.infrastructure.ollama_drafts import OllamaDraftWriter
from cert_prep_backend.authoring.infrastructure.placeholder_drafts import PlaceholderDraftWriter
from cert_prep_backend.platform.errors import ProviderUnavailableError
from cert_prep_contracts.llm import LLMProviderName

__all__ = [
    "ProviderDraftWriting",
    "draft_writer_for",
    "generate_drafts_for_strategy",
    "generate_drafts_with_annotations_for_strategy",
]


DraftWriter = DraftGenerationProvider | FastFirstDraftProvider | ReasoningDraftProvider


def draft_writer_for(model: object) -> DraftWriter:
    """The writer that turns source chunks into drafts with this language model.

    A model with any draft capability of its own is its own writer. Otherwise drafts are
    written over JSON chat (Ollama); the fake provider gets placeholder drafts.
    """

    for capability in (DraftGenerationProvider, FastFirstDraftProvider, ReasoningDraftProvider):
        writer = provider_capability(model, capability)
        if writer is not None:
            return writer
    json_chat = provider_capability(model, JsonChatProvider)
    if json_chat is not None:
        return OllamaDraftWriter(json_chat)
    if getattr(model, "provider", None) == LLMProviderName.FAKE:
        return PlaceholderDraftWriter()
    raise ProviderUnavailableError(
        f"The {getattr(model, 'provider', 'configured')} provider cannot write question drafts."
    )


def generate_drafts_for_strategy(
    provider,
    chunks: Sequence[SourceChunk],
    limit: int,
    strategy: DraftGenerationStrategy,
) -> list[DraftSuggestion]:
    """Generate immediately playable question suggestions for a document."""

    return generate_drafts_with_annotations_for_strategy(
        provider,
        chunks,
        limit,
        strategy,
    ).suggestions


def generate_drafts_with_annotations_for_strategy(
    provider,
    chunks: Sequence[SourceChunk],
    limit: int,
    strategy: DraftGenerationStrategy,
) -> DraftGenerationResult:
    """Generate playable questions while retaining parsed blocks needing review.

    A non-fatal completion failure is scoped to the parsed block that caused it.
    Runtime/provider failures that are not safe to continue still propagate so
    the host remains fail-closed and never substitutes another provider.
    """

    deterministic = extract_jlpt_question_blocks(chunks, limit)
    if strategy == DraftGenerationStrategy.DETERMINISTIC_ONLY:
        playable = _playable_suggestions(deterministic, limit)
        playable_ids = {id(suggestion) for suggestion in playable}
        return DraftGenerationResult(
            suggestions=playable,
            unavailable_blocks=[
                _unavailable_block(candidate, "Parsed block has no completed answer.")
                for candidate in deterministic
                if id(candidate) not in playable_ids
            ],
        )

    generated: list[DraftSuggestion] = []
    unavailable_blocks: list[UnavailableDraftBlock] = []
    writer = draft_writer_for(provider)
    fast_first_provider = provider_capability(writer, FastFirstDraftProvider)
    if fast_first_provider is not None and deterministic:
        chunks_by_id = {chunk.id: chunk for chunk in chunks}
        for candidate in deterministic:
            source_chunk = chunks_by_id.get(candidate.chunk_id)
            if source_chunk is None:
                unavailable_blocks.append(
                    _unavailable_block(candidate, "Parsed block source chunk is unavailable.")
                )
                continue
            try:
                completed = fast_first_provider.generate_fast_first_draft(
                    source_chunk,
                    candidate,
                )
            except ProviderUnavailableError as exc:
                if not is_non_fatal_generation_error(exc):
                    raise
                completed = None
                failure_reason = str(exc)
            else:
                failure_reason = "Capture Runtime question completion returned no playable answer."
            if completed is not None:
                editable = as_editable_question(completed)
                if _playable_suggestions([editable], 1):
                    generated.append(editable)
                    continue
                failure_reason = "Capture Runtime question completion returned an incomplete answer."
            unavailable_blocks.append(_unavailable_block(candidate, failure_reason))
        return DraftGenerationResult(
            suggestions=dedupe_suggestions(generated, limit),
            unavailable_blocks=unavailable_blocks,
        )

    reasoning_provider = provider_capability(writer, ReasoningDraftProvider)
    remaining = limit - len(generated)
    if remaining > 0:
        if reasoning_provider is not None:
            generated.extend(
                as_editable_question(suggestion)
                for suggestion in reasoning_provider.generate_reasoning_drafts(chunks, remaining)
            )
        elif not generated:
            generated = [
                as_editable_question(suggestion)
                for suggestion in writer.generate_drafts(chunks, limit)
            ]
    return DraftGenerationResult(
        suggestions=dedupe_suggestions(
            [*_playable_suggestions(deterministic, limit), *generated],
            limit,
        ),
        unavailable_blocks=unavailable_blocks,
    )


def _unavailable_block(candidate: DraftSuggestion, reason: str) -> UnavailableDraftBlock:
    return UnavailableDraftBlock(
        chunk_id=candidate.chunk_id,
        citation_page=candidate.citation_page,
        source_excerpt=candidate.source_excerpt,
        source_order=candidate.source_order,
        source_question_number=candidate.source_question_number,
        reason=reason or "Capture Runtime could not complete this parsed block.",
    )


def _playable_suggestions(
    suggestions: Sequence[DraftSuggestion], limit: int
) -> list[DraftSuggestion]:
    return [
        suggestion
        for suggestion in suggestions
        if suggestion.answer and suggestion.answer in suggestion.choices and suggestion.rationale
    ][:limit]


class ProviderDraftWriting:
    """Writes drafts with the configured language model, through its draft writer."""

    def suggestions(
        self,
        model: object,
        chunks: Sequence[SourceChunk],
        limit: int,
        strategy: DraftGenerationStrategy,
    ) -> list[DraftSuggestion]:
        return generate_drafts_for_strategy(model, chunks, limit, strategy)
