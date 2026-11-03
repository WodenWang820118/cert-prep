"""Server-sent events of draft generation. The stream itself is the platform's; the snapshots
and when they end are Question Authoring's."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Header, Path

from cert_prep_backend.api.errors import not_found_error
from cert_prep_backend.authoring.api.router import (
    get_draft_generation_job_repository,
    get_draft_generation_work,
)
from cert_prep_backend.authoring.application import use_cases as authoring
from cert_prep_backend.authoring.application.ports import (
    DraftGenerationJobRepository,
    DraftGenerationWork,
)
from cert_prep_backend.authoring.domain.generation import (
    DraftGenerationJob,
    ManualDraftOperation,
    all_jobs_ended,
)
from cert_prep_backend.platform.change_notifications import DatabaseChangeNotifier
from cert_prep_backend.platform.dependencies import get_database_change_notifier
from cert_prep_backend.platform.errors import NotFoundError
from cert_prep_backend.platform.sse import operation_snapshot_stream, streaming_response


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
    "/projects/{project_id}/documents/{document_id}/draft-jobs/events",
    responses=SSE_RESPONSES,
)
def draft_jobs_events(
    project_id: str,
    document_id: str,
    last_event_id: LastEventIdHeader = None,
    jobs: DraftGenerationJobRepository = Depends(get_draft_generation_job_repository),
    notifier: DatabaseChangeNotifier = Depends(get_database_change_notifier),
):
    def snapshot() -> dict[str, list[DraftGenerationJob]]:
        return {"items": authoring.list_generation_jobs(jobs, project_id, document_id)}

    try:
        snapshot()
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    return streaming_response(
        operation_snapshot_stream(
            notifier=notifier,
            snapshot=snapshot,
            event_name="draft-jobs",
            is_terminal=lambda value: all_jobs_ended(value["items"]),
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
    work: DraftGenerationWork = Depends(get_draft_generation_work),
    notifier: DatabaseChangeNotifier = Depends(get_database_change_notifier),
):
    def snapshot() -> ManualDraftOperation:
        return authoring.view_manual_generation(work, project_id, document_id, operation_id)

    try:
        snapshot()
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    return streaming_response(
        operation_snapshot_stream(
            notifier=notifier,
            snapshot=snapshot,
            event_name="draft-operation",
            is_terminal=lambda value: value.is_terminal,
            last_event_id=last_event_id,
        )
    )


__all__ = ["router"]
