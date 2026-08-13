"""Capture Workbench v2 streaming review and durable commit API."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from functools import partial
import json
import logging
from pathlib import Path
import re
from threading import Condition, Lock
from typing import Annotated
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

from capture_contracts import (
    CaptureBlockV1,
    CaptureDocumentV1,
    CaptureEngineV1,
    CaptureEventV2,
    CaptureFailureV2,
    CaptureOperationV2,
    CaptureReviewV1,
    CaptureSourceKind,
    PartialCaptureV2,
    RawCaptureSegmentV1,
    RawCaptureV1,
    StreamingCaptureStatus,
    StreamingEventType,
)
from cert_prep_backend.api.dependencies import (
    get_capture_coordinator,
    get_database,
    get_document_worker_pool,
    get_settings,
    get_streaming_draft_generation_manager,
)
from cert_prep_backend.api.errors import api_error, not_found_error
from cert_prep_backend.core.config import Settings
from cert_prep_backend.core.exceptions import BackendError, NotFoundError
from cert_prep_backend.domains.capture_workbench import review_sessions
from cert_prep_backend.domains.capture_workbench.client import (
    CaptureRuntimeError,
    CaptureRuntimeProtocolError,
)
from cert_prep_backend.domains.capture_workbench.coordinator import (
    CaptureRuntimeCanceledError,
    CaptureRuntimeJobError,
    CaptureRuntimeRequirementUnavailableError,
    CertPrepCaptureCoordinator,
    PDF_OCR_UNAVAILABLE_MESSAGE,
)
from cert_prep_backend.domains.capture_workbench.review import reviewed_text_overrides
from cert_prep_backend.domains.capture_workbench.review_workflow import (
    begin_capture_commit,
    begin_review_capture,
    candidate_digest,
    cleanup_expired_review_sessions,
    commit_review_capture,
)
from cert_prep_backend.domains.capture_workbench.runtime_policy import (
    SUPPORTED_RUNTIME_VERSION,
)
from cert_prep_backend.domains.projects import repository as projects_repository
from cert_prep_backend.domains.source_documents import operations
from cert_prep_backend.domains.source_documents import (
    repository as source_documents_repository,
)
from cert_prep_backend.domains.source_documents.document_worker_pool import (
    DocumentWorkItem,
    DocumentWorkerPool,
)
from cert_prep_backend.domains.source_documents.source_preparation import prepare_source
from cert_prep_backend.domains.source_documents.storage import store_source_file
from cert_prep_backend.persistence.database import Database
from cert_prep_backend.routers.documents import _read_limited_upload


router = APIRouter(
    prefix="/projects/{project_id}/capture-workbench/captures",
    tags=["capture-workbench"],
)
logger = logging.getLogger(__name__)
OperationIdHeader = Annotated[
    str | None,
    Header(alias="X-Cert-Prep-Operation-Id", min_length=1, max_length=128),
]
LastEventIdHeader = Annotated[
    str | None,
    Header(alias="Last-Event-ID", max_length=32),
]
_REGISTRY_LOCK = Lock()
_EVENT_CURSOR = re.compile(r"^-?\d+$")


class _ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class CaptureReviewStructureRequest(_ApiModel):
    client_request_id: str = Field(min_length=1, max_length=128)
    review: CaptureReviewV1


class CaptureStreamingCommitRequest(_ApiModel):
    client_request_id: str = Field(min_length=1, max_length=128)
    candidate: CaptureDocumentV1


class CaptureStreamingFailureRequest(_ApiModel):
    client_request_id: str | None = Field(default=None, min_length=1, max_length=128)
    code: str = Field(pattern=r"^[a-z][a-z0-9_]{1,63}$")
    message: str = Field(min_length=1, max_length=500)


class CaptureReviewOperationRead(CaptureOperationV2):
    """Host capture operation plus its durable Cert Prep document identity."""

    document_id: str


class CaptureStreamingResultRead(_ApiModel):
    operation: CaptureReviewOperationRead
    raw: RawCaptureV1
    result: CaptureDocumentV1


class CaptureRuntimeEventRegistry:
    """Wake SSE proxies after durable capture-session state changes."""

    _MAX_REVISION = (1 << 63) - 1

    def __init__(self) -> None:
        self._condition = Condition()
        self._revision = 0

    def publish_runtime(self, project_id: str, session_id: str, runtime_id: str) -> None:
        """Notify listeners after the runtime identity has been persisted."""

        self._publish_change()

    def publish_terminal(self, project_id: str, session_id: str, terminal: str) -> None:
        """Notify listeners after the durable session has terminalized."""

        self._publish_change()

    def revision(self) -> int:
        with self._condition:
            return self._revision

    def wait_for_change(
        self,
        observed_revision: int,
        *,
        timeout_seconds: float,
    ) -> int:
        with self._condition:
            self._condition.wait_for(
                lambda: self._revision != observed_revision,
                timeout=timeout_seconds,
            )
            return self._revision

    def _publish_change(self) -> None:
        with self._condition:
            self._revision = (
                0 if self._revision == self._MAX_REVISION else self._revision + 1
            )
            self._condition.notify_all()


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
    db: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
    workers: DocumentWorkerPool = Depends(get_document_worker_pool),
) -> CaptureReviewOperationRead:
    coordinator = get_capture_coordinator(request)
    cleanup_expired_review_sessions(db, coordinator=coordinator)
    registry = _event_registry(request)
    operation_id = operation_id_header or str(uuid4())
    try:
        projects_repository.ensure_project_exists(db, project_id)
    except NotFoundError as error:
        raise not_found_error(str(error)) from error
    claim = operations.claim_operation(
        db,
        project_id=project_id,
        operation_id=operation_id,
    )
    if not claim.acquired:
        raise HTTPException(status_code=409, detail="Document operation id is already in use.")
    session: dict | None = None
    try:
        content = await _read_limited_upload(file, settings.max_upload_bytes)
        prepared = await asyncio.to_thread(
            prepare_source,
            content,
            max_pdf_pages=settings.max_pdf_pages,
            max_image_pixels=settings.max_image_pixels,
            filename=file.filename,
        )
        if prepared.kind == "audio":
            raise HTTPException(
                status_code=422,
                detail="Capture review supports PDF and image sources only.",
            )
        sha256 = _sha256(content)
        storage_path = await asyncio.to_thread(
            store_source_file,
            settings,
            project_id,
            sha256,
            content,
            canonical_suffix=prepared.canonical_suffix,
        )
        document = operations.create_and_attach_document(
            db,
            project_id=project_id,
            operation_id=operation_id,
            filename=file.filename or f"{sha256}{prepared.canonical_suffix}",
            sha256=sha256,
            language_hint="auto",
            storage_path=str(storage_path),
            page_count=prepared.page_count,
        )
        session = review_sessions.create(
            db,
            project_id=project_id,
            document_id=document["id"],
            operation_id=operation_id,
        )
        item = DocumentWorkItem(
            operation_id=operation_id,
            run=partial(
                _run_begin,
                db=db,
                coordinator=coordinator,
                project_id=project_id,
                document_id=document["id"],
                operation_id=operation_id,
                session_id=session["id"],
                registry=registry,
                shutdown_requested=workers.is_closed,
            ),
            cancel_queued=partial(
                _cancel_queued,
                db,
                project_id=project_id,
                operation_id=operation_id,
                session_id=session["id"],
                registry=registry,
            ),
        )
        workers.submit(item)
    except Exception:
        try:
            operations.finish_failed(
                db,
                project_id=project_id,
                operation_id=operation_id,
                error="Capture review creation failed.",
            )
        except Exception:
            logger.exception(
                "Could not mark capture operation as failed",
                extra={"operation_id": operation_id},
            )
        if session is not None:
            try:
                review_sessions.finish(
                    db,
                    project_id=project_id,
                    session_id=session["id"],
                    status=review_sessions.FAILED,
                )
                registry.publish_terminal(project_id, session["id"], review_sessions.FAILED)
            except Exception:
                logger.exception(
                    "Could not mark capture review session as failed",
                    extra={"session_id": session["id"]},
                )
        raise
    return _operation_from_document(
        session["id"],
        document,
        status_value=StreamingCaptureStatus.CREATED,
        progress=0,
        bytes_count=len(content),
        media_type=_media_type(document["filename"], prepared.canonical_suffix),
    )


@router.get("/{capture_id}", response_model=CaptureReviewOperationRead)
def get_capture(
    request: Request,
    project_id: str,
    capture_id: str,
    db: Database = Depends(get_database),
) -> CaptureReviewOperationRead:
    coordinator = get_capture_coordinator(request)
    cleanup_expired_review_sessions(db, coordinator=coordinator)
    session = _session_or_404(db, project_id, capture_id)
    document = _document_or_404(db, project_id, session["document_id"])
    if session["status"] == review_sessions.CONFIRMING:
        # Runtime commit can become terminal before the durable document and
        # review session have been published atomically. The host operation is
        # still structuring throughout that window.
        return _operation_for_session(
            db,
            project_id=project_id,
            session=session,
            document=document,
        )
    runtime_id = session.get("runtime_capture_id")
    if runtime_id:
        try:
            operation = coordinator.get_capture(runtime_id)
            session = review_sessions.observe_event_sequence(
                db,
                project_id=project_id,
                session_id=capture_id,
                sequence=operation.last_event_sequence,
            )
            if session["status"] in review_sessions.ACTIVE and operation.status in {
                StreamingCaptureStatus.COMPLETED,
                StreamingCaptureStatus.FAILED,
                StreamingCaptureStatus.CANCELLED,
            }:
                return _operation_for_session(
                    db,
                    project_id=project_id,
                    session=session,
                    document=document,
                )
            expected_terminal = {
                review_sessions.COMPLETED: StreamingCaptureStatus.COMPLETED,
                review_sessions.CANCELED: StreamingCaptureStatus.CANCELLED,
                review_sessions.FAILED: StreamingCaptureStatus.FAILED,
            }.get(session["status"])
            if expected_terminal is None or operation.status is expected_terminal:
                return _host_operation(
                    operation,
                    capture_id=capture_id,
                    document_id=session["document_id"],
                )
        except Exception:
            if session["status"] in review_sessions.ACTIVE:
                raise HTTPException(
                    status_code=502,
                    detail="Capture Runtime status unavailable.",
                ) from None
    return _operation_for_session(
        db,
        project_id=project_id,
        session=session,
        document=document,
    )


@router.get("/{capture_id}/events")
def capture_events(
    request: Request,
    project_id: str,
    capture_id: str,
    last_event_id: LastEventIdHeader = None,
    db: Database = Depends(get_database),
) -> StreamingResponse:
    coordinator = get_capture_coordinator(request)
    event_cursor = _host_event_cursor(last_event_id)
    cleanup_expired_review_sessions(db, coordinator=coordinator)
    session = _session_or_404(db, project_id, capture_id)
    document = _document_or_404(db, project_id, session["document_id"])
    return StreamingResponse(
        _host_event_stream(
            coordinator=coordinator,
            registry=_event_registry(request),
            db=db,
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


@router.get("/{capture_id}/partial", response_model=PartialCaptureV2)
def get_partial(
    request: Request,
    project_id: str,
    capture_id: str,
    db: Database = Depends(get_database),
) -> PartialCaptureV2:
    coordinator = get_capture_coordinator(request)
    cleanup_expired_review_sessions(db, coordinator=coordinator)
    session = _session_or_404(db, project_id, capture_id)
    if session["status"] != review_sessions.PENDING:
        raise HTTPException(status_code=409, detail="OCR review is no longer available.")
    runtime_id = session.get("runtime_capture_id")
    if not runtime_id:
        raise HTTPException(status_code=409, detail="OCR extraction has not reached review state.")
    try:
        partial = coordinator.get_partial(runtime_id)
        return PartialCaptureV2.model_validate(
            {
                **partial.model_dump(mode="json", by_alias=True),
                "captureId": capture_id,
            }
        )
    except Exception as error:
        raise HTTPException(
            status_code=502,
            detail="Capture Runtime partial extraction unavailable.",
        ) from error


@router.post("/{capture_id}/structure", response_model=CaptureDocumentV1)
def structure_capture(
    request: Request,
    project_id: str,
    capture_id: str,
    structure_request: CaptureReviewStructureRequest,
    db: Database = Depends(get_database),
) -> CaptureDocumentV1:
    coordinator = get_capture_coordinator(request)
    cleanup_expired_review_sessions(db, coordinator=coordinator)
    session = _session_or_404(db, project_id, capture_id)
    if session["status"] != review_sessions.PENDING:
        raise HTTPException(status_code=409, detail="Capture review is no longer pending.")
    runtime_id = session.get("runtime_capture_id")
    if not runtime_id:
        raise HTTPException(status_code=409, detail="OCR extraction has not reached review state.")
    raw = coordinator.get_raw(runtime_id)
    try:
        reviewed_text_overrides(raw, structure_request.review)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    try:
        return coordinator.structure_capture(
            operation_id=session["operation_id"],
            capture_id=runtime_id,
            target_language=None,
            review=structure_request.review,
            should_cancel=lambda: not _operation_active(
                db,
                project_id,
                session["operation_id"],
            ),
        )
    except CaptureRuntimeCanceledError as error:
        raise HTTPException(status_code=409, detail="Capture review was cancelled.") from error
    except Exception as error:
        raise HTTPException(status_code=502, detail="Capture structuring failed.") from error


@router.post(
    "/{capture_id}/structure/commit",
    response_model=CaptureReviewOperationRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def commit_capture(
    request: Request,
    project_id: str,
    capture_id: str,
    commit_request: CaptureStreamingCommitRequest,
    db: Database = Depends(get_database),
    workers: DocumentWorkerPool = Depends(get_document_worker_pool),
    streaming_questions=Depends(get_streaming_draft_generation_manager),
) -> CaptureReviewOperationRead:
    coordinator = get_capture_coordinator(request)
    cleanup_expired_review_sessions(db, coordinator=coordinator)
    session = _session_or_404(db, project_id, capture_id)
    if session["status"] == review_sessions.COMPLETED:
        stored_request_id = session.get("confirm_request_id")
        if stored_request_id and (
            stored_request_id != commit_request.client_request_id
            or session.get("confirm_review_digest")
            != candidate_digest(commit_request.candidate)
        ):
            raise HTTPException(
                status_code=409,
                detail="Capture commit does not match the completed request.",
            )
        return get_capture(request, project_id, capture_id, db)
    if session["status"] not in {review_sessions.PENDING, review_sessions.CONFIRMING}:
        raise HTTPException(status_code=409, detail="Capture review is no longer pending.")
    document = _document_or_404(db, project_id, session["document_id"])
    if commit_request.candidate.source.sha256 != document["sha256"]:
        raise HTTPException(status_code=422, detail="Capture candidate source does not match.")
    try:
        claim = begin_capture_commit(
            db,
            project_id=project_id,
            document_id=session["document_id"],
            operation_id=session["operation_id"],
            session_id=capture_id,
            candidate=commit_request.candidate,
            client_request_id=commit_request.client_request_id,
        )
    except (BackendError, RuntimeError) as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    if claim.acquired:
        item = DocumentWorkItem(
            operation_id=session["operation_id"],
            run=partial(
                _run_commit,
                db=db,
                coordinator=coordinator,
                project_id=project_id,
                document_id=session["document_id"],
                operation_id=session["operation_id"],
                session_id=capture_id,
                candidate=commit_request.candidate,
                streaming_questions=streaming_questions,
                shutdown_requested=workers.is_closed,
                registry=_event_registry(request),
            ),
            cancel_queued=partial(
                _cancel_queued,
                db,
                project_id=project_id,
                operation_id=session["operation_id"],
                session_id=capture_id,
                registry=_event_registry(request),
            ),
        )
        try:
            workers.submit(item)
        except Exception as error:
            operations.finish_failed(
                db,
                project_id=project_id,
                operation_id=session["operation_id"],
                error="Capture commit could not be queued.",
            )
            review_sessions.finish(
                db,
                project_id=project_id,
                session_id=capture_id,
                status=review_sessions.FAILED,
            )
            raise HTTPException(
                status_code=503,
                detail="Capture commit could not be queued.",
            ) from error
    return _operation_from_document(
        capture_id,
        document,
        status_value=StreamingCaptureStatus.STRUCTURING,
        progress=0.75,
        bytes_count=_document_bytes(db, project_id, document["id"]),
        media_type=_document_media_type(db, project_id, document["id"]),
        last_event_sequence=int(claim.session["last_event_sequence"]),
    )


@router.post(
    "/{capture_id}/structure/failure",
    response_model=CaptureReviewOperationRead,
)
def report_structuring_failure(
    request: Request,
    project_id: str,
    capture_id: str,
    failure: CaptureStreamingFailureRequest,
    db: Database = Depends(get_database),
) -> CaptureReviewOperationRead:
    coordinator = get_capture_coordinator(request)
    session = _session_or_404(db, project_id, capture_id)
    if session["status"] not in review_sessions.ACTIVE:
        return get_capture(request, project_id, capture_id, db)
    runtime_id = session.get("runtime_capture_id")
    if not runtime_id:
        raise HTTPException(status_code=409, detail="Capture Runtime operation is not available.")
    try:
        operation = coordinator.report_structuring_failure(
            runtime_id,
            operation_id=failure.client_request_id or session["operation_id"],
            code=failure.code,
            message=failure.message,
        )
        operations.finish_failed(
            db,
            project_id=project_id,
            operation_id=session["operation_id"],
            error="Capture host structuring failed.",
        )
        review_sessions.finish(
            db,
            project_id=project_id,
            session_id=capture_id,
            status=review_sessions.FAILED,
            terminal_sequence=operation.last_event_sequence,
        )
    except Exception as error:
        raise HTTPException(
            status_code=502,
            detail="Capture structuring failure could not be confirmed.",
        ) from error
    return _host_operation(
        operation,
        capture_id=capture_id,
        document_id=session["document_id"],
    )


@router.post("/{capture_id}/cancel", response_model=CaptureReviewOperationRead)
def cancel_capture(
    request: Request,
    project_id: str,
    capture_id: str,
    db: Database = Depends(get_database),
) -> CaptureReviewOperationRead:
    coordinator = get_capture_coordinator(request)
    cleanup_expired_review_sessions(db, coordinator=coordinator)
    session = _session_or_404(db, project_id, capture_id)
    if session["status"] not in review_sessions.ACTIVE:
        return get_capture(request, project_id, capture_id, db)
    try:
        runtime_operation: CaptureOperationV2 | None = None
        operations.cancel_operation(
            db,
            project_id=project_id,
            operation_id=session["operation_id"],
        )
        runtime_id = session.get("runtime_capture_id")
        if runtime_id:
            runtime_operation = coordinator.cancel(runtime_id)
        operations.acknowledge_cancellation(
            db,
            project_id=project_id,
            operation_id=session["operation_id"],
        )
        review_sessions.finish(
            db,
            project_id=project_id,
            session_id=capture_id,
            status=review_sessions.CANCELED,
            terminal_sequence=(
                runtime_operation.last_event_sequence if runtime_operation is not None else None
            ),
        )
        _event_registry(request).publish_terminal(
            project_id,
            capture_id,
            review_sessions.CANCELED,
        )
    except Exception as error:
        raise HTTPException(
            status_code=502,
            detail="Capture cancellation could not be confirmed.",
        ) from error
    return get_capture(request, project_id, capture_id, db)


@router.get("/{capture_id}/result", response_model=CaptureStreamingResultRead)
def get_result(
    request: Request,
    project_id: str,
    capture_id: str,
    db: Database = Depends(get_database),
) -> CaptureStreamingResultRead:
    coordinator = get_capture_coordinator(request)
    cleanup_expired_review_sessions(db, coordinator=coordinator)
    session = _session_or_404(db, project_id, capture_id)
    if session["status"] != review_sessions.COMPLETED:
        raise HTTPException(status_code=409, detail="Capture review is not complete.")
    document = _document_or_404(db, project_id, session["document_id"])
    chunks = source_documents_repository.list_chunks(db, project_id, session["document_id"])
    persisted = _document_projection(db, project_id, document, chunks)
    runtime_id = session.get("runtime_capture_id")
    if runtime_id:
        try:
            runtime_result = coordinator.get_result(runtime_id)
            session = review_sessions.observe_event_sequence(
                db,
                project_id=project_id,
                session_id=capture_id,
                sequence=runtime_result.operation.last_event_sequence,
            )
            response = CaptureStreamingResultRead(
                operation=_host_operation(
                    runtime_result.operation,
                    capture_id=capture_id,
                    document_id=session["document_id"],
                ),
                raw=runtime_result.raw,
                result=persisted,
            )
            try:
                coordinator.delete(runtime_id)
            except Exception:
                pass
            return response
        except CaptureRuntimeError as error:
            if error.status_code != 404:
                raise api_error(
                    status.HTTP_502_BAD_GATEWAY,
                    "capture_runtime_result_unavailable",
                    "Capture Runtime result unavailable.",
                ) from error
        except CaptureRuntimeProtocolError as error:
            raise api_error(
                status.HTTP_502_BAD_GATEWAY,
                "capture_runtime_protocol_error",
                "Capture Runtime result violated the v2 contract.",
            ) from error
        except Exception as error:
            raise api_error(
                status.HTTP_502_BAD_GATEWAY,
                "capture_runtime_result_unavailable",
                "Capture Runtime result unavailable.",
            ) from error
    return CaptureStreamingResultRead(
        operation=_operation_from_document(
            capture_id,
            document,
            status_value=StreamingCaptureStatus.COMPLETED,
            progress=1,
            bytes_count=_document_bytes(db, project_id, document["id"]),
            media_type=_document_media_type(db, project_id, document["id"]),
            last_event_sequence=int(session["last_event_sequence"]),
        ),
        raw=_raw_projection(persisted),
        result=persisted,
    )


@router.delete("/{capture_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_capture(
    request: Request,
    project_id: str,
    capture_id: str,
    db: Database = Depends(get_database),
) -> Response:
    coordinator = get_capture_coordinator(request)
    session = _session_or_404(db, project_id, capture_id)
    if session["status"] in review_sessions.ACTIVE:
        cancel_capture(request, project_id, capture_id, db)
        session = _session_or_404(db, project_id, capture_id)
    runtime_id = session.get("runtime_capture_id")
    if runtime_id:
        try:
            coordinator.delete(runtime_id)
        except CaptureRuntimeError as error:
            if error.status_code != 404:
                raise HTTPException(
                    status_code=502,
                    detail="Capture Runtime deletion could not be confirmed.",
                ) from error
        except Exception:
            # A completed result read may already have deleted the ephemeral
            # runtime operation. The durable Cert Prep document is retained.
            pass
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _run_begin(
    *,
    db: Database,
    coordinator: CertPrepCaptureCoordinator,
    project_id: str,
    document_id: str,
    operation_id: str,
    session_id: str,
    registry: CaptureRuntimeEventRegistry,
    shutdown_requested,
) -> None:
    document = source_documents_repository.get_document(db, project_id, document_id)
    source_file = source_documents_repository.get_source_file(db, project_id, document_id)
    source_kind = _source_kind(
        source_file.filename,
        Path(source_file.storage_path).suffix,
    )
    try:
        begin_review_capture(
            db,
            coordinator=coordinator,
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
            session_id=session_id,
            file_name=document["filename"],
            content=Path(source_file.storage_path).read_bytes(),
            media_type=_media_type(document["filename"], Path(source_file.storage_path).suffix),
            source_kind=source_kind,
            should_cancel=lambda: (
                shutdown_requested()
                or not _operation_active(db, project_id, operation_id)
            ),
            on_runtime_started=lambda runtime_id: registry.publish_runtime(
                project_id,
                session_id,
                runtime_id,
            ),
        )
    except CaptureRuntimeCanceledError:
        _finish_canceled(
            db,
            project_id,
            operation_id,
            session_id,
            registry=registry,
        )
    except CaptureRuntimeRequirementUnavailableError as error:
        _finish_begin_failure(
            db,
            project_id=project_id,
            operation_id=operation_id,
            session_id=session_id,
            registry=registry,
            error=(
                PDF_OCR_UNAVAILABLE_MESSAGE
                if source_kind is CaptureSourceKind.PDF
                else str(error)
            ),
        )
    except CaptureRuntimeJobError as error:
        _finish_begin_failure(
            db,
            project_id=project_id,
            operation_id=operation_id,
            session_id=session_id,
            registry=registry,
            error=(
                PDF_OCR_UNAVAILABLE_MESSAGE
                if source_kind is CaptureSourceKind.PDF
                and error.code == "requirement_unavailable"
                else "Capture Runtime extraction failed."
            ),
            terminal_sequence=error.last_event_sequence,
        )
    except Exception:
        _finish_begin_failure(
            db,
            project_id=project_id,
            operation_id=operation_id,
            session_id=session_id,
            registry=registry,
            error="Capture Runtime extraction failed.",
        )


def _run_commit(
    *,
    db: Database,
    coordinator: CertPrepCaptureCoordinator,
    project_id: str,
    document_id: str,
    operation_id: str,
    session_id: str,
    candidate: CaptureDocumentV1,
    streaming_questions,
    shutdown_requested,
    registry: CaptureRuntimeEventRegistry,
) -> None:
    try:
        document = commit_review_capture(
            db,
            coordinator=coordinator,
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
            session_id=session_id,
            candidate=candidate,
            should_cancel=lambda: (
                shutdown_requested()
                or not _operation_active(db, project_id, operation_id)
            ),
        )
        if document["chunks_count"] > 0:
            streaming_questions.enqueue_document(
                db,
                project_id=project_id,
                document_id=document_id,
            )
    except CaptureRuntimeCanceledError:
        _finish_canceled(
            db,
            project_id,
            operation_id,
            session_id,
            registry=registry,
        )
    finally:
        try:
            session = review_sessions.get(
                db,
                project_id=project_id,
                session_id=session_id,
            )
        except Exception:
            pass
        else:
            if session["status"] not in review_sessions.ACTIVE:
                registry.publish_terminal(project_id, session_id, session["status"])


def _finish_begin_failure(
    db: Database,
    *,
    project_id: str,
    operation_id: str,
    session_id: str,
    registry: CaptureRuntimeEventRegistry,
    error: str,
    terminal_sequence: int | None = None,
) -> None:
    review_sessions.finish(
        db,
        project_id=project_id,
        session_id=session_id,
        status=review_sessions.FAILED,
        terminal_sequence=terminal_sequence,
    )
    operations.finish_failed(
        db,
        project_id=project_id,
        operation_id=operation_id,
        error=error,
    )
    registry.publish_terminal(project_id, session_id, review_sessions.FAILED)


def _cancel_queued(
    db: Database,
    *,
    project_id: str,
    operation_id: str,
    session_id: str,
    registry: CaptureRuntimeEventRegistry,
) -> None:
    try:
        operations.cancel_operation(db, project_id=project_id, operation_id=operation_id)
        operations.acknowledge_cancellation(
            db,
            project_id=project_id,
            operation_id=operation_id,
        )
    finally:
        try:
            review_sessions.finish(
                db,
                project_id=project_id,
                session_id=session_id,
                status=review_sessions.CANCELED,
            )
            registry.publish_terminal(project_id, session_id, review_sessions.CANCELED)
        except Exception:
            pass


def _finish_canceled(
    db: Database,
    project_id: str,
    operation_id: str,
    session_id: str,
    *,
    registry: CaptureRuntimeEventRegistry | None = None,
) -> None:
    try:
        operations.acknowledge_cancellation(
            db,
            project_id=project_id,
            operation_id=operation_id,
        )
    finally:
        review_sessions.finish(
            db,
            project_id=project_id,
            session_id=session_id,
            status=review_sessions.CANCELED,
        )
        if registry is not None:
            registry.publish_terminal(project_id, session_id, review_sessions.CANCELED)


def _host_event_stream(
    *,
    coordinator: CertPrepCaptureCoordinator,
    registry: CaptureRuntimeEventRegistry,
    db: Database,
    project_id: str,
    capture_id: str,
    session: dict,
    document: dict,
    last_event_id: int | None,
) -> Iterator[str]:
    runtime_id = session.get("runtime_capture_id")
    while not runtime_id and session["status"] in review_sessions.ACTIVE:
        observed_revision = registry.revision()
        session = _session_or_404(db, project_id, capture_id)
        runtime_id = session.get("runtime_capture_id")
        if runtime_id or session["status"] not in review_sessions.ACTIVE:
            break
        registry.wait_for_change(observed_revision, timeout_seconds=5)
        session = _session_or_404(db, project_id, capture_id)
        runtime_id = session.get("runtime_capture_id")
        if not runtime_id and session["status"] in review_sessions.ACTIVE:
            yield ": cert-prep waiting for runtime identity\n\n"
    if runtime_id:
        emitted = False
        try:
            for event in coordinator.capture_events(
                runtime_id,
                last_event_id=last_event_id,
            ):
                emitted = True
                session = review_sessions.observe_event_sequence(
                    db,
                    project_id=project_id,
                    session_id=capture_id,
                    sequence=event.sequence,
                )
                if event.event_type in {
                    StreamingEventType.COMPLETED,
                    StreamingEventType.FAILED,
                    StreamingEventType.CANCELLED,
                }:
                    while session["status"] in review_sessions.ACTIVE:
                        observed_revision = registry.revision()
                        session = _session_or_404(db, project_id, capture_id)
                        if session["status"] not in review_sessions.ACTIVE:
                            break
                        registry.wait_for_change(observed_revision, timeout_seconds=1)
                        session = _session_or_404(db, project_id, capture_id)
                        if session["status"] in review_sessions.ACTIVE:
                            yield ": cert-prep waiting for durable terminal state\n\n"
                    terminal = _terminal_host_event(
                        capture_id,
                        session,
                        document,
                        source_kind=_document_source_kind(
                            db,
                            project_id,
                            document["id"],
                        ),
                    )
                    if _cursor_before(last_event_id, terminal.sequence):
                        yield _encode_sse_event(terminal)
                    return
                yield _encode_sse_event(
                    CaptureEventV2.model_validate(
                        {
                            **event.model_dump(mode="json", by_alias=True),
                            "captureId": capture_id,
                            "eventId": f"{capture_id}/{event.sequence}",
                        }
                    )
                )
            return
        except GeneratorExit:
            return
        except CaptureRuntimeError as error:
            if emitted or error.status_code != 404:
                return
        except Exception:
            # Closing this listener must never mutate the runtime operation.
            return
    session = _session_or_404(db, project_id, capture_id)
    if session["status"] not in review_sessions.ACTIVE:
        event = _terminal_host_event(
            capture_id,
            session,
            document,
            source_kind=_document_source_kind(db, project_id, document["id"]),
        )
        if _cursor_before(last_event_id, event.sequence):
            yield _encode_sse_event(event)


def _terminal_host_event(
    capture_id: str,
    session: dict,
    document: dict,
    *,
    source_kind: CaptureSourceKind,
) -> CaptureEventV2:
    status_value = session["status"]
    event_type = {
        review_sessions.COMPLETED: StreamingEventType.COMPLETED,
        review_sessions.CANCELED: StreamingEventType.CANCELLED,
        review_sessions.FAILED: StreamingEventType.FAILED,
    }[status_value]
    failure = (
        CaptureFailureV2(
            code="host_capture_failed",
            message="Cert Prep capture processing failed.",
            stage="host",
            retryable=False,
        )
        if event_type is StreamingEventType.FAILED
        else None
    )
    sequence = max(1, int(session.get("last_event_sequence", 0)))
    return CaptureEventV2(
        event_id=f"{capture_id}/{sequence}",
        sequence=sequence,
        capture_id=capture_id,
        kind=source_kind,
        event_type=event_type,
        stage=event_type.value,
        progress=1,
        error=failure,
        created_at=document["updated_at"],
    )


def _encode_sse_event(event: CaptureEventV2) -> str:
    data = json.dumps(
        event.model_dump(mode="json", by_alias=True),
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return f"id: {event.sequence}\nevent: {event.event_type.value}\ndata: {data}\n\n"


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


def _cursor_before(last_event_id: int | None, sequence: int) -> bool:
    return last_event_id is None or last_event_id < sequence


def _event_registry(request: Request) -> CaptureRuntimeEventRegistry:
    registry = getattr(request.app.state, "capture_runtime_event_registry", None)
    if isinstance(registry, CaptureRuntimeEventRegistry):
        return registry
    with _REGISTRY_LOCK:
        registry = getattr(request.app.state, "capture_runtime_event_registry", None)
        if not isinstance(registry, CaptureRuntimeEventRegistry):
            registry = CaptureRuntimeEventRegistry()
            request.app.state.capture_runtime_event_registry = registry
    return registry


def _operation_for_session(
    db: Database,
    *,
    project_id: str,
    session: dict,
    document: dict,
) -> CaptureReviewOperationRead:
    status_value = {
        review_sessions.PENDING: StreamingCaptureStatus.CREATED,
        review_sessions.CONFIRMING: StreamingCaptureStatus.STRUCTURING,
        review_sessions.COMPLETED: StreamingCaptureStatus.COMPLETED,
        review_sessions.CANCELED: StreamingCaptureStatus.CANCELLED,
        review_sessions.FAILED: StreamingCaptureStatus.FAILED,
    }[session["status"]]
    progress = {
        StreamingCaptureStatus.CREATED: 0,
        StreamingCaptureStatus.STRUCTURING: 0.75,
        StreamingCaptureStatus.COMPLETED: 1,
        StreamingCaptureStatus.CANCELLED: 1,
        StreamingCaptureStatus.FAILED: 1,
    }[status_value]
    return _operation_from_document(
        session["id"],
        document,
        status_value=status_value,
        progress=progress,
        bytes_count=_document_bytes(db, project_id, document["id"]),
        media_type=_document_media_type(db, project_id, document["id"]),
        last_event_sequence=int(session["last_event_sequence"]),
    )


def _operation_from_document(
    capture_id: str,
    document: dict,
    *,
    status_value: StreamingCaptureStatus,
    progress: float,
    bytes_count: int,
    media_type: str,
    last_event_sequence: int = 0,
) -> CaptureReviewOperationRead:
    terminal = status_value in {
        StreamingCaptureStatus.COMPLETED,
        StreamingCaptureStatus.FAILED,
        StreamingCaptureStatus.CANCELLED,
    }
    failure = (
        CaptureFailureV2(
            code="host_capture_failed",
            message="Cert Prep capture processing failed.",
            stage="host",
            retryable=False,
        )
        if status_value is StreamingCaptureStatus.FAILED
        else None
    )
    return CaptureReviewOperationRead(
        capture_id=capture_id,
        ingestion_id=document["id"],
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
            "sha256": document["sha256"],
            "fileName": document["filename"],
            "mediaType": media_type,
            "bytes": max(1, bytes_count),
        },
        error=failure,
        created_at=document["created_at"],
        updated_at=document["updated_at"],
        completed_at=document["updated_at"] if terminal else None,
        document_id=document["id"],
    )


def _host_operation(
    operation: CaptureOperationV2,
    *,
    capture_id: str,
    document_id: str,
) -> CaptureReviewOperationRead:
    return CaptureReviewOperationRead.model_validate(
        {
            **operation.model_dump(mode="json", by_alias=True),
            "captureId": capture_id,
            "ingestionId": document_id,
            "documentId": document_id,
        }
    )


def _document_projection(
    db: Database,
    project_id: str,
    document: dict,
    chunks: list[dict],
) -> CaptureDocumentV1:
    segments = [
        RawCaptureSegmentV1(
            segment_id=chunk["id"],
            order=index,
            locator={"kind": "page", "page": max(1, chunk["page_number"])},
            text=(chunk["raw_text"] or chunk["text"]).strip(),
        )
        for index, chunk in enumerate(chunks)
    ]
    blocks = [
        CaptureBlockV1(
            block_id=f"cert-prep-block-{segment.segment_id}",
            order=index,
            type="paragraph",
            source_segment_id=segment.segment_id,
            locator=segment.locator,
            source_text=segment.text,
            target_text=chunks[index]["text"].strip(),
        )
        for index, segment in enumerate(segments)
    ]
    source = {
        "sha256": document["sha256"],
        "fileName": document["filename"],
        "mediaType": _document_media_type(db, project_id, document["id"]),
        "bytes": max(1, _document_bytes(db, project_id, document["id"])),
    }
    digest = f"sha256:{document['sha256']}"
    extraction = CaptureEngineV1(
        engine=document["extraction_method"] or "windowsml-ocr",
        model=f"capture-runtime@{SUPPORTED_RUNTIME_VERSION}",
        digest=digest,
        device=document["ocr_device"],
    )
    structuring = CaptureEngineV1(
        engine="cert-prep-host-structuring",
        model="cert-prep-backend",
        digest=digest,
        device=None,
    )
    return CaptureDocumentV1(
        source=source,
        raw_segments=segments,
        blocks=blocks,
        source_text="\n".join(segment.text for segment in segments),
        target_text="\n".join(block.target_text for block in blocks),
        extraction_engine=extraction,
        structuring_engine=structuring,
        warnings=(
            [document["ocr_fallback_reason"]]
            if document["ocr_fallback_reason"]
            else []
        ),
        created_at=document["created_at"],
        completed_at=document["updated_at"],
    )


def _raw_projection(document: CaptureDocumentV1) -> RawCaptureV1:
    return RawCaptureV1(
        schema_version=document.schema_version,
        diagnostic_only=True,
        source=document.source,
        segments=document.raw_segments,
        source_text=document.source_text,
        extraction_engine=document.extraction_engine,
        warnings=document.warnings,
        created_at=document.created_at,
    )


def _operation_active(db: Database, project_id: str, operation_id: str) -> bool:
    try:
        return (
            operations.get_operation(
                db,
                project_id=project_id,
                operation_id=operation_id,
            )["status"]
            == "running"
        )
    except Exception:
        return False


def _session_or_404(db: Database, project_id: str, capture_id: str) -> dict:
    try:
        return review_sessions.get(db, project_id=project_id, session_id=capture_id)
    except NotFoundError as error:
        raise not_found_error(str(error)) from error


def _document_or_404(db: Database, project_id: str, document_id: str) -> dict:
    try:
        return source_documents_repository.get_document(db, project_id, document_id)
    except NotFoundError as error:
        raise not_found_error(str(error)) from error


def _document_bytes(db: Database, project_id: str, document_id: str) -> int:
    try:
        source_file = source_documents_repository.get_source_file(
            db,
            project_id,
            document_id,
        )
        return Path(source_file.storage_path).stat().st_size
    except (OSError, KeyError):
        return 1


def _document_media_type(db: Database, project_id: str, document_id: str) -> str:
    try:
        source_file = source_documents_repository.get_source_file(
            db,
            project_id,
            document_id,
        )
        return _media_type(source_file.filename, Path(source_file.storage_path).suffix)
    except (OSError, KeyError, NotFoundError):
        return "application/octet-stream"


def _document_source_kind(
    db: Database,
    project_id: str,
    document_id: str,
) -> CaptureSourceKind:
    source_file = source_documents_repository.get_source_file(
        db,
        project_id,
        document_id,
    )
    return _source_kind(source_file.filename, Path(source_file.storage_path).suffix)


def _source_kind(
    filename: str,
    canonical_suffix: str | None = None,
) -> CaptureSourceKind:
    return (
        CaptureSourceKind.PDF
        if (canonical_suffix or Path(filename).suffix).lower() == ".pdf"
        else CaptureSourceKind.IMAGE
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


def _sha256(content: bytes) -> str:
    import hashlib

    return hashlib.sha256(content).hexdigest()


__all__ = ["CaptureRuntimeEventRegistry", "router"]
