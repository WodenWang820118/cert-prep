"""How Question Authoring writes questions: the writer for a language model, and the strategies."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import replace

from cert_prep_backend.authoring.application.ports import ReadingLexicon

from cert_prep_backend.ai_providers.domain.generation_errors import (
    is_non_fatal_generation_error,
)
from cert_prep_backend.ai_providers.domain.provider import (
    JsonChatProvider,
    provider_capability,
)
from cert_prep_backend.authoring.domain.deterministic_parser import extract_jlpt_question_blocks
from cert_prep_backend.authoring.domain.models import (
    QuestionGenerationResult,
    QuestionGenerationStrategy,
    QuestionSuggestion,
    SourceChunk,
    UnavailableQuestionBlock,
)
from cert_prep_backend.authoring.domain.normalization import (
    as_editable_question,
    dedupe_suggestions,
)
from cert_prep_backend.authoring.domain.ports import (
    QuestionWriter,
    FastFirstQuestionWriter,
    ReasoningQuestionWriter,
)
from cert_prep_backend.authoring.infrastructure.ollama_question_writer import OllamaQuestionWriter
from cert_prep_backend.authoring.infrastructure.placeholder_question_writer import PlaceholderQuestionWriter
from cert_prep_backend.platform.errors import LanguageModelUnavailable
from cert_prep_contracts.llm import LLMProviderName

__all__ = [
    "ProviderQuestionWriting",
    "question_writer_for",
    "write_questions_for_strategy",
    "write_questions_with_annotations_for_strategy",
]


QuestionWritingCapability = QuestionWriter | FastFirstQuestionWriter | ReasoningQuestionWriter


def question_writer_for(
    model: object, *, reading_lexicon: ReadingLexicon | None = None
) -> QuestionWritingCapability:
    """The writer that turns source chunks into questions with this language model.

    A model with any question-writing capability of its own is its own writer. Otherwise questions are
    written over JSON chat (Ollama); the fake provider gets placeholder questions.
    """

    for capability in (QuestionWriter, FastFirstQuestionWriter, ReasoningQuestionWriter):
        writer = provider_capability(model, capability)
        if writer is not None:
            return writer
    json_chat = provider_capability(model, JsonChatProvider)
    if json_chat is not None:
        return OllamaQuestionWriter(json_chat, reading_lexicon=reading_lexicon)
    if getattr(model, "provider", None) == LLMProviderName.FAKE:
        return PlaceholderQuestionWriter()
    raise LanguageModelUnavailable(
        f"The {getattr(model, 'provider', 'configured')} provider cannot write questions."
    )


def write_questions_for_strategy(
    provider,
    chunks: Sequence[SourceChunk],
    limit: int,
    strategy: QuestionGenerationStrategy,
    *,
    reading_lexicon: ReadingLexicon | None = None,
) -> list[QuestionSuggestion]:
    """Generate immediately playable question suggestions for a source."""

    return write_questions_with_annotations_for_strategy(
        provider,
        chunks,
        limit,
        strategy,
        reading_lexicon=reading_lexicon,
    ).suggestions


def write_questions_with_annotations_for_strategy(
    provider,
    chunks: Sequence[SourceChunk],
    limit: int,
    strategy: QuestionGenerationStrategy,
    *,
    reading_lexicon: ReadingLexicon | None = None,
) -> QuestionGenerationResult:
    """Generate playable questions while retaining parsed blocks needing review.

    Hybrid order per page (see docs/domain/authoring.md, "PDF 匯入的出題順序"):
    pages with complete deterministic blocks only get answers (Sudachi for gated
    reading items, otherwise the fast-first model call); pages without one are sent
    once to model extraction, whose items pass the admission rules in
    ``domain/question_admission.py``. The background path in ``question_jobs.py`` follows
    the same order one page at a time; change both together.

    A non-fatal completion failure is scoped to the parsed block that caused it.
    Runtime/provider failures that are not safe to continue still propagate so
    the host remains fail-closed and never substitutes another provider.
    """

    deterministic = extract_jlpt_question_blocks(chunks, limit)
    if strategy == QuestionGenerationStrategy.DETERMINISTIC_ONLY:
        playable = _playable_suggestions(deterministic, limit)
        playable_ids = {id(suggestion) for suggestion in playable}
        return QuestionGenerationResult(
            suggestions=playable,
            unavailable_blocks=[
                _unavailable_block(candidate, "Parsed block has no completed answer.")
                for candidate in deterministic
                if id(candidate) not in playable_ids
            ],
        )

    generated: list[QuestionSuggestion] = []
    unavailable_blocks: list[UnavailableQuestionBlock] = []
    writer = question_writer_for(provider, reading_lexicon=reading_lexicon)
    fast_first_provider = provider_capability(writer, FastFirstQuestionWriter)
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
                completed = fast_first_provider.write_fast_first_question(
                    source_chunk,
                    candidate,
                )
            except LanguageModelUnavailable as exc:
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
        generated = dedupe_suggestions(generated, limit)
        reasoning_provider = provider_capability(writer, ReasoningQuestionWriter)
        if reasoning_provider is not None:
            parsed_chunk_ids = {candidate.chunk_id for candidate in deterministic}
            for index, chunk in enumerate(chunks):
                remaining = limit - len(generated)
                if remaining <= 0:
                    break
                if chunk.id in parsed_chunk_ids:
                    continue
                # The source parser may have stopped at the limit. Check this
                # page with its continuation before treating it as unparsed.
                if any(
                    candidate.chunk_id == chunk.id
                    for candidate in extract_jlpt_question_blocks(chunks[index : index + 2], 1)
                ):
                    continue
                try:
                    suggestions = reasoning_provider.write_reasoning_questions([chunk], remaining)
                except LanguageModelUnavailable as exc:
                    if not is_non_fatal_generation_error(exc):
                        raise
                    continue
                suggestions = _with_chunk_source_order(suggestions, chunk)
                generated = dedupe_suggestions(
                    [*generated, *(as_editable_question(item) for item in suggestions)], limit
                )
        return QuestionGenerationResult(
            suggestions=generated,
            unavailable_blocks=unavailable_blocks,
        )

    reasoning_provider = provider_capability(writer, ReasoningQuestionWriter)
    remaining = limit - len(generated)
    if remaining > 0:
        if reasoning_provider is not None:
            generated.extend(
                as_editable_question(suggestion)
                for suggestion in reasoning_provider.write_reasoning_questions(chunks, remaining)
            )
        elif not generated:
            generated = [
                as_editable_question(suggestion)
                for suggestion in writer.write_questions(chunks, limit)
            ]
    return QuestionGenerationResult(
        suggestions=dedupe_suggestions(
            [*_playable_suggestions(deterministic, limit), *generated],
            limit,
        ),
        unavailable_blocks=unavailable_blocks,
    )


def _with_chunk_source_order(
    suggestions: Sequence[QuestionSuggestion], chunk: SourceChunk
) -> list[QuestionSuggestion]:
    # Match the deterministic parser's page/chunk order without overriding model metadata.
    base_order = chunk.page_number * 10_000 + chunk.chunk_index * 1_000
    return [
        replace(suggestion, source_order=base_order + index)
        if suggestion.source_order is None
        else suggestion
        for index, suggestion in enumerate(suggestions, start=1)
    ]


def _unavailable_block(candidate: QuestionSuggestion, reason: str) -> UnavailableQuestionBlock:
    return UnavailableQuestionBlock(
        chunk_id=candidate.chunk_id,
        citation_page=candidate.citation_page,
        source_excerpt=candidate.source_excerpt,
        source_order=candidate.source_order,
        source_question_number=candidate.source_question_number,
        reason=reason or "Capture Runtime could not complete this parsed block.",
    )


def _playable_suggestions(
    suggestions: Sequence[QuestionSuggestion], limit: int
) -> list[QuestionSuggestion]:
    return [
        suggestion
        for suggestion in suggestions
        if suggestion.answer and suggestion.answer in suggestion.choices and suggestion.rationale
    ][:limit]


class ProviderQuestionWriting:
    """Writes questions with the configured language model, through its question writer."""

    def __init__(self, *, reading_lexicon: ReadingLexicon | None = None) -> None:
        self._reading_lexicon = reading_lexicon

    def suggestions(
        self,
        model: object,
        chunks: Sequence[SourceChunk],
        limit: int,
        strategy: QuestionGenerationStrategy,
    ) -> list[QuestionSuggestion]:
        return write_questions_for_strategy(
            model, chunks, limit, strategy, reading_lexicon=self._reading_lexicon
        )

    def import_suggestions(
        self, model: object, chunks: Sequence[SourceChunk], limit: int
    ) -> list[QuestionSuggestion]:
        # Questions written at import never used the reading lexicon; keep them as they were.
        return question_writer_for(model).write_questions(chunks, limit)
