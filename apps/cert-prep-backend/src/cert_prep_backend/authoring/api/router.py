from __future__ import annotations

from fastapi import APIRouter, Depends, Request, status

from cert_prep_backend.ai_providers.domain.provider import LLMProvider
from cert_prep_backend.api.errors import (
    api_error,
    not_found_error,
    validation_error,
)
from cert_prep_backend.authoring.api.schemas import (
    DraftGenerateRequest,
    DraftGenerationJobList,
    DraftGenerationJobRead,
    ManualDraftGenerationOperationRead,
    QuestionDraftCreate,
    QuestionDraftList,
    QuestionDraftRead,
    QuestionDraftUpdate,
)
from cert_prep_backend.authoring.application import use_cases as authoring
from cert_prep_backend.authoring.application.ports import (
    DraftGenerationJobRepository,
    DraftGenerationWork,
    DraftSources,
    DraftWriting,
    QuestionDraftRepository,
)
from cert_prep_backend.authoring.domain.draft import DraftEdit, NewQuestionDraft, QuestionDraft
from cert_prep_backend.authoring.domain.generation import (
    DraftGenerationJob,
    DraftJobNotCancellableError,
    ManualDraftOperation,
)
from cert_prep_backend.platform.errors import (
    NotFoundError,
    ProviderUnavailableError,
    ValidationError,
)


documents_router = APIRouter(
    prefix="/projects/{project_id}/documents/{document_id}/drafts",
    tags=["question-drafts"],
)
draft_jobs_router = APIRouter(
    prefix="/projects/{project_id}/documents/{document_id}/draft-jobs",
    tags=["question-drafts"],
)
manual_operations_router = APIRouter(
    prefix="/projects/{project_id}/documents/{document_id}/draft-operations",
    tags=["question-drafts"],
)
drafts_router = APIRouter(prefix="/projects/{project_id}/question-drafts", tags=["question-drafts"])


def get_question_draft_repository(request: Request) -> QuestionDraftRepository:
    return request.app.state.question_draft_repository


def get_draft_generation_job_repository(request: Request) -> DraftGenerationJobRepository:
    return request.app.state.draft_generation_job_repository


def get_draft_generation_work(request: Request) -> DraftGenerationWork:
    return request.app.state.draft_generation_work


def get_draft_sources(request: Request) -> DraftSources:
    return request.app.state.draft_sources


def get_draft_writing(request: Request) -> DraftWriting:
    return request.app.state.draft_writing


def get_llm_provider(request: Request) -> LLMProvider:
    return request.app.state.llm_provider


@draft_jobs_router.get("", response_model=DraftGenerationJobList)
def list_document_draft_jobs(
    project_id: str,
    document_id: str,
    jobs: DraftGenerationJobRepository = Depends(get_draft_generation_job_repository),
) -> dict:
    try:
        return {"items": authoring.list_generation_jobs(jobs, project_id, document_id)}
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
    work: DraftGenerationWork = Depends(get_draft_generation_work),
) -> dict:
    try:
        return {"items": authoring.retry_generation_jobs(work, project_id, document_id)}
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@draft_jobs_router.delete("/{job_id}", response_model=DraftGenerationJobRead)
def cancel_document_draft_job(
    project_id: str,
    document_id: str,
    job_id: str,
    jobs: DraftGenerationJobRepository = Depends(get_draft_generation_job_repository),
) -> DraftGenerationJob:
    try:
        return authoring.cancel_generation_job(jobs, project_id, document_id, job_id)
    except DraftJobNotCancellableError as exc:
        raise api_error(
            status.HTTP_409_CONFLICT,
            "operation_not_cancellable",
            str(exc),
        ) from exc
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@manual_operations_router.post(
    "",
    response_model=ManualDraftGenerationOperationRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def start_manual_draft_operation(
    project_id: str,
    document_id: str,
    payload: DraftGenerateRequest,
    work: DraftGenerationWork = Depends(get_draft_generation_work),
) -> ManualDraftOperation:
    try:
        return authoring.start_manual_generation(
            work,
            project_id,
            document_id,
            limit=payload.limit,
            strategy=payload.strategy,
        )
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@manual_operations_router.get(
    "/{operation_id}",
    response_model=ManualDraftGenerationOperationRead,
)
def get_manual_draft_operation(
    project_id: str,
    document_id: str,
    operation_id: str,
    work: DraftGenerationWork = Depends(get_draft_generation_work),
) -> ManualDraftOperation:
    try:
        return authoring.view_manual_generation(work, project_id, document_id, operation_id)
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@manual_operations_router.delete(
    "/{operation_id}",
    response_model=ManualDraftGenerationOperationRead,
)
def cancel_manual_draft_operation(
    project_id: str,
    document_id: str,
    operation_id: str,
    work: DraftGenerationWork = Depends(get_draft_generation_work),
) -> ManualDraftOperation:
    try:
        return authoring.cancel_manual_generation(work, project_id, document_id, operation_id)
    except DraftJobNotCancellableError as exc:
        raise api_error(
            status.HTTP_409_CONFLICT,
            "operation_not_cancellable",
            str(exc),
        ) from exc
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@documents_router.post("", response_model=QuestionDraftList, status_code=status.HTTP_201_CREATED)
def generate_document_drafts(
    project_id: str,
    document_id: str,
    payload: DraftGenerateRequest,
    drafts: QuestionDraftRepository = Depends(get_question_draft_repository),
    sources: DraftSources = Depends(get_draft_sources),
    writing: DraftWriting = Depends(get_draft_writing),
    provider: LLMProvider = Depends(get_llm_provider),
) -> dict:
    try:
        return {
            "items": authoring.generate_document_drafts(
                drafts,
                sources,
                writing,
                provider,
                project_id=project_id,
                document_id=document_id,
                limit=payload.limit,
                strategy=payload.strategy,
            )
        }
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
    drafts: QuestionDraftRepository = Depends(get_question_draft_repository),
) -> QuestionDraft:
    try:
        return authoring.write_draft(drafts, project_id, NewQuestionDraft(**payload.model_dump()))
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    except ValidationError as exc:
        raise validation_error(str(exc)) from exc


@drafts_router.get("", response_model=QuestionDraftList)
def list_question_drafts(
    project_id: str,
    drafts: QuestionDraftRepository = Depends(get_question_draft_repository),
) -> dict:
    try:
        return {"items": authoring.list_drafts(drafts, project_id)}
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@drafts_router.patch("/{draft_id}", response_model=QuestionDraftRead)
def update_question_draft(
    project_id: str,
    draft_id: str,
    payload: QuestionDraftUpdate,
    drafts: QuestionDraftRepository = Depends(get_question_draft_repository),
) -> QuestionDraft:
    try:
        return authoring.edit_draft(drafts, project_id, draft_id, DraftEdit(**payload.model_dump()))
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
