from __future__ import annotations

from fastapi import APIRouter, Depends, status

from exam_prep_backend.database import Database
from exam_prep_backend.dependencies import (
    get_database,
    get_llm_provider,
    get_streaming_draft_generation_manager,
)
from exam_prep_backend.domains.mock_exams import draft_jobs
from exam_prep_backend.domains.mock_exams import repository as mock_exams_repository
from exam_prep_backend.domains.mock_exams.models import SourceChunk
from exam_prep_backend.domains.mock_exams.ports import DraftGenerationProvider as LLMProvider
from exam_prep_backend.domains.mock_exams.provider import generate_drafts_for_strategy
from exam_prep_backend.domains.mock_exams.schemas import (
    DraftGenerateRequest,
    DraftGenerationJobList,
    QuestionDraftCreate,
    QuestionDraftList,
    QuestionDraftRead,
    QuestionDraftUpdate,
)
from exam_prep_backend.domains.mock_exams.streaming import StreamingDraftGenerationManager
from exam_prep_backend.domains.source_documents import repository as source_documents_repository
from exam_prep_backend.errors import (
    NotFoundError,
    ProviderUnavailableError,
    ValidationError,
    api_error,
    not_found_error,
    validation_error,
)


documents_router = APIRouter(
    prefix="/projects/{project_id}/documents/{document_id}/drafts",
    tags=["question-drafts"],
)
draft_jobs_router = APIRouter(
    prefix="/projects/{project_id}/documents/{document_id}/draft-jobs",
    tags=["question-drafts"],
)
drafts_router = APIRouter(prefix="/projects/{project_id}/question-drafts", tags=["question-drafts"])


@draft_jobs_router.get("", response_model=DraftGenerationJobList)
def list_document_draft_jobs(
    project_id: str,
    document_id: str,
    db: Database = Depends(get_database),
) -> dict:
    try:
        return {"items": draft_jobs.list_document_jobs(db, project_id, document_id)}
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@draft_jobs_router.post(
    "/retry",
    response_model=DraftGenerationJobList,
    status_code=status.HTTP_202_ACCEPTED,
)
def retry_document_draft_jobs(
    project_id: str,
    document_id: str,
    db: Database = Depends(get_database),
    streaming_drafts: StreamingDraftGenerationManager = Depends(
        get_streaming_draft_generation_manager
    ),
) -> dict:
    try:
        return {
            "items": streaming_drafts.retry_document_jobs(
                db,
                project_id=project_id,
                document_id=document_id,
            )
        }
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@documents_router.post("", response_model=QuestionDraftList, status_code=status.HTTP_201_CREATED)
def generate_document_drafts(
    project_id: str,
    document_id: str,
    payload: DraftGenerateRequest,
    db: Database = Depends(get_database),
    provider: LLMProvider = Depends(get_llm_provider),
) -> dict:
    try:
        chunks = [
            SourceChunk(
                id=chunk["id"],
                page_number=chunk["page_number"],
                chunk_index=chunk["chunk_index"],
                text=chunk["text"],
                raw_text=chunk["raw_text"],
                source_excerpt=chunk["source_excerpt"],
                line_start=chunk["line_start"],
                line_end=chunk["line_end"],
                line_count=chunk["line_count"],
                content_profile=chunk["content_profile"],
            )
            for chunk in source_documents_repository.get_source_chunks(db, project_id, document_id)
        ]
        if not chunks:
            raise ValidationError("Document has no extracted text chunks.")
        suggestions = generate_drafts_for_strategy(
            provider, chunks, payload.limit, payload.strategy
        )
        drafts = mock_exams_repository.create_generated_drafts(
            db,
            project_id=project_id,
            document_id=document_id,
            suggestions=suggestions,
        )
        document = source_documents_repository.get_document(db, project_id, document_id)
        next_status = "processing" if document["status"] == "processing" else "ready"
        source_documents_repository.update_exam_state(
            db,
            project_id=project_id,
            document_id=document_id,
            status=next_status,
            exam_item_count=len(drafts),
        )
        return {"items": drafts}
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    except ValidationError as exc:
        raise validation_error(str(exc)) from exc
    except ProviderUnavailableError as exc:
        raise api_error(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "provider_unavailable",
            str(exc),
        ) from exc


@drafts_router.post("", response_model=QuestionDraftRead, status_code=status.HTTP_201_CREATED)
def create_question_draft(
    project_id: str,
    payload: QuestionDraftCreate,
    db: Database = Depends(get_database),
) -> dict:
    try:
        return mock_exams_repository.create_draft(db, project_id, payload)
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@drafts_router.get("", response_model=QuestionDraftList)
def list_question_drafts(project_id: str, db: Database = Depends(get_database)) -> dict:
    try:
        return {"items": mock_exams_repository.list_drafts(db, project_id)}
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@drafts_router.patch("/{draft_id}", response_model=QuestionDraftRead)
def update_question_draft(
    project_id: str,
    draft_id: str,
    payload: QuestionDraftUpdate,
    db: Database = Depends(get_database),
) -> dict:
    try:
        return mock_exams_repository.update_draft(db, project_id, draft_id, payload)
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@drafts_router.post("/{draft_id}/approve", response_model=QuestionDraftRead)
def approve_question_draft(
    project_id: str,
    draft_id: str,
    db: Database = Depends(get_database),
) -> dict:
    try:
        approved = mock_exams_repository.approve_draft(db, project_id, draft_id)
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc

    if approved.get("blocked"):
        raise validation_error(
            "Draft cannot be approved without complete citation evidence.",
            {"missing": approved["missing"]},
        )
    return approved
