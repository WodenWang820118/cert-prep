from __future__ import annotations

from fastapi import APIRouter, Depends, Request, status

from cert_prep_backend.ai_providers.domain.provider import LLMProvider
from cert_prep_backend.api.errors import (
    api_error,
    not_found_error,
    validation_error,
)
from cert_prep_backend.authoring.api.schemas import (
    QuestionGenerateRequest,
    QuestionGenerationJobList,
    QuestionGenerationJobRead,
    ManualQuestionGenerationRead,
    QuestionCreate,
    QuestionList,
    QuestionRead,
    QuestionUpdate,
)
from cert_prep_backend.authoring.application import use_cases as authoring
from cert_prep_backend.authoring.application.ports import (
    QuestionGenerationJobRepository,
    QuestionGenerationWork,
    QuestionSources,
    QuestionWriting,
    QuestionRepository,
)
from cert_prep_backend.authoring.domain.question import QuestionEdit, NewQuestion, Question
from cert_prep_backend.authoring.domain.generation import (
    QuestionGenerationJob,
    QuestionJobNotCancellableError,
    ManualQuestionGeneration,
)
from cert_prep_backend.platform.errors import (
    NotFoundError,
    LanguageModelUnavailable,
    ValidationError,
)


sources_router = APIRouter(
    prefix="/projects/{project_id}/sources/{source_id}/questions",
    tags=["questions"],
)
question_jobs_router = APIRouter(
    prefix="/projects/{project_id}/sources/{source_id}/question-jobs",
    tags=["questions"],
)
manual_operations_router = APIRouter(
    prefix="/projects/{project_id}/sources/{source_id}/question-generations",
    tags=["questions"],
)
questions_router = APIRouter(prefix="/projects/{project_id}/questions", tags=["questions"])


def get_question_repository(request: Request) -> QuestionRepository:
    return request.app.state.question_repository


def get_question_generation_job_repository(request: Request) -> QuestionGenerationJobRepository:
    return request.app.state.question_generation_job_repository


def get_question_generation_work(request: Request) -> QuestionGenerationWork:
    return request.app.state.question_generation_work


def get_question_sources(request: Request) -> QuestionSources:
    return request.app.state.question_sources


def get_question_writing(request: Request) -> QuestionWriting:
    return request.app.state.question_writing


def get_llm_provider(request: Request) -> LLMProvider:
    return request.app.state.llm_provider


@question_jobs_router.get("", response_model=QuestionGenerationJobList)
def list_source_question_jobs(
    project_id: str,
    source_id: str,
    jobs: QuestionGenerationJobRepository = Depends(get_question_generation_job_repository),
) -> dict:
    try:
        return {"items": authoring.list_generation_jobs(jobs, project_id, source_id)}
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@question_jobs_router.post(
    "/retry",
    response_model=QuestionGenerationJobList,
    status_code=status.HTTP_202_ACCEPTED,
)
def retry_source_question_jobs(
    project_id: str,
    source_id: str,
    work: QuestionGenerationWork = Depends(get_question_generation_work),
) -> dict:
    try:
        return {"items": authoring.retry_generation_jobs(work, project_id, source_id)}
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@question_jobs_router.delete("/{job_id}", response_model=QuestionGenerationJobRead)
def cancel_source_question_job(
    project_id: str,
    source_id: str,
    job_id: str,
    jobs: QuestionGenerationJobRepository = Depends(get_question_generation_job_repository),
) -> QuestionGenerationJob:
    try:
        return authoring.cancel_generation_job(jobs, project_id, source_id, job_id)
    except QuestionJobNotCancellableError as exc:
        raise api_error(
            status.HTTP_409_CONFLICT,
            "operation_not_cancellable",
            str(exc),
        ) from exc
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@manual_operations_router.post(
    "",
    response_model=ManualQuestionGenerationRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def start_manual_question_generation(
    project_id: str,
    source_id: str,
    payload: QuestionGenerateRequest,
    work: QuestionGenerationWork = Depends(get_question_generation_work),
) -> ManualQuestionGeneration:
    try:
        return authoring.start_manual_generation(
            work,
            project_id,
            source_id,
            limit=payload.limit,
            strategy=payload.strategy,
        )
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@manual_operations_router.get(
    "/{operation_id}",
    response_model=ManualQuestionGenerationRead,
)
def get_manual_question_generation(
    project_id: str,
    source_id: str,
    operation_id: str,
    work: QuestionGenerationWork = Depends(get_question_generation_work),
) -> ManualQuestionGeneration:
    try:
        return authoring.view_manual_generation(work, project_id, source_id, operation_id)
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@manual_operations_router.delete(
    "/{operation_id}",
    response_model=ManualQuestionGenerationRead,
)
def cancel_manual_question_generation(
    project_id: str,
    source_id: str,
    operation_id: str,
    work: QuestionGenerationWork = Depends(get_question_generation_work),
) -> ManualQuestionGeneration:
    try:
        return authoring.cancel_manual_generation(work, project_id, source_id, operation_id)
    except QuestionJobNotCancellableError as exc:
        raise api_error(
            status.HTTP_409_CONFLICT,
            "operation_not_cancellable",
            str(exc),
        ) from exc
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@sources_router.post("", response_model=QuestionList, status_code=status.HTTP_201_CREATED)
def generate_source_questions(
    project_id: str,
    source_id: str,
    payload: QuestionGenerateRequest,
    questions: QuestionRepository = Depends(get_question_repository),
    sources: QuestionSources = Depends(get_question_sources),
    writing: QuestionWriting = Depends(get_question_writing),
    provider: LLMProvider = Depends(get_llm_provider),
) -> dict:
    try:
        return {
            "items": authoring.generate_source_questions(
                questions,
                sources,
                writing,
                provider,
                project_id=project_id,
                source_id=source_id,
                limit=payload.limit,
                strategy=payload.strategy,
            )
        }
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    except ValidationError as exc:
        raise validation_error(str(exc)) from exc
    except LanguageModelUnavailable as exc:
        raise api_error(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "provider_unavailable",
            str(exc),
        ) from exc


@questions_router.post("", response_model=QuestionRead, status_code=status.HTTP_201_CREATED)
def create_question(
    project_id: str,
    payload: QuestionCreate,
    questions: QuestionRepository = Depends(get_question_repository),
) -> Question:
    try:
        return authoring.write_question(questions, project_id, NewQuestion(**payload.model_dump()))
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    except ValidationError as exc:
        raise validation_error(str(exc)) from exc


@questions_router.get("", response_model=QuestionList)
def list_questions(
    project_id: str,
    questions: QuestionRepository = Depends(get_question_repository),
) -> dict:
    try:
        return {"items": authoring.list_questions(questions, project_id)}
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@questions_router.patch("/{question_id}", response_model=QuestionRead)
def update_question(
    project_id: str,
    question_id: str,
    payload: QuestionUpdate,
    questions: QuestionRepository = Depends(get_question_repository),
) -> Question:
    try:
        return authoring.edit_question(questions, project_id, question_id, QuestionEdit(**payload.model_dump()))
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
