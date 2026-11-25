"""What the Question Authoring use cases need from outside: stored questions and generation work,
the source chunks questions are written from, and the language model that writes them."""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Protocol

from cert_prep_backend.authoring.domain.question import QuestionEdit, NewQuestion, Question
from cert_prep_backend.authoring.domain.generation import QuestionGenerationJob, ManualQuestionGeneration
from cert_prep_backend.authoring.domain.models import (
    QuestionGenerationStrategy,
    QuestionSuggestion,
    SourceChunk,
)
from cert_prep_backend.authoring.domain.reading_solver import ReadingSpan


class StudyProjects(Protocol):
    """Whether a study project exists. Study Projects owns that fact (D17)."""

    def exists(self, project_id: str) -> bool: ...


class ProjectSources(Protocol):
    """Whether a source belongs to a project. Source Library owns sources (D17)."""

    def require(self, project_id: str, source_id: str) -> None:
        """NotFoundError unless the source belongs to the project."""
        ...


class ReadingLexicon(Protocol):
    def kanji_span_readings(self, text: str) -> Iterable[ReadingSpan]: ...


class QuestionRepository(Protocol):
    def questions_of(self, project_id: str) -> list[Question]: ...

    def write(self, project_id: str, authored_question: NewQuestion) -> Question: ...

    def edit(self, project_id: str, question_id: str, edit: QuestionEdit) -> Question: ...

    def add_generated(
        self, project_id: str, source_id: str, suggestions: Sequence[QuestionSuggestion]
    ) -> list[Question]:
        """Store generated questions, skipping ones the source already has."""
        ...

    def count_for_source(self, project_id: str, source_id: str) -> int:
        """How many questions the source has, whoever wrote them and whenever."""
        ...

    def for_source(
        self, project_id: str, *, source_id: str | None
    ) -> list[Question]:
        """Questions of the project, by id, or of one source in source order."""
        ...

    def find(self, project_id: str, question_id: str) -> Question | None:
        """The project's current question, or None when it is gone."""
        ...

    def find_many(self, project_id: str, question_ids: Sequence[str]) -> list[Question]:
        """The project's current questions for these ids; ids with no question are absent."""
        ...


class QuestionGenerationJobRepository(Protocol):
    def jobs_of(self, project_id: str, source_id: str) -> list[QuestionGenerationJob]: ...

    def cancel(self, project_id: str, source_id: str, job_id: str) -> QuestionGenerationJob: ...

    def discard_unfinished(self, project_id: str, source_id: str) -> None:
        """Delete the source's pending, running and cancel-requested jobs; ended ones stay."""
        ...


class SourceQuestionCount(Protocol):
    """A source's count of every question it has. Source Library owns sources (D17).

    The count is every question the source has, not the number a writer just added. Writing
    questions for a source, and writing them during import, also record the status that follows.
    A question written by hand stores the count only.
    """

    def record_question_count(self, project_id: str, source_id: str, count: int) -> None: ...

    def record_import_question_count(self, project_id: str, source_id: str, count: int) -> None:
        """Record the source's question count after questions were written while it was
        imported; a source without text or chunks is marked no_text_detected."""
        ...

    def record_authored_question_count(
        self, project_id: str, source_id: str, count: int
    ) -> None:
        """Store the count only; status, failure message and `updated_at` stay."""
        ...


class QuestionSources(Protocol):
    """A source's chunks in Source Library, and the question count recorded with its status."""

    def chunks_of(self, project_id: str, source_id: str) -> list[SourceChunk]: ...

    def chunk(self, project_id: str, source_id: str, chunk_id: str) -> SourceChunk: ...

    def record_question_count(self, project_id: str, source_id: str, count: int) -> None: ...

    def record_import_question_count(self, project_id: str, source_id: str, count: int) -> None:
        """Record the source's question count after questions were written while it was
        imported; a source without text or chunks is marked no_text_detected."""
        ...


class QuestionWriting(Protocol):
    """Writes questions from source chunks with a language model, following a strategy."""

    def suggestions(
        self,
        model: object,
        chunks: Sequence[SourceChunk],
        limit: int,
        strategy: QuestionGenerationStrategy,
    ) -> list[QuestionSuggestion]: ...

    def import_suggestions(
        self, model: object, chunks: Sequence[SourceChunk], limit: int
    ) -> list[QuestionSuggestion]:
        """Questions written in one pass while a source is imported, without a strategy;
        LanguageModelUnavailable when the model cannot write them."""
        ...


class QuestionGenerationWork(Protocol):
    """Generation that runs in the background: per-chunk jobs, retried jobs and manual
    operations."""

    def enqueue_source(self, project_id: str, source_id: str) -> None:
        """Queue a generation job per chunk, when the settings stream questions at import."""
        ...

    def retry_jobs(self, project_id: str, source_id: str) -> list[QuestionGenerationJob]: ...

    def start_manual_operation(
        self,
        project_id: str,
        source_id: str,
        limit: int,
        strategy: QuestionGenerationStrategy,
    ) -> ManualQuestionGeneration: ...

    def manual_operation(
        self, project_id: str, source_id: str, operation_id: str
    ) -> ManualQuestionGeneration: ...

    def cancel_manual_operation(
        self, project_id: str, source_id: str, operation_id: str
    ) -> ManualQuestionGeneration: ...
