"""How Question Authoring asks for questions: a question writer and its optional capabilities.

A question writer turns source chunks into questions with a language model of AI
Providers; ``authoring.infrastructure.question_writing.question_writer_for`` picks the writer for
the configured model.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Protocol, runtime_checkable

from cert_prep_backend.authoring.domain.models import QuestionSuggestion, SourceChunk

__all__ = [
    "QuestionWriter",
    "FastFirstQuestionWriter",
    "ReasoningQuestionWriter",
]


@runtime_checkable
class QuestionWriter(Protocol):
    """Boundary for writers that turn source chunks into questions."""

    def write_questions(self, chunks: Sequence[SourceChunk], limit: int) -> list[QuestionSuggestion]:
        """Generate up to limit question suggestions from source chunks."""
        pass


@runtime_checkable
class ReasoningQuestionWriter(Protocol):
    """Writer capability for structured reasoning over source chunks."""

    def write_reasoning_questions(
        self,
        chunks: Sequence[SourceChunk],
        limit: int,
        **kwargs: Any,
    ) -> list[QuestionSuggestion]:
        """Generate questions through the provider's reasoning path."""
        pass


@runtime_checkable
class FastFirstQuestionWriter(Protocol):
    """Writer capability for completing one deterministic question candidate."""

    def write_fast_first_question(
        self,
        source_chunk: SourceChunk,
        candidate: QuestionSuggestion,
        **kwargs: Any,
    ) -> QuestionSuggestion | None:
        """Complete answer/rationale fields for one deterministic question."""
        pass
