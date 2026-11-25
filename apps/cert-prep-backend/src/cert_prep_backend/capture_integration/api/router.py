"""Capture Workbench v2 streaming review and durable commit API."""

from __future__ import annotations

import asyncio
from pathlib import Path
import re
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import (
    APIRouter,
    Depends,
    File,
    Header,
    HTTPException,
    Request,
    Response,
    UploadFile,
    status,
)
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from capture_runtime_client import (
    CaptureBlock,
    CaptureDocument,
    CaptureEngine,
    OperationFailure,
    CaptureOperation,
    CaptureSourceKind,
    PartialCapture,
    RawCaptureSegment,
    RawCapture,
    CaptureStatus,
)
from cert_prep_backend.platform.dependencies import (
    get_database,
    get_settings,
)
from cert_prep_backend.api.errors import ApiErrorRead, api_error, not_found_error, validation_error
from cert_prep_backend.platform.config import Settings
from cert_prep_backend.platform.errors import NotFoundError, ValidationError
from cert_prep_backend.capture_integration.api.capture_event_stream import (
    CaptureRuntimeEventRegistry,
    capture_review_failure,
    event_registry,
    host_event_stream,
    session_or_404,
)
from cert_prep_backend.capture_integration.domain.review_session import (
    CaptureReviewSession,
    CaptureReviewStatus,
)
from cert_prep_backend.capture_integration.application import use_cases as capture_reviews
from cert_prep_backend.capture_integration.application.review_envelope import CaptureReview
from cert_prep_backend.capture_integration.application.errors import (
    CaptureAudioRejected,
    CaptureCommitNotQueued,
    CaptureGatewayRejection,
    CaptureOcrClosed,
    CaptureOcrMissing,
    CaptureOcrNotReady,
    CaptureOcrTransport,
    CaptureOcrUnavailable,
    CaptureResultProtocolError,
    CaptureResultUnavailable,
    CaptureReviewConflict,
    CaptureReviewInputRejected,
)
from cert_prep_backend.capture_integration.application.ports import (
    CaptureBackgroundWork,
    CaptureDocuments,
    CaptureEventSignal,
    CaptureFileStore,
    CaptureOperations,
    CaptureQuestionDrafting,
    CaptureReviewEvents,
    CaptureReviewMaintenance,
    CaptureReviewStore,
    CaptureReviewWorkflow,
    CaptureRuntime,
)
from cert_prep_backend.capture_integration.application.ocr_summary import (
    CaptureOcrSummaryRead,
)
from cert_prep_backend.projects.application.ports import ProjectRepository
from cert_prep_backend.source_library.domain.document import DocumentChunk, SourceDocument
from cert_prep_backend.platform.database import Database
from cert_prep_backend.source_library.application import use_cases as source_library
from cert_prep_backend.source_library.application.errors import SourceTooLarge


router = APIRouter(
    prefix="/projects/{project_id}/capture-reviews",
    tags=["capture-reviews"],
)
_OCR_SUMMARY_NOT_FOUND_RESPONSE = {
    "model": ApiErrorRead,
    "description": "The project-scoped capture was not found.",
}
_OCR_SUMMARY_CONFLICT_RESPONSE = {
    "model": ApiErrorRead,
    "description": "The OCR summary has not reached a stable projection.",
}
_OCR_SUMMARY_GONE_RESPONSE = {
    "model": ApiErrorRead,
    "description": "The durable capture review is closed.",
}
_OCR_SUMMARY_BAD_GATEWAY_RESPONSE = {
    "model": ApiErrorRead,
    "description": "Capture Runtime did not provide safe stable OCR evidence.",
}
_OCR_SUMMARY_UNAVAILABLE_RESPONSE = {
    "model": ApiErrorRead,
    "description": "Capture Runtime transport is unavailable.",
}
OperationIdHeader = Annotated[
    str | None,
    Header(alias="X-Cert-Prep-Operation-Id", min_length=1, max_length=128),
]
LastEventIdHeader = Annotated[
    str | None,
    Header(alias="Last-Event-ID", max_length=32),
]
_EVENT_CURSOR = re.compile(r"^-?\d+$")


class _ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


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


class CaptureReviewOperationRead(CaptureOperation):
    """Host capture operation plus its durable Cert Prep document identity."""

    document_id: str


class CaptureExtractionProvenanceRead(_ApiModel):
    status: Literal["recorded", "reconstructed"]
    engine: str
    model: str | None
    device: str | None
    runtime_version: str | None


class _RecordedExtraction(BaseModel):
    engine: CaptureEngine
    runtime_version: str


class CaptureResultRead(_ApiModel):
    operation: CaptureReviewOperationRead
    raw: RawCapture
    result: CaptureDocument
    extraction_provenance: CaptureExtractionProvenanceRead


def require_capture_coordinator(request: Request) -> None:
    """Answer 503 when this process has no Capture Runtime configured."""
    if request.app.state.capture_coordinator is None:
        raise api_error(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            code="capture_runtime_unavailable",
            message="Capture Runtime is not configured for this process.",
        )


def get_project_repository(request: Request) -> ProjectRepository:
    return request.app.state.project_repository


def get_capture_documents(request: Request) -> CaptureDocuments:
    return request.app.state.document_repository


def get_capture_operations(request: Request) -> CaptureOperations:
    return request.app.state.document_operation_repository


def get_capture_file_store(request: Request) -> CaptureFileStore:
    return request.app.state.source_file_store


def get_capture_review_store(request: Request) -> CaptureReviewStore:
    return request.app.state.capture_review_store


def get_capture_review_workflow(request: Request) -> CaptureReviewWorkflow:
    return request.app.state.capture_review_workflow


def get_capture_review_maintenance(request: Request) -> CaptureReviewMaintenance:
    return request.app.state.capture_review_maintenance


def get_capture_runtime(request: Request) -> CaptureRuntime | None:
    return request.app.state.capture_runtime


def get_capture_background_work(request: Request) -> CaptureBackgroundWork:
    return request.app.state.capture_background_work


def get_capture_review_events(request: Request) -> CaptureReviewEvents:
    return request.app.state.capture_runtime_event_registry


def get_capture_event_signal(request: Request) -> CaptureEventSignal:
    return event_registry(request)


def get_capture_question_drafting(request: Request) -> CaptureQuestionDrafting:
    return request.app.state.draft_generation_work


class _OcrRuntime:
    """OCR runtime reads, reached only after the session gates inside the use case."""

    def __init__(self, request: Request, runtime: CaptureRuntime | None) -> None:
        self._request = request
        self._runtime = runtime

    def read_operation_for_ocr(self, runtime_capture_id: str) -> object:
        return self._runtime_after_gates().read_operation_for_ocr(runtime_capture_id)

    def read_ocr_projection(self, runtime_capture_id: str) -> object:
        return self._runtime_after_gates().read_ocr_projection(runtime_capture_id)

    def _runtime_after_gates(self) -> CaptureRuntime:
        # A missing client answers 503 here, after those gates, and not with the
        # coordinator's "not configured" message.
        if self._request.app.state.capture_runtime_client is None:
            raise api_error(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                code="capture_runtime_unavailable",
                message="Capture Runtime is unavailable.",
            )
        runtime = self._runtime
        assert runtime is not None
        return runtime


@router.post(
    "",
    response_model=CaptureReviewOperationRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_capture(
    request: Request,
    project_id: str,
    file: UploadFile = File(...),
    operation_id_header: OperationIdHeader = None,
    settings: Settings = Depends(get_settings),
    projects: ProjectRepository = Depends(get_project_repository),
    documents: CaptureDocuments = Depends(get_capture_documents),
    operations: CaptureOperations = Depends(get_capture_operations),
    files: CaptureFileStore = Depends(get_capture_file_store),
    sessions: CaptureReviewStore = Depends(get_capture_review_store),
    workflow: CaptureReviewWorkflow = Depends(get_capture_review_workflow),
    maintenance: CaptureReviewMaintenance = Depends(get_capture_review_maintenance),
    work: CaptureBackgroundWork = Depends(get_capture_background_work),
    events: CaptureReviewEvents = Depends(get_capture_review_events),
) -> CaptureReviewOperationRead:
    require_capture_coordinator(request)
    capture_reviews.expire_capture_reviews(maintenance)
    operation_id = operation_id_header or str(uuid4())
    try:
        claim = capture_reviews.claim_capture_upload(
            projects,
            operations,
            project_id=project_id,
            operation_id=operation_id,
        )
    except NotFoundError as error:
        raise not_found_error(str(error)) from error
    if not claim.acquired:
        raise HTTPException(status_code=409, detail="Document operation id is already in use.")
    try:
        content = await source_library.receive_upload(file, settings.max_upload_bytes)
    except Exception as error:
        capture_reviews.abandon_capture_upload(
            sessions,
            operations,
            events,
            project_id=project_id,
            operation_id=operation_id,
            session_id=None,
        )
        if isinstance(error, SourceTooLarge):
            raise validation_error(str(error)) from error
        raise
    try:
        started = await asyncio.to_thread(
            capture_reviews.start_capture_review,
            sessions,
            documents,
            operations,
            files,
            workflow,
            work,
            events,
            project_id=project_id,
            operation_id=operation_id,
            filename=file.filename,
            content=content,
            max_pdf_pages=settings.max_pdf_pages,
            max_image_pixels=settings.max_image_pixels,
        )
    except CaptureAudioRejected as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return _operation_from_document(
        started.session.id,
        started.document,
        status_value=CaptureStatus.WAITING_INPUT,
        progress=0,
        bytes_count=started.content_length,
        media_type=_media_type(started.document.filename, started.canonical_suffix),
    )


@router.get("/{capture_id}", response_model=CaptureReviewOperationRead)
def get_capture(
    request: Request,
    project_id: str,
    capture_id: str,
    db: Database = Depends(get_database),
) -> CaptureReviewOperationRead:
    require_capture_coordinator(request)
    capture_reviews.expire_capture_reviews(get_capture_review_maintenance(request))
    try:
        viewed = capture_reviews.view_capture(
            get_capture_review_store(request),
            get_capture_documents(request),
            get_capture_operations(request),
            get_capture_runtime(request),
            project_id=project_id,
            session_id=capture_id,
        )
    except NotFoundError as error:
        raise not_found_error(str(error)) from error
    except CaptureGatewayRejection as error:
        raise HTTPException(status_code=502, detail=str(error)) from None
    documents = get_capture_documents(request)
    files = get_capture_file_store(request)
    if (
        viewed.runtime_operation is None
        or viewed.session.status is CaptureReviewStatus.FAILED
    ):
        return _operation_for_session(
            documents,
            files,
            project_id=project_id,
            session=viewed.session,
            document=viewed.document,
            operations=get_capture_operations(request),
            ingestion_id=(
                viewed.runtime_operation.ingestion_id
                if viewed.runtime_operation is not None
                else None
            ),
        )
    try:
        operation = viewed.runtime_operation
        if viewed.report_extracting:
            # The runtime awaits structuring before the host operation can
            # take the review; until then the host is still extracting.
            operation = operation.model_copy(
                update={"status": CaptureStatus.EXTRACTING}
            )
        return _host_operation(
            operation,
            capture_id=capture_id,
            document_id=viewed.session.document_id,
        )
    except Exception:
        if viewed.session.is_active:
            raise HTTPException(
                status_code=502,
                detail="Capture Runtime status unavailable.",
            ) from None
    return _operation_for_session(
        documents,
        files,
        project_id=project_id,
        session=viewed.session,
        document=viewed.document,
        operations=get_capture_operations(request),
    )


@router.get(
    "/{capture_id}/ocr-summary",
    response_model=CaptureOcrSummaryRead,
    responses={
        status.HTTP_404_NOT_FOUND: _OCR_SUMMARY_NOT_FOUND_RESPONSE,
        status.HTTP_409_CONFLICT: _OCR_SUMMARY_CONFLICT_RESPONSE,
        status.HTTP_410_GONE: _OCR_SUMMARY_GONE_RESPONSE,
        status.HTTP_502_BAD_GATEWAY: _OCR_SUMMARY_BAD_GATEWAY_RESPONSE,
        status.HTTP_503_SERVICE_UNAVAILABLE: _OCR_SUMMARY_UNAVAILABLE_RESPONSE,
    },
)
def get_capture_ocr_summary(
    request: Request,
    project_id: str,
    capture_id: str,
    db: Database = Depends(get_database),
) -> CaptureOcrSummaryRead:
    """Return stable OCR evidence without exposing diagnostic capture data."""

    try:
        return capture_reviews.view_ocr_summary(
            get_capture_review_store(request),
            _OcrRuntime(request, get_capture_runtime(request)),
            project_id=project_id,
            session_id=capture_id,
        )
    except CaptureOcrMissing:
        raise not_found_error("Capture not found.") from None
    except CaptureOcrClosed:
        raise api_error(
            status_code=status.HTTP_410_GONE,
            code="capture_closed",
            message="Capture review is closed.",
        )
    except CaptureOcrNotReady:
        raise api_error(
            status_code=status.HTTP_409_CONFLICT,
            code="ocr_summary_not_ready",
            message="OCR summary is not ready.",
        )
    except CaptureOcrUnavailable:
        raise api_error(
            status_code=status.HTTP_502_BAD_GATEWAY,
            code="capture_runtime_ocr_unavailable",
            message="Capture Runtime OCR summary is unavailable.",
        ) from None
    except CaptureOcrTransport:
        raise api_error(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            code="capture_runtime_unavailable",
            message="Capture Runtime is unavailable.",
        ) from None


@router.get("/{capture_id}/events")
def capture_events(
    request: Request,
    project_id: str,
    capture_id: str,
    last_event_id: LastEventIdHeader = None,
    db: Database = Depends(get_database),
) -> StreamingResponse:
    require_capture_coordinator(request)
    event_cursor = _host_event_cursor(last_event_id)
    capture_reviews.expire_capture_reviews(get_capture_review_maintenance(request))
    sessions = get_capture_review_store(request)
    session = session_or_404(sessions, project_id, capture_id)
    documents = get_capture_documents(request)
    try:
        document = documents.document(project_id, session.document_id)
    except NotFoundError as error:
        raise not_found_error(str(error)) from error
    return StreamingResponse(
        host_event_stream(
            runtime=get_capture_runtime(request),
            sessions=sessions,
            documents=documents,
            operations=get_capture_operations(request),
            signal=get_capture_event_signal(request),
            project_id=project_id,
            capture_id=capture_id,
            session=session,
            document=document,
            last_event_id=event_cursor,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/{capture_id}/partial", response_model=PartialCapture)
def get_partial(
    request: Request,
    project_id: str,
    capture_id: str,
    db: Database = Depends(get_database),
) -> PartialCapture:
    require_capture_coordinator(request)
    capture_reviews.expire_capture_reviews(get_capture_review_maintenance(request))
    try:
        partial = capture_reviews.view_partial_capture(
            get_capture_review_store(request),
            get_capture_runtime(request),
            project_id=project_id,
            session_id=capture_id,
        )
        return PartialCapture.model_validate(
            {
                **partial.model_dump(mode="json", by_alias=True),
                "captureId": capture_id,
            }
        )
    except NotFoundError as error:
        raise not_found_error(str(error)) from error
    except CaptureReviewConflict as error:
        raise HTTPException(status_code=409, detail=str(error))
    except Exception as error:
        raise HTTPException(
            status_code=502,
            detail="Capture Runtime partial extraction unavailable.",
        ) from error


@router.get("/{capture_id}/raw", response_model=RawCapture)
def get_raw(
    request: Request,
    project_id: str,
    capture_id: str,
    db: Database = Depends(get_database),
) -> RawCapture:
    require_capture_coordinator(request)
    capture_reviews.expire_capture_reviews(get_capture_review_maintenance(request))
    try:
        return capture_reviews.view_raw_capture(
            get_capture_review_store(request),
            get_capture_runtime(request),
            project_id=project_id,
            session_id=capture_id,
        )
    except NotFoundError as error:
        raise not_found_error(str(error)) from error
    except CaptureReviewConflict as error:
        raise HTTPException(status_code=409, detail=str(error))
    except Exception as error:
        raise HTTPException(
            status_code=502,
            detail="Capture Runtime raw extraction unavailable.",
        ) from error


@router.post("/{capture_id}/structure", response_model=CaptureDocument)
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


@router.post(
    "/{capture_id}/structure/commit",
    response_model=CaptureReviewOperationRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def commit_capture(
    request: Request,
    project_id: str,
    capture_id: str,
    commit_request: CommitStructuredResultRequest,
    db: Database = Depends(get_database),
    documents: CaptureDocuments = Depends(get_capture_documents),
    operations: CaptureOperations = Depends(get_capture_operations),
    sessions: CaptureReviewStore = Depends(get_capture_review_store),
    workflow: CaptureReviewWorkflow = Depends(get_capture_review_workflow),
    maintenance: CaptureReviewMaintenance = Depends(get_capture_review_maintenance),
    work: CaptureBackgroundWork = Depends(get_capture_background_work),
    events: CaptureReviewEvents = Depends(get_capture_review_events),
    drafts: CaptureQuestionDrafting = Depends(get_capture_question_drafting),
) -> CaptureReviewOperationRead:
    require_capture_coordinator(request)
    capture_reviews.expire_capture_reviews(maintenance)
    try:
        queued = capture_reviews.commit_capture_review(
            sessions,
            documents,
            operations,
            workflow,
            work,
            events,
            drafts,
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
        get_capture_documents(request),
        get_capture_file_store(request),
        project_id=project_id,
        document_id=queued.document.id,
    )
    return _operation_from_document(
        capture_id,
        queued.document,
        status_value=CaptureStatus.STRUCTURING,
        progress=0.75,
        bytes_count=content_length,
        media_type=media_type,
        last_event_sequence=int(queued.last_event_sequence),
        ingestion_id=session_or_404(sessions, project_id, capture_id).runtime_ingestion_id,
    )


@router.post(
    "/{capture_id}/structure/failure",
    response_model=CaptureReviewOperationRead,
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
        document_id=reported.document_id,
        failure=capture_review_failure(operations, session),
    )


@router.post("/{capture_id}/cancel", response_model=CaptureReviewOperationRead)
def cancel_capture(
    request: Request,
    project_id: str,
    capture_id: str,
    db: Database = Depends(get_database),
    operations: CaptureOperations = Depends(get_capture_operations),
    sessions: CaptureReviewStore = Depends(get_capture_review_store),
    runtime: CaptureRuntime = Depends(get_capture_runtime),
    events: CaptureReviewEvents = Depends(get_capture_review_events),
    maintenance: CaptureReviewMaintenance = Depends(get_capture_review_maintenance),
) -> CaptureReviewOperationRead:
    require_capture_coordinator(request)
    capture_reviews.expire_capture_reviews(maintenance)
    try:
        capture_reviews.cancel_capture_review(
            sessions,
            operations,
            runtime,
            events,
            project_id=project_id,
            session_id=capture_id,
        )
    except NotFoundError as error:
        raise not_found_error(str(error)) from error
    except CaptureGatewayRejection as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    return get_capture(request, project_id, capture_id, db)


@router.get("/{capture_id}/result", response_model=CaptureResultRead)
def get_result(
    request: Request,
    project_id: str,
    capture_id: str,
    db: Database = Depends(get_database),
) -> CaptureResultRead:
    require_capture_coordinator(request)
    capture_reviews.expire_capture_reviews(get_capture_review_maintenance(request))
    documents = get_capture_documents(request)
    files = get_capture_file_store(request)
    sessions = get_capture_review_store(request)
    try:
        stored = capture_reviews.load_completed_capture(
            sessions,
            documents,
            files,
            project_id=project_id,
            session_id=capture_id,
        )
    except NotFoundError as error:
        raise not_found_error(str(error)) from error
    except CaptureReviewConflict as error:
        raise HTTPException(status_code=409, detail=str(error))
    persisted, provenance = _document_projection(
        stored.document,
        stored.chunks,
        content_length=stored.content_length,
        media_type=stored.media_type,
    )
    runtime_id = stored.session.runtime_capture_id
    if runtime_id:
        runtime = get_capture_runtime(request)
        try:
            viewed = capture_reviews.read_runtime_result(
                sessions,
                runtime,
                project_id=project_id,
                session_id=capture_id,
                runtime_capture_id=runtime_id,
            )
            if viewed is not None:
                response = CaptureResultRead(
                    operation=_host_operation(
                        viewed.operation,
                        capture_id=capture_id,
                        document_id=stored.session.document_id,
                    ),
                    raw=viewed.raw,
                    result=persisted,
                    extraction_provenance=provenance,
                )
                capture_reviews.release_capture_result(
                    runtime, runtime_capture_id=runtime_id
                )
                return response
        except CaptureResultProtocolError as error:
            raise api_error(
                status.HTTP_502_BAD_GATEWAY,
                "capture_runtime_protocol_error",
                "Capture Runtime result violated the v2 contract.",
            ) from error
        except CaptureResultUnavailable as error:
            raise api_error(
                status.HTTP_502_BAD_GATEWAY,
                "capture_runtime_result_unavailable",
                "Capture Runtime result unavailable.",
            ) from error
        except Exception as error:
            raise api_error(
                status.HTTP_502_BAD_GATEWAY,
                "capture_runtime_result_unavailable",
                "Capture Runtime result unavailable.",
            ) from error
    content_length, media_type = capture_reviews.capture_source_display(
        documents,
        files,
        project_id=project_id,
        document_id=stored.document.id,
    )
    return CaptureResultRead(
        operation=_operation_from_document(
            capture_id,
            stored.document,
            status_value=CaptureStatus.COMPLETED,
            progress=1,
            bytes_count=content_length,
            media_type=media_type,
            last_event_sequence=int(stored.session.last_event_sequence),
            ingestion_id=stored.session.runtime_ingestion_id,
        ),
        raw=_raw_projection(persisted),
        result=persisted,
        extraction_provenance=provenance,
    )


@router.delete("/{capture_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_capture(
    request: Request,
    project_id: str,
    capture_id: str,
    db: Database = Depends(get_database),
    operations: CaptureOperations = Depends(get_capture_operations),
    sessions: CaptureReviewStore = Depends(get_capture_review_store),
    runtime: CaptureRuntime = Depends(get_capture_runtime),
    events: CaptureReviewEvents = Depends(get_capture_review_events),
    maintenance: CaptureReviewMaintenance = Depends(get_capture_review_maintenance),
) -> Response:
    require_capture_coordinator(request)
    session = session_or_404(sessions, project_id, capture_id)
    if session.is_active:
        cancel_capture(
            request,
            project_id,
            capture_id,
            db,
            operations,
            sessions,
            runtime,
            events,
            maintenance,
        )
        session = session_or_404(sessions, project_id, capture_id)
    try:
        capture_reviews.discard_capture_runtime(
            runtime, runtime_capture_id=session.runtime_capture_id
        )
    except CaptureGatewayRejection as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _host_event_cursor(last_event_id: str | None) -> int | None:
    if last_event_id is None or last_event_id == "":
        return None
    if _EVENT_CURSOR.fullmatch(last_event_id) is None:
        raise HTTPException(
            status_code=422,
            detail="Last-Event-ID must be a decimal integer greater than or equal to -1.",
        )
    cursor = int(last_event_id)
    if cursor < -1:
        raise HTTPException(
            status_code=422,
            detail="Last-Event-ID must be a decimal integer greater than or equal to -1.",
        )
    return cursor


def _operation_for_session(
    documents: CaptureDocuments,
    files: CaptureFileStore,
    *,
    project_id: str,
    session: CaptureReviewSession,
    document: SourceDocument,
    operations: CaptureOperations,
    ingestion_id: str | None = None,
) -> CaptureReviewOperationRead:
    status_value = {
        CaptureReviewStatus.PENDING: CaptureStatus.WAITING_INPUT,
        CaptureReviewStatus.CONFIRMING: CaptureStatus.STRUCTURING,
        CaptureReviewStatus.COMPLETED: CaptureStatus.COMPLETED,
        CaptureReviewStatus.CANCELED: CaptureStatus.CANCELLED,
        CaptureReviewStatus.FAILED: CaptureStatus.FAILED,
    }[session.status]
    progress = {
        CaptureStatus.WAITING_INPUT: 0,
        CaptureStatus.STRUCTURING: 0.75,
        CaptureStatus.COMPLETED: 1,
        CaptureStatus.CANCELLED: 1,
        CaptureStatus.FAILED: 1,
    }[status_value]
    content_length, media_type = capture_reviews.capture_source_display(
        documents,
        files,
        project_id=project_id,
        document_id=document.id,
    )
    return _operation_from_document(
        session.id,
        document,
        status_value=status_value,
        progress=progress,
        bytes_count=content_length,
        media_type=media_type,
        last_event_sequence=int(session.last_event_sequence),
        ingestion_id=ingestion_id or session.runtime_ingestion_id,
        failure=(
            capture_review_failure(operations, session)
            if status_value is CaptureStatus.FAILED
            else None
        ),
    )


def _operation_from_document(
    capture_id: str,
    document: SourceDocument,
    *,
    status_value: CaptureStatus,
    progress: float,
    bytes_count: int,
    media_type: str,
    last_event_sequence: int = 0,
    ingestion_id: str | None = None,
    failure: OperationFailure | None = None,
) -> CaptureReviewOperationRead:
    terminal = status_value in {
        CaptureStatus.COMPLETED,
        CaptureStatus.FAILED,
        CaptureStatus.CANCELLED,
    }
    return CaptureReviewOperationRead(
        capture_id=capture_id,
        ingestion_id=ingestion_id or capture_id,
        kind=(
            CaptureSourceKind.PDF
            if media_type == "application/pdf"
            else CaptureSourceKind.IMAGE
        ),
        status=status_value,
        progress=progress,
        partial_revision=0,
        last_event_sequence=last_event_sequence,
        source={
            "sha256": document.sha256,
            "fileName": document.filename,
            "mediaType": media_type,
            "bytes": max(1, bytes_count),
        },
        error=failure,
        created_at=document.created_at,
        updated_at=document.updated_at,
        completed_at=document.updated_at if terminal else None,
        document_id=document.id,
    )


def _host_operation(
    operation: CaptureOperation,
    *,
    capture_id: str,
    document_id: str,
    failure: OperationFailure | None = None,
) -> CaptureReviewOperationRead:
    payload = operation.model_dump(mode="json", by_alias=True)
    if failure is not None:
        payload["error"] = failure.model_dump(mode="json", by_alias=True)
    return CaptureReviewOperationRead.model_validate(
        {
            **payload,
            "captureId": capture_id,
            "documentId": document_id,
        }
    )


def _document_projection(
    document: SourceDocument,
    chunks: list[DocumentChunk],
    *,
    content_length: int,
    media_type: str,
) -> tuple[CaptureDocument, CaptureExtractionProvenanceRead]:
    segments = [
        RawCaptureSegment(
            segment_id=chunk.id,
            order=index,
            locator={"kind": "page", "page": max(1, chunk.page_number)},
            text=(chunk.raw_text or chunk.text).strip(),
        )
        for index, chunk in enumerate(chunks)
    ]
    blocks = [
        CaptureBlock(
            block_id=f"cert-prep-block-{segment.segment_id}",
            order=index,
            type="paragraph",
            source_segment_id=segment.segment_id,
            locator=segment.locator,
            source_text=segment.text,
            target_text=chunks[index].text.strip(),
        )
        for index, segment in enumerate(segments)
    ]
    source = {
        "sha256": document.sha256,
        "fileName": document.filename,
        "mediaType": media_type,
        "bytes": max(1, content_length),
    }
    digest = f"sha256:{document.sha256}"
    if document.extraction_provenance is not None:
        recorded = _RecordedExtraction.model_validate_json(document.extraction_provenance)
        extraction = recorded.engine
        provenance = CaptureExtractionProvenanceRead(
            status="recorded",
            engine=extraction.engine,
            model=extraction.model,
            device=extraction.device,
            runtime_version=recorded.runtime_version,
        )
    else:
        engine = (
            "text-recognition"
            if document.extraction_method == "text_recognition"
            else document.extraction_method
        )
        provenance = CaptureExtractionProvenanceRead(
            status="reconstructed",
            engine=engine,
            model=None,
            device=document.ocr_device,
            runtime_version=None,
        )
        extraction = CaptureEngine(
            engine=engine,
            model="unknown",
            digest=digest,
            device=document.ocr_device,
        )
    structuring = CaptureEngine(
        engine="cert-prep-host-structuring",
        model="cert-prep-backend",
        digest=digest,
        device=None,
    )
    return CaptureDocument(
        source=source,
        raw_segments=segments,
        blocks=blocks,
        source_text="\n".join(segment.text for segment in segments),
        target_text="\n".join(block.target_text for block in blocks),
        extraction_engine=extraction,
        structuring_engine=structuring,
        warnings=(
            [document.extraction_warnings]
            if document.extraction_warnings
            else []
        ),
        created_at=document.created_at,
        completed_at=document.updated_at,
    ), provenance


def _raw_projection(document: CaptureDocument) -> RawCapture:
    return RawCapture(
        schema_version=document.schema_version,
        diagnostic_only=True,
        source=document.source,
        segments=document.raw_segments,
        source_text=document.source_text,
        extraction_engine=document.extraction_engine,
        warnings=document.warnings,
        created_at=document.created_at,
    )


def _media_type(filename: str, canonical_suffix: str | None = None) -> str:
    suffix = (canonical_suffix or Path(filename).suffix).lower()
    return {
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
    }.get(suffix, "application/octet-stream")


__all__ = ["CaptureRuntimeEventRegistry", "router"]
