"""Server-sent events of document operations. The stream itself is the platform's; the
snapshots and when they end are the Source Library's."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Header, Path

from cert_prep_backend.api.errors import not_found_error
from cert_prep_backend.platform.change_notifications import DatabaseChangeNotifier
from cert_prep_backend.platform.dependencies import get_database_change_notifier
from cert_prep_backend.platform.errors import NotFoundError
from cert_prep_backend.platform.sse import operation_snapshot_stream, streaming_response
from cert_prep_backend.source_library.application import use_cases as source_library
from cert_prep_backend.source_library.application.ports import (
    DocumentOperationRepository,
    DocumentRepository,
)
from cert_prep_backend.source_library.application.use_cases import OperationProgress
from cert_prep_backend.source_library.api.router import (
    get_document_operation_repository,
    get_document_repository,
)


router = APIRouter(tags=["operation-events"])
SSE_RESPONSES = {
    200: {
        "description": "Server-sent operation snapshots.",
        "content": {"text/event-stream": {}},
    }
}
OperationIdPath = Annotated[str, Path(min_length=1, max_length=128)]
LastEventIdHeader = Annotated[str | None, Header(alias="Last-Event-ID")]


@router.get(
    "/projects/{project_id}/document-operations/{operation_id}/events",
    responses=SSE_RESPONSES,
)
def document_operation_events(
    project_id: str,
    operation_id: OperationIdPath,
    last_event_id: LastEventIdHeader = None,
    operations: DocumentOperationRepository = Depends(get_document_operation_repository),
    documents: DocumentRepository = Depends(get_document_repository),
    notifier: DatabaseChangeNotifier = Depends(get_database_change_notifier),
):
    try:
        source_library.view_operation_progress(operations, documents, project_id, operation_id)
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    return _progress_stream(
        operations, documents, notifier, project_id, operation_id, last_event_id
    )


@router.get(
    "/projects/{project_id}/documents/{document_id}/document-operation/events",
    responses=SSE_RESPONSES,
)
def current_document_operation_events(
    project_id: str,
    document_id: str,
    last_event_id: LastEventIdHeader = None,
    operations: DocumentOperationRepository = Depends(get_document_operation_repository),
    documents: DocumentRepository = Depends(get_document_repository),
    notifier: DatabaseChangeNotifier = Depends(get_database_change_notifier),
):
    try:
        operation_id = source_library.view_active_operation(operations, project_id, document_id).id
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    source_library.view_operation_progress(operations, documents, project_id, operation_id)
    return _progress_stream(
        operations, documents, notifier, project_id, operation_id, last_event_id
    )


def _progress_stream(
    operations: DocumentOperationRepository,
    documents: DocumentRepository,
    notifier: DatabaseChangeNotifier,
    project_id: str,
    operation_id: str,
    last_event_id: str | None,
):
    def is_terminal(progress: OperationProgress) -> bool:
        return progress.operation.is_terminal

    return streaming_response(
        operation_snapshot_stream(
            notifier=notifier,
            snapshot=lambda: source_library.view_operation_progress(
                operations, documents, project_id, operation_id
            ),
            event_name="document-operation",
            is_terminal=is_terminal,
            last_event_id=last_event_id,
        )
    )


__all__ = ["router"]
