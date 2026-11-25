"""Server-sent events of question generation. The stream itself is the platform's; the snapshots
and when they end are Question Authoring's."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Header, Path

from cert_prep_backend.api.errors import not_found_error
from cert_prep_backend.authoring.api.router import (
    get_question_generation_job_repository,
    get_question_generation_work,
)
from cert_prep_backend.authoring.application import use_cases as authoring
from cert_prep_backend.authoring.application.ports import (
    QuestionGenerationJobRepository,
    QuestionGenerationWork,
)
from cert_prep_backend.authoring.domain.generation import (
    QuestionGenerationJob,
    ManualQuestionGeneration,
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
    "/projects/{project_id}/documents/{document_id}/question-jobs/events",
    responses=SSE_RESPONSES,
)
def question_jobs_events(
    project_id: str,
    document_id: str,
    last_event_id: LastEventIdHeader = None,
    jobs: QuestionGenerationJobRepository = Depends(get_question_generation_job_repository),
    notifier: DatabaseChangeNotifier = Depends(get_database_change_notifier),
):
    def snapshot() -> dict[str, list[QuestionGenerationJob]]:
        return {"items": authoring.list_generation_jobs(jobs, project_id, document_id)}

    try:
        snapshot()
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    return streaming_response(
        operation_snapshot_stream(
            notifier=notifier,
            snapshot=snapshot,
            event_name="question-jobs",
            is_terminal=lambda value: all_jobs_ended(value["items"]),
            last_event_id=last_event_id,
        )
    )


@router.get(
    "/projects/{project_id}/documents/{document_id}/question-generations/{operation_id}/events",
    responses=SSE_RESPONSES,
)
def question_generation_events(
    project_id: str,
    document_id: str,
    operation_id: OperationIdPath,
    last_event_id: LastEventIdHeader = None,
    work: QuestionGenerationWork = Depends(get_question_generation_work),
    notifier: DatabaseChangeNotifier = Depends(get_database_change_notifier),
):
    def snapshot() -> ManualQuestionGeneration:
        return authoring.view_manual_generation(work, project_id, document_id, operation_id)

    try:
        snapshot()
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    return streaming_response(
        operation_snapshot_stream(
            notifier=notifier,
            snapshot=snapshot,
            event_name="question-generation",
            is_terminal=lambda value: value.is_terminal,
            last_event_id=last_event_id,
        )
    )


__all__ = ["router"]
