"""Admission of the capture review event stream; capture_event_stream produces its frames."""

from __future__ import annotations

import re
from typing import Annotated

from fastapi import (
    APIRouter,
    Depends,
    Header,
    HTTPException,
    Request,
)
from fastapi.responses import StreamingResponse

from cert_prep_backend.platform.dependencies import get_database
from cert_prep_backend.api.errors import not_found_error
from cert_prep_backend.platform.errors import NotFoundError
from cert_prep_backend.capture_integration.api.capture_event_stream import (
    event_registry,
    host_event_stream,
    session_or_404,
)
from cert_prep_backend.capture_integration.api.dependencies import (
    get_capture_operations,
    get_capture_review_maintenance,
    get_capture_review_store,
    get_capture_runtime,
    get_capture_sources,
    require_capture_coordinator,
)
from cert_prep_backend.capture_integration.application import use_cases as capture_reviews
from cert_prep_backend.capture_integration.application.ports import CaptureEventSignal
from cert_prep_backend.platform.database import Database

LastEventIdHeader = Annotated[
    str | None,
    Header(alias="Last-Event-ID", max_length=32),
]
_EVENT_CURSOR = re.compile(r"^-?\d+$")


def get_capture_event_signal(request: Request) -> CaptureEventSignal:
    return event_registry(request)


def register_events(router: APIRouter) -> None:
    router.get("/{capture_id}/events")(capture_events)


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
    sources = get_capture_sources(request)
    try:
        source = sources.source(project_id, session.source_id)
    except NotFoundError as error:
        raise not_found_error(str(error)) from error
    return StreamingResponse(
        host_event_stream(
            runtime=get_capture_runtime(request),
            sessions=sessions,
            sources=sources,
            operations=get_capture_operations(request),
            signal=get_capture_event_signal(request),
            project_id=project_id,
            capture_id=capture_id,
            session=session,
            source=source,
            last_event_id=event_cursor,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
        },
    )


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
