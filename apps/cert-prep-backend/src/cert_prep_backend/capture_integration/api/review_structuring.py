"""Structuring of a reviewed capture: preview, commit and the host's failure report."""

from __future__ import annotations

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Request,
    status,
)
from pydantic import Field

from capture_runtime_client import (
    CaptureDocument,
    CaptureStatus,
)
from cert_prep_backend.platform.dependencies import get_database
from cert_prep_backend.api.errors import not_found_error
from cert_prep_backend.platform.errors import NotFoundError, ValidationError
from cert_prep_backend.capture_integration.api.capture_event_stream import (
    capture_review_failure,
    session_or_404,
)
from cert_prep_backend.capture_integration.api.dependencies import (
    get_capture_background_work,
    get_capture_file_store,
    get_capture_operations,
    get_capture_review_events,
    get_capture_review_maintenance,
    get_capture_review_store,
    get_capture_review_workflow,
    get_capture_runtime,
    get_capture_sources,
    require_capture_coordinator,
)
from cert_prep_backend.capture_integration.api.review_lifecycle import (
    _host_operation,
    _operation_from_source,
    get_capture,
)
from cert_prep_backend.capture_integration.api.schemas import (
    CaptureReviewOperationRead,
    _ApiModel,
)
from cert_prep_backend.capture_integration.application import use_cases as capture_reviews
from cert_prep_backend.capture_integration.application.review_envelope import CaptureReview
from cert_prep_backend.capture_integration.application.errors import (
    CaptureCommitNotQueued,
    CaptureGatewayRejection,
    CaptureReviewConflict,
    CaptureReviewInputRejected,
)
from cert_prep_backend.capture_integration.application.ports import (
    CaptureBackgroundWork,
    CaptureSources,
    CaptureOperations,
    CaptureQuestionGeneration,
    CaptureReviewEvents,
    CaptureReviewMaintenance,
    CaptureReviewStore,
    CaptureReviewWorkflow,
    CaptureRuntime,
)
from cert_prep_backend.platform.database import Database


class CaptureReviewStructureRequest(_ApiModel):
    client_request_id: str = Field(min_length=1, max_length=128)
    review: CaptureReview


class CommitStructuredResultRequest(_ApiModel):
    client_request_id: str = Field(min_length=1, max_length=128)
    candidate: CaptureDocument


class ReportStructuringFailureRequest(_ApiModel):
    client_request_id: str | None = Field(default=None, min_length=1, max_length=128)
    code: str = Field(pattern=r"^[a-z][a-z0-9_]{1,63}$")
    message: str = Field(min_length=1, max_length=500)


def get_capture_question_generation(request: Request) -> CaptureQuestionGeneration:
    return request.app.state.question_generation_work


def register_structuring(router: APIRouter) -> None:
    router.post("/{capture_id}/structure", response_model=CaptureDocument)(structure_capture)
    router.post(
        "/{capture_id}/structure/commit",
        response_model=CaptureReviewOperationRead,
        status_code=status.HTTP_202_ACCEPTED,
    )(commit_capture)
    router.post(
        "/{capture_id}/structure/failure",
        response_model=CaptureReviewOperationRead,
    )(report_structuring_failure)


def structure_capture(
    request: Request,
    project_id: str,
    capture_id: str,
    structure_request: CaptureReviewStructureRequest,
    db: Database = Depends(get_database),
) -> CaptureDocument:
    require_capture_coordinator(request)
    capture_reviews.expire_capture_reviews(get_capture_review_maintenance(request))
    try:
        return capture_reviews.preview_capture_structure(
            get_capture_review_store(request),
            get_capture_operations(request),
            get_capture_runtime(request),
            project_id=project_id,
            session_id=capture_id,
            review=structure_request.review,
        )
    except NotFoundError as error:
        raise not_found_error(str(error)) from error
    except CaptureReviewConflict as error:
        # Cancellation is raised from the runtime error. The other conflicts
        # were direct responses and stay unchained.
        if error.__cause__ is None:
            raise HTTPException(status_code=409, detail=str(error))
        raise HTTPException(status_code=409, detail=str(error)) from error
    except CaptureReviewInputRejected as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except CaptureGatewayRejection as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


def commit_capture(
    request: Request,
    project_id: str,
    capture_id: str,
    commit_request: CommitStructuredResultRequest,
    db: Database = Depends(get_database),
    sources: CaptureSources = Depends(get_capture_sources),
    operations: CaptureOperations = Depends(get_capture_operations),
    sessions: CaptureReviewStore = Depends(get_capture_review_store),
    workflow: CaptureReviewWorkflow = Depends(get_capture_review_workflow),
    maintenance: CaptureReviewMaintenance = Depends(get_capture_review_maintenance),
    work: CaptureBackgroundWork = Depends(get_capture_background_work),
    events: CaptureReviewEvents = Depends(get_capture_review_events),
    questions: CaptureQuestionGeneration = Depends(get_capture_question_generation),
) -> CaptureReviewOperationRead:
    require_capture_coordinator(request)
    capture_reviews.expire_capture_reviews(maintenance)
    try:
        queued = capture_reviews.commit_capture_review(
            sessions,
            sources,
            operations,
            workflow,
            work,
            events,
            questions,
            project_id=project_id,
            session_id=capture_id,
            candidate=commit_request.candidate,
            client_request_id=commit_request.client_request_id,
        )
    except NotFoundError as error:
        raise not_found_error(str(error)) from error
    except CaptureReviewConflict as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except ValidationError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except CaptureCommitNotQueued as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    if queued.replay_completed:
        return get_capture(request, project_id, capture_id, db)
    content_length, media_type = capture_reviews.capture_source_display(
        get_capture_sources(request),
        get_capture_file_store(request),
        project_id=project_id,
        source_id=queued.source.id,
    )
    return _operation_from_source(
        capture_id,
        queued.source,
        status_value=CaptureStatus.STRUCTURING,
        progress=0.75,
        bytes_count=content_length,
        media_type=media_type,
        last_event_sequence=int(queued.last_event_sequence),
        ingestion_id=session_or_404(sessions, project_id, capture_id).runtime_ingestion_id,
    )


def report_structuring_failure(
    request: Request,
    project_id: str,
    capture_id: str,
    failure: ReportStructuringFailureRequest,
    db: Database = Depends(get_database),
    operations: CaptureOperations = Depends(get_capture_operations),
    sessions: CaptureReviewStore = Depends(get_capture_review_store),
    runtime: CaptureRuntime = Depends(get_capture_runtime),
) -> CaptureReviewOperationRead:
    require_capture_coordinator(request)
    try:
        reported = capture_reviews.report_structuring_failure(
            sessions,
            operations,
            runtime,
            project_id=project_id,
            session_id=capture_id,
            client_request_id=failure.client_request_id,
            code=failure.code,
            message=failure.message,
        )
    except NotFoundError as error:
        raise not_found_error(str(error)) from error
    except CaptureReviewConflict as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except CaptureGatewayRejection as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    if reported.replay or reported.runtime_operation is None:
        return get_capture(request, project_id, capture_id, db)
    session = session_or_404(sessions, project_id, capture_id)
    return _host_operation(
        reported.runtime_operation,
        capture_id=capture_id,
        source_id=reported.source_id,
        failure=capture_review_failure(operations, session),
    )
