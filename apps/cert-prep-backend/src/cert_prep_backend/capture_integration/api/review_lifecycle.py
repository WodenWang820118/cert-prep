"""Capture review status, cancellation and discard, and the host operation projections.

The projections turn a durable review or a runtime operation into the host operation that
upload, structuring and results answer with as well.
"""

from __future__ import annotations

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Request,
    Response,
    status,
)

from capture_runtime_client import (
    OperationFailure,
    CaptureOperation,
    CaptureStatus,
)
from cert_prep_backend.capture_integration.source_kind import to_capture_source_kind
from cert_prep_backend.platform.dependencies import get_database
from cert_prep_backend.api.errors import not_found_error
from cert_prep_backend.platform.errors import NotFoundError
from cert_prep_backend.capture_integration.api.capture_event_stream import (
    capture_review_failure,
    session_or_404,
)
from cert_prep_backend.capture_integration.api.dependencies import (
    get_capture_file_store,
    get_capture_operations,
    get_capture_review_events,
    get_capture_review_maintenance,
    get_capture_review_store,
    get_capture_runtime,
    get_capture_sources,
    require_capture_coordinator,
)
from cert_prep_backend.capture_integration.api.schemas import CaptureReviewOperationRead
from cert_prep_backend.capture_integration.domain.review_session import (
    CaptureReviewSession,
    CaptureReviewStatus,
)
from cert_prep_backend.capture_integration.application import use_cases as capture_reviews
from cert_prep_backend.capture_integration.application.errors import CaptureGatewayRejection
from cert_prep_backend.capture_integration.application.ports import (
    CaptureSources,
    CaptureFileStore,
    CaptureOperations,
    CaptureReviewEvents,
    CaptureReviewMaintenance,
    CaptureReviewStore,
    CaptureRuntime,
)
from cert_prep_backend.source_library.domain.source import Source
from cert_prep_backend.platform.database import Database


def register_status(router: APIRouter) -> None:
    router.get("/{capture_id}", response_model=CaptureReviewOperationRead)(get_capture)


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
            get_capture_sources(request),
            get_capture_operations(request),
            get_capture_runtime(request),
            project_id=project_id,
            session_id=capture_id,
        )
    except NotFoundError as error:
        raise not_found_error(str(error)) from error
    except CaptureGatewayRejection as error:
        raise HTTPException(status_code=502, detail=str(error)) from None
    sources = get_capture_sources(request)
    files = get_capture_file_store(request)
    if (
        viewed.runtime_operation is None
        or viewed.session.status is CaptureReviewStatus.FAILED
    ):
        return _operation_for_session(
            sources,
            files,
            project_id=project_id,
            session=viewed.session,
            source=viewed.source,
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
            source_id=viewed.session.source_id,
        )
    except Exception:
        if viewed.session.is_active:
            raise HTTPException(
                status_code=502,
                detail="Capture Runtime status unavailable.",
            ) from None
    return _operation_for_session(
        sources,
        files,
        project_id=project_id,
        session=viewed.session,
        source=viewed.source,
        operations=get_capture_operations(request),
    )


def register_cancellation(router: APIRouter) -> None:
    router.post("/{capture_id}/cancel", response_model=CaptureReviewOperationRead)(
        cancel_capture
    )


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


def register_discard(router: APIRouter) -> None:
    router.delete("/{capture_id}", status_code=status.HTTP_204_NO_CONTENT)(delete_capture)


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


def _operation_for_session(
    sources: CaptureSources,
    files: CaptureFileStore,
    *,
    project_id: str,
    session: CaptureReviewSession,
    source: Source,
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
        sources,
        files,
        project_id=project_id,
        source_id=source.id,
    )
    return _operation_from_source(
        session.id,
        source,
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


def _operation_from_source(
    capture_id: str,
    source: Source,
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
        kind=to_capture_source_kind(source.source_kind),
        status=status_value,
        progress=progress,
        partial_revision=0,
        last_event_sequence=last_event_sequence,
        source={
            "sha256": source.sha256,
            "fileName": source.filename,
            "mediaType": media_type,
            "bytes": max(1, bytes_count),
        },
        error=failure,
        created_at=source.created_at,
        updated_at=source.updated_at,
        completed_at=source.updated_at if terminal else None,
        source_id=source.id,
    )


def _host_operation(
    operation: CaptureOperation,
    *,
    capture_id: str,
    source_id: str,
    failure: OperationFailure | None = None,
) -> CaptureReviewOperationRead:
    payload = operation.model_dump(mode="json", by_alias=True)
    if failure is not None:
        payload["error"] = failure.model_dump(mode="json", by_alias=True)
    return CaptureReviewOperationRead.model_validate(
        {
            **payload,
            "captureId": capture_id,
            "sourceId": source_id,
        }
    )
