"""What the Question Authoring use cases need from outside: stored drafts and generation work,
the source chunks drafts are written from, and the language model that writes them."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol

from cert_prep_backend.authoring.domain.draft import DraftEdit, NewQuestionDraft, QuestionDraft
from cert_prep_backend.authoring.domain.generation import DraftGenerationJob, ManualDraftOperation
from cert_prep_backend.authoring.domain.models import (
    DraftGenerationStrategy,
    DraftSuggestion,
    SourceChunk,
)


class QuestionDraftRepository(Protocol):
    def drafts_of(self, project_id: str) -> list[QuestionDraft]: ...

    def write(self, project_id: str, draft: NewQuestionDraft) -> QuestionDraft: ...

    def edit(self, project_id: str, draft_id: str, edit: DraftEdit) -> QuestionDraft: ...

    def add_generated(
        self, project_id: str, document_id: str, suggestions: Sequence[DraftSuggestion]
    ) -> list[QuestionDraft]:
        """Store generated drafts, skipping ones the document already has."""
        ...


class DraftGenerationJobRepository(Protocol):
    def jobs_of(self, project_id: str, document_id: str) -> list[DraftGenerationJob]: ...

    def cancel(self, project_id: str, document_id: str, job_id: str) -> DraftGenerationJob: ...


class DraftSources(Protocol):
    """A document's source chunks in Source Library, and its count of drafts."""

    def chunks_of(self, project_id: str, document_id: str) -> list[SourceChunk]: ...

    def record_draft_count(self, project_id: str, document_id: str, count: int) -> None: ...


class DraftWriting(Protocol):
    """Writes drafts from source chunks with a language model, following a strategy."""

    def suggestions(
        self,
        model: object,
        chunks: Sequence[SourceChunk],
        limit: int,
        strategy: DraftGenerationStrategy,
    ) -> list[DraftSuggestion]: ...


class DraftGenerationWork(Protocol):
    """Generation that runs in the background: retried jobs and manual operations."""

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
