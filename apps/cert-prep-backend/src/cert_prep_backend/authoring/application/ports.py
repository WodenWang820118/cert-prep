"""What the Question Authoring use cases need from outside: stored drafts and generation work,
the source chunks drafts are written from, and the language model that writes them."""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Protocol

from cert_prep_backend.authoring.domain.draft import DraftEdit, NewQuestionDraft, QuestionDraft
from cert_prep_backend.authoring.domain.generation import DraftGenerationJob, ManualDraftOperation
from cert_prep_backend.authoring.domain.models import (
    DraftGenerationStrategy,
    DraftSuggestion,
    SourceChunk,
)
from cert_prep_backend.authoring.domain.reading_solver import ReadingSpan


class ReadingLexicon(Protocol):
    def kanji_span_readings(self, text: str) -> Iterable[ReadingSpan]: ...


class QuestionDraftRepository(Protocol):
    def drafts_of(self, project_id: str) -> list[QuestionDraft]: ...

    def write(self, project_id: str, draft: NewQuestionDraft) -> QuestionDraft: ...

    def edit(self, project_id: str, draft_id: str, edit: DraftEdit) -> QuestionDraft: ...

    def add_generated(
        self, project_id: str, document_id: str, suggestions: Sequence[DraftSuggestion]
    ) -> list[QuestionDraft]:
        """Store generated drafts, skipping ones the document already has."""
        ...

    def approved(
        self, project_id: str, *, document_id: str | None
    ) -> list[QuestionDraft]:
        """Approved drafts of the project, by id, or of one document in source order."""
        ...

    def find(self, project_id: str, draft_id: str) -> QuestionDraft | None:
        """The project's current draft of one question, or None when it is gone."""
        ...

    def find_many(self, project_id: str, draft_ids: Sequence[str]) -> list[QuestionDraft]:
        """The project's current drafts for these ids; ids with no draft are absent."""
        ...


class DraftGenerationJobRepository(Protocol):
    def jobs_of(self, project_id: str, document_id: str) -> list[DraftGenerationJob]: ...

    def cancel(self, project_id: str, document_id: str, job_id: str) -> DraftGenerationJob: ...

    def discard_unfinished(self, project_id: str, document_id: str) -> None:
        """Delete the document's pending, running and cancel-requested jobs; ended ones stay."""
        ...


class DocumentExamState(Protocol):
    """A source document's count of drafts and the status that follows from it. Source Library
    owns documents (D17)."""

    def record_draft_count(self, project_id: str, document_id: str, count: int) -> None: ...

    def record_import_draft_count(self, project_id: str, document_id: str, count: int) -> None:
        """Record the drafts written while the document was imported; a document without text
        or chunks is marked exam_failed."""
        ...


class DraftSources(DocumentExamState, Protocol):
    """A document's source chunks in Source Library, and its count of drafts."""

    def chunks_of(self, project_id: str, document_id: str) -> list[SourceChunk]: ...


class DraftWriting(Protocol):
    """Writes drafts from source chunks with a language model, following a strategy."""

    def suggestions(
        self,
        model: object,
        chunks: Sequence[SourceChunk],
        limit: int,
        strategy: DraftGenerationStrategy,
    ) -> list[DraftSuggestion]: ...

    def import_suggestions(
        self, model: object, chunks: Sequence[SourceChunk], limit: int
    ) -> list[DraftSuggestion]:
        """Drafts written in one pass while a document is imported, without a strategy;
        ProviderUnavailableError when the model cannot write them."""
        ...


class DraftGenerationWork(Protocol):
    """Generation that runs in the background: per-chunk jobs, retried jobs and manual
    operations."""

    def enqueue_document(self, project_id: str, document_id: str) -> None:
        """Queue a generation job per chunk, when the settings stream drafts at import."""
        ...

    def retry_jobs(self, project_id: str, document_id: str) -> list[DraftGenerationJob]: ...

    def start_manual_operation(
        self,
        project_id: str,
        document_id: str,
        limit: int,
        strategy: DraftGenerationStrategy,
    ) -> ManualDraftOperation: ...

    def manual_operation(
        self, project_id: str, document_id: str, operation_id: str
    ) -> ManualDraftOperation: ...

    def cancel_manual_operation(
        self, project_id: str, document_id: str, operation_id: str
    ) -> ManualDraftOperation: ...
