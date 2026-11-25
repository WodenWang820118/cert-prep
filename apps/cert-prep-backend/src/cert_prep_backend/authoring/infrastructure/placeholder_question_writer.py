"""Placeholder questions for the fake provider, so the app and its tests run without a model."""

from __future__ import annotations

from collections.abc import Sequence

from cert_prep_backend.authoring.domain.models import (
    AnswerKeySource,
    QuestionSuggestion,
    SourceChunk,
)
from cert_prep_backend.source_library.domain.exam_content import QuestionItemKind


class PlaceholderQuestionWriter:
    """Deterministic question writer used with the fake provider when Ollama is not configured."""

    def write_questions(self, chunks: Sequence[SourceChunk], limit: int) -> list[QuestionSuggestion]:
        """Generate deterministic placeholder questions from source chunks."""

        suggestions: list[QuestionSuggestion] = []
        for chunk in chunks[:limit]:
            excerpt = chunk.excerpt_or_text_prefix()
            suggestions.append(
                QuestionSuggestion(
                    chunk_id=chunk.id,
                    question="Which action best applies the cited exam concept?",
                    choices=[
                        "Apply the cited concept",
                        "Ignore the cited source",
                        "Choose an unrelated control",
                        "Remove all safeguards",
                    ],
                    answer="Apply the cited concept",
                    answer_key_source=AnswerKeySource.AI_INFERRED,
                    rationale=f"The cited source supports applying this concept: {excerpt}",
                    citation_page=chunk.page_number,
                    source_excerpt=excerpt,
                    confidence=1.0,
                    source_order=(chunk.page_number * 10_000) + (chunk.chunk_index * 1_000) + 1,
                    item_kind=QuestionItemKind.UNKNOWN,
                )
            )
        return suggestions
