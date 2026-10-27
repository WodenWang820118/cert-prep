"""Use cases of Question Authoring, named after what the learner does with question drafts.

Drafts are also generated while a document is imported; routers.documents still drives that
until step C6 takes the capture rules out of the router.
"""

from __future__ import annotations

from cert_prep_backend.authoring.application.ports import (
    DraftGenerationJobRepository,
    DraftGenerationWork,
    DraftSources,
    DraftWriting,
    QuestionDraftRepository,
)
from cert_prep_backend.authoring.domain.draft import DraftEdit, NewQuestionDraft, QuestionDraft
from cert_prep_backend.authoring.domain.generation import DraftGenerationJob, ManualDraftOperation
from cert_prep_backend.authoring.domain.models import DraftGenerationStrategy
from cert_prep_backend.platform.errors import ValidationError

__all__ = [
    "cancel_generation_job",
    "cancel_manual_generation",
    "edit_draft",
    "generate_document_drafts",
    "list_drafts",
    "list_generation_jobs",
    "retry_generation_jobs",
    "start_manual_generation",
    "view_manual_generation",
    "write_draft",
]


def list_drafts(drafts: QuestionDraftRepository, project_id: str) -> list[QuestionDraft]:
    return drafts.drafts_of(project_id)


def write_draft(
    drafts: QuestionDraftRepository, project_id: str, draft: NewQuestionDraft
) -> QuestionDraft:
    return drafts.write(project_id, draft)


def edit_draft(
    drafts: QuestionDraftRepository, project_id: str, draft_id: str, edit: DraftEdit
) -> QuestionDraft:
    return drafts.edit(project_id, draft_id, edit)


def generate_document_drafts(
    drafts: QuestionDraftRepository,
    sources: DraftSources,
    writing: DraftWriting,
    model: object,
    *,
    project_id: str,
    document_id: str,
    limit: int,
    strategy: DraftGenerationStrategy,
) -> list[QuestionDraft]:
    """Write drafts from every chunk of a document now, and record how many it has."""

    chunks = sources.chunks_of(project_id, document_id)
    if not chunks:
        raise ValidationError("Document has no extracted text chunks.")
    suggestions = writing.suggestions(model, chunks, limit, strategy)
    added = drafts.add_generated(project_id, document_id, suggestions)
    sources.record_draft_count(project_id, document_id, len(added))
    return added


def list_generation_jobs(
    jobs: DraftGenerationJobRepository, project_id: str, document_id: str
) -> list[DraftGenerationJob]:
    return jobs.jobs_of(project_id, document_id)


def retry_generation_jobs(
    work: DraftGenerationWork, project_id: str, document_id: str
) -> list[DraftGenerationJob]:
    """Run again the jobs of a document that ended without drafts."""

    return work.retry_jobs(project_id, document_id)


def cancel_generation_job(
    jobs: DraftGenerationJobRepository, project_id: str, document_id: str, job_id: str
) -> DraftGenerationJob:
    return jobs.cancel(project_id, document_id, job_id)


def start_manual_generation(
    work: DraftGenerationWork,
    project_id: str,
    document_id: str,
    *,
    limit: int,
    strategy: DraftGenerationStrategy,
) -> ManualDraftOperation:
    """Generate drafts for a whole document in the background; one operation at a time."""

    return work.start_manual_operation(project_id, document_id, limit, strategy)


def view_manual_generation(
    work: DraftGenerationWork, project_id: str, document_id: str, operation_id: str
) -> ManualDraftOperation:
    return work.manual_operation(project_id, document_id, operation_id)


def cancel_manual_generation(
    work: DraftGenerationWork, project_id: str, document_id: str, operation_id: str
) -> ManualDraftOperation:
    return work.cancel_manual_operation(project_id, document_id, operation_id)
