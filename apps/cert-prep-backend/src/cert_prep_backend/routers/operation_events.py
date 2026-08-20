from __future__ import annotations

from dataclasses import asdict
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Path

from cert_prep_backend.api.dependencies import (
    get_database,
    get_database_change_notifier,
    get_runtime_installation_manager,
    get_streaming_draft_generation_manager,
)
from cert_prep_backend.api.errors import NotFoundError, not_found_error
from cert_prep_backend.api.sse import operation_snapshot_stream, streaming_response
from cert_prep_backend.domains.mock_exams import draft_jobs
from cert_prep_backend.domains.mock_exams.streaming import StreamingDraftGenerationManager
from cert_prep_backend.domains.runtime_installations import RuntimeInstallationManager
from cert_prep_backend.domains.source_documents import operations as document_operations
from cert_prep_backend.domains.source_documents import repository as source_documents_repository
from cert_prep_backend.persistence.change_notifications import DatabaseChangeNotifier
from cert_prep_backend.persistence.database import Database


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
    db: Database = Depends(get_database),
    notifier: DatabaseChangeNotifier = Depends(get_database_change_notifier),
):
    try:
        _document_operation_snapshot(db, project_id, operation_id)
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    return streaming_response(
        operation_snapshot_stream(
            notifier=notifier,
            snapshot=lambda: _document_operation_snapshot(db, project_id, operation_id),
            event_name="document-operation",
            is_terminal=lambda value: value["operation"]["status"]
            in {"canceled", "succeeded", "failed"},
            last_event_id=last_event_id,
        )
    )


@router.get(
    "/projects/{project_id}/documents/{document_id}/document-operation/events",
    responses=SSE_RESPONSES,
)
def current_document_operation_events(
    project_id: str,
    document_id: str,
    last_event_id: LastEventIdHeader = None,
    db: Database = Depends(get_database),
    notifier: DatabaseChangeNotifier = Depends(get_database_change_notifier),
):
    initial_operation = _active_document_operation(db, project_id, document_id)
    if initial_operation is None:
        raise not_found_error("Active document operation was not found.")
    operation_id = str(initial_operation["id"])
    _document_operation_snapshot(db, project_id, operation_id)
    return streaming_response(
        operation_snapshot_stream(
            notifier=notifier,
            snapshot=lambda: _document_operation_snapshot(
                db, project_id, operation_id
            ),
            event_name="document-operation",
            is_terminal=lambda value: value["operation"]["status"]
            in {"canceled", "succeeded", "failed"},
            last_event_id=last_event_id,
        )
    )


@router.get(
    "/projects/{project_id}/documents/{document_id}/draft-jobs/events",
    responses=SSE_RESPONSES,
)
def draft_jobs_events(
    project_id: str,
    document_id: str,
    last_event_id: LastEventIdHeader = None,
    db: Database = Depends(get_database),
    notifier: DatabaseChangeNotifier = Depends(get_database_change_notifier),
):
    try:
        _draft_jobs_snapshot(db, project_id, document_id)
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    return streaming_response(
        operation_snapshot_stream(
            notifier=notifier,
            snapshot=lambda: _draft_jobs_snapshot(db, project_id, document_id),
            event_name="draft-jobs",
            is_terminal=lambda value: _draft_jobs_terminal(value["items"]),
            last_event_id=last_event_id,
        )
    )


@router.get(
    "/projects/{project_id}/documents/{document_id}/draft-operations/{operation_id}/events",
    responses=SSE_RESPONSES,
)
def draft_operation_events(
    project_id: str,
    document_id: str,
    operation_id: OperationIdPath,
    last_event_id: LastEventIdHeader = None,
    db: Database = Depends(get_database),
    manager: StreamingDraftGenerationManager = Depends(
        get_streaming_draft_generation_manager
    ),
    notifier: DatabaseChangeNotifier = Depends(get_database_change_notifier),
):
    try:
        _manual_operation_snapshot(
            manager,
            db,
            project_id,
            document_id,
            operation_id,
        )
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    return streaming_response(
        operation_snapshot_stream(
            notifier=notifier,
            snapshot=lambda: _manual_operation_snapshot(
                manager,
                db,
                project_id,
                document_id,
                operation_id,
            ),
            event_name="draft-operation",
            is_terminal=lambda value: value["status"]
            in {"canceled", "succeeded", "failed"},
            last_event_id=last_event_id,
        )
    )


@router.get("/runtime/installations/{job_id}/events", responses=SSE_RESPONSES)
def runtime_installation_events(
    job_id: str,
    last_event_id: LastEventIdHeader = None,
    manager: RuntimeInstallationManager = Depends(get_runtime_installation_manager),
    notifier: DatabaseChangeNotifier = Depends(get_database_change_notifier),
):
    try:
        _runtime_installation_snapshot(manager, job_id)
    except KeyError as exc:
        raise not_found_error("Runtime installation job was not found.") from exc
    return streaming_response(
        operation_snapshot_stream(
            notifier=notifier,
            snapshot=lambda: _runtime_installation_snapshot(manager, job_id),
            event_name="runtime-installation",
            is_terminal=lambda value: value["status"]
            in {"canceled", "succeeded", "failed"},
            last_event_id=last_event_id,
        )
    )


@router.get("/llm/model-downloads/{job_id}/events", responses=SSE_RESPONSES)
def model_download_events(
    job_id: str,
    last_event_id: LastEventIdHeader = None,
    manager: RuntimeInstallationManager = Depends(get_runtime_installation_manager),
    notifier: DatabaseChangeNotifier = Depends(get_database_change_notifier),
):
    try:
        _model_download_snapshot(manager, job_id)
    except KeyError as exc:
        raise not_found_error("Model download job was not found.") from exc
    return streaming_response(
        operation_snapshot_stream(
            notifier=notifier,
            snapshot=lambda: _model_download_snapshot(manager, job_id),
            event_name="model-download",
            is_terminal=lambda value: value["status"]
            in {"canceled", "succeeded", "failed"},
            last_event_id=last_event_id,
        )
    )


def _document_operation_snapshot(
    db: Database,
    project_id: str,
    operation_id: str,
) -> dict:
    operation = document_operations.get_operation(
        db,
        project_id=project_id,
        operation_id=operation_id,
    )
    document = None
    if operation["document_id"] is not None:
        document = source_documents_repository.get_document(
            db,
            project_id,
            str(operation["document_id"]),
        )
    return {"operation": operation, "document": document}


def _active_document_operation(
    db: Database,
    project_id: str,
    document_id: str,
) -> dict | None:
    return document_operations.get_active_operation_for_document(
        db,
        project_id=project_id,
        document_id=document_id,
    )


def _draft_jobs_snapshot(db: Database, project_id: str, document_id: str) -> dict:
    return {"items": draft_jobs.list_document_jobs(db, project_id, document_id)}


def _manual_operation_snapshot(
    manager: StreamingDraftGenerationManager,
    db: Database,
    project_id: str,
    document_id: str,
    operation_id: str,
) -> dict:
    return manager.get_manual_operation(
        db,
        project_id=project_id,
        document_id=document_id,
        operation_id=operation_id,
    )


def _runtime_installation_snapshot(
    manager: RuntimeInstallationManager,
    job_id: str,
) -> dict:
    return asdict(manager.get_installation(job_id))


def _model_download_snapshot(
    manager: RuntimeInstallationManager,
    job_id: str,
) -> dict:
    snapshot = asdict(manager.get_installation(job_id))
    snapshot.pop("kind", None)
    return snapshot


def _draft_jobs_terminal(items: list[dict]) -> bool:
    return bool(items) and all(
        item["status"]
        in {
            "succeeded",
            "failed",
            "canceled",
            "skipped_provider_unavailable",
            "skipped_missing_model",
        }
        for item in items
    )


__all__ = ["router"]
