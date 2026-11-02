"""Server-sent-event machinery for the Capture review event stream."""

from __future__ import annotations

from collections.abc import Iterator
import json
from threading import Condition, Lock

from fastapi import Request

from capture_runtime_client import (
    CaptureEvent,
    CaptureFailure,
    CaptureSourceKind,
    StreamingEventType,
)
from cert_prep_backend.api.errors import not_found_error
from cert_prep_backend.capture_integration.application import use_cases as capture_reviews
from cert_prep_backend.capture_integration.application.errors import CaptureEventStreamFailed
from cert_prep_backend.capture_integration.application.ports import (
    CaptureDocuments,
    CaptureOperations,
    CaptureReviewStore,
    CaptureRuntime,
    CaptureEventSignal,
)
from cert_prep_backend.capture_integration.domain.review_session import (
    CaptureReviewSession,
    CaptureReviewStatus,
)
from cert_prep_backend.platform.errors import NotFoundError
from cert_prep_backend.source_library.domain.document import SourceDocument

_REGISTRY_LOCK = Lock()


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

    def publish_review_ready(self, project_id: str, session_id: str) -> None:
        """Notify listeners after the host operation has entered capture review."""

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
            self._revision = 0 if self._revision == self._MAX_REVISION else self._revision + 1
            self._condition.notify_all()


def host_event_stream(
    *,
    runtime: CaptureRuntime,
    sessions: CaptureReviewStore,
    documents: CaptureDocuments,
    operations: CaptureOperations,
    signal: CaptureEventSignal,
    project_id: str,
    capture_id: str,
    session: CaptureReviewSession,
    document: SourceDocument,
    last_event_id: int | None,
) -> Iterator[str]:
    runtime_id = session.runtime_capture_id
    while not runtime_id and session.is_active:
        try:
            held = capture_reviews.hold_capture_stream(
                sessions,
                operations,
                signal,
                project_id=project_id,
                session_id=capture_id,
                hold="identity",
                timeout_seconds=5,
            )
        except NotFoundError as error:
            raise not_found_error(str(error)) from error
        session = held.session
        runtime_id = session.runtime_capture_id
        if held.waiting:
            yield ": cert-prep waiting for runtime identity\n\n"
    if runtime_id:
        emitted = False
        try:
            for event in runtime.iter_events(
                runtime_id,
                last_event_id=last_event_id,
            ):
                emitted = True
                session = capture_reviews.note_capture_event(
                    sessions,
                    project_id=project_id,
                    session_id=capture_id,
                    sequence=event.sequence,
                )
                if runtime.event_is_terminal(event):
                    while session.is_active:
                        held = capture_reviews.hold_capture_stream(
                            sessions,
                            operations,
                            signal,
                            project_id=project_id,
                            session_id=capture_id,
                            hold="terminal",
                            timeout_seconds=1,
                        )
                        session = held.session
                        if held.waiting:
                            yield ": cert-prep waiting for durable terminal state\n\n"
                    terminal = _terminal_host_event(
                        capture_id,
                        session,
                        document,
                        source_kind=_event_source_kind(
                            documents,
                            project_id=project_id,
                            document_id=document.id,
                        ),
                    )
                    if _cursor_before(last_event_id, terminal.sequence):
                        yield _encode_sse_event(terminal)
                    return
                if runtime.event_awaits_structuring(event):
                    # Clients confirm as soon as they see this stage, so hold it until
                    # the host operation can take the review.
                    while session.is_active and not capture_reviews.capture_review_ready(
                        operations, session
                    ):
                        held = capture_reviews.hold_capture_stream(
                            sessions,
                            operations,
                            signal,
                            project_id=project_id,
                            session_id=capture_id,
                            hold="review",
                            timeout_seconds=1,
                        )
                        session = held.session
                        if held.waiting:
                            yield ": cert-prep waiting for capture review\n\n"
                    if not session.is_active:
                        terminal = _terminal_host_event(
                            capture_id,
                            session,
                            document,
                            source_kind=_event_source_kind(
                                documents,
                                project_id=project_id,
                                document_id=document.id,
                            ),
                        )
                        if _cursor_before(last_event_id, terminal.sequence):
                            yield _encode_sse_event(terminal)
                        return
                yield _encode_sse_event(
                    CaptureEvent.model_validate(
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
        except CaptureEventStreamFailed as error:
            if emitted or error.status_code != 404:
                return
        except Exception:
            # Closing this listener must never mutate the runtime operation.
            return
    session = session_or_404(sessions, project_id, capture_id)
    if not session.is_active:
        event = _terminal_host_event(
            capture_id,
            session,
            document,
            source_kind=_event_source_kind(
                documents, project_id=project_id, document_id=document.id
            ),
        )
        if _cursor_before(last_event_id, event.sequence):
            yield _encode_sse_event(event)


def _event_source_kind(
    documents: CaptureDocuments, *, project_id: str, document_id: str
) -> CaptureSourceKind:
    kind = capture_reviews.capture_source_kind(
        documents, project_id=project_id, document_id=document_id
    )
    return CaptureSourceKind.PDF if kind == "pdf" else CaptureSourceKind.IMAGE


def _terminal_host_event(
    capture_id: str,
    session: CaptureReviewSession,
    document: SourceDocument,
    *,
    source_kind: CaptureSourceKind,
) -> CaptureEvent:
    status_value = session.status
    event_type = {
        CaptureReviewStatus.COMPLETED: StreamingEventType.COMPLETED,
        CaptureReviewStatus.CANCELED: StreamingEventType.CANCELLED,
        CaptureReviewStatus.FAILED: StreamingEventType.FAILED,
    }[status_value]
    failure = (
        CaptureFailure(
            code="host_capture_failed",
            message="Cert Prep capture processing failed.",
            stage="host",
            retryable=False,
        )
        if event_type is StreamingEventType.FAILED
        else None
    )
    sequence = max(1, int(session.last_event_sequence))
    return CaptureEvent(
        event_id=f"{capture_id}/{sequence}",
        sequence=sequence,
        capture_id=capture_id,
        kind=source_kind,
        event_type=event_type,
        stage=event_type.value,
        progress=1,
        error=failure,
        created_at=document.updated_at,
    )


def _encode_sse_event(event: CaptureEvent) -> str:
    data = json.dumps(
        event.model_dump(mode="json", by_alias=True),
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return f"id: {event.sequence}\nevent: {event.event_type.value}\ndata: {data}\n\n"


def _cursor_before(last_event_id: int | None, sequence: int) -> bool:
    return last_event_id is None or last_event_id < sequence


def event_registry(request: Request) -> CaptureRuntimeEventRegistry:
    registry = getattr(request.app.state, "capture_runtime_event_registry", None)
    if isinstance(registry, CaptureRuntimeEventRegistry):
        return registry
    with _REGISTRY_LOCK:
        registry = getattr(request.app.state, "capture_runtime_event_registry", None)
        if not isinstance(registry, CaptureRuntimeEventRegistry):
            registry = CaptureRuntimeEventRegistry()
            request.app.state.capture_runtime_event_registry = registry
    return registry


def session_or_404(
    sessions: CaptureReviewStore, project_id: str, capture_id: str
) -> CaptureReviewSession:
    try:
        return sessions.get(project_id=project_id, session_id=capture_id)
    except NotFoundError as error:
        raise not_found_error(str(error)) from error
