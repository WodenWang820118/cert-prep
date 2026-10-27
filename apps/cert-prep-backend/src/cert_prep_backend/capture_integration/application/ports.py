"""What the capture use cases need from sessions, Source Library, files, work, and setup."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from typing import Protocol
from uuid import UUID

from cert_prep_backend.capture_integration.application.results import (
    RuntimeCancellation,
    StructuringFailureNotice,
)
from cert_prep_backend.capture_integration.domain.review_session import (
    CaptureReviewSession,
    CaptureReviewStatus,
)
from cert_prep_backend.source_library.domain.document import (
    DocumentChunk,
    SourceDocument,
    SourceFile,
)
from cert_prep_backend.source_library.domain.operation import DocumentOperation


class PreparedCaptureSource(Protocol):
    """The prepared-source attributes a capture review reads. It is not PreparedSource."""

    kind: str
    canonical_suffix: str
    page_count: int


class CaptureReviewStore(Protocol):
    def get(self, *, project_id: str, session_id: str) -> CaptureReviewSession: ...

    def observe(
        self, *, project_id: str, session_id: str, sequence: int
    ) -> CaptureReviewSession: ...

    def create(
        self, *, project_id: str, document_id: str, operation_id: str
    ) -> CaptureReviewSession: ...

    def finish(
        self,
        *,
        project_id: str,
        session_id: str,
        status: CaptureReviewStatus,
        terminal_sequence: int | None = None,
    ) -> CaptureReviewSession: ...


class CaptureDocuments(Protocol):
    def document(self, project_id: str, document_id: str) -> SourceDocument: ...

    def source_file(self, project_id: str, document_id: str) -> SourceFile: ...

    def chunks_of(self, project_id: str, document_id: str) -> list[DocumentChunk]: ...

    def attach_document(
        self,
        project_id: str,
        operation_id: str,
        *,
        filename: str,
        sha256: str,
        language_hint: str,
        storage_path: str,
        page_count: int,
    ) -> SourceDocument: ...


class CaptureOperations(Protocol):
    def claim_upload(self, project_id: str, operation_id: str) -> bool: ...

    def fail(self, project_id: str, operation_id: str, *, error: str) -> DocumentOperation: ...

    def cancel(self, project_id: str, operation_id: str) -> DocumentOperation: ...

    def acknowledge_cancellation(
        self, project_id: str, operation_id: str
    ) -> DocumentOperation: ...

    def operation(self, project_id: str, operation_id: str) -> DocumentOperation: ...


class CaptureFileStore(Protocol):
    def prepare(
        self,
        content: bytes,
        *,
        max_pdf_pages: int,
        max_image_pixels: int,
        filename: str | None,
    ) -> PreparedCaptureSource: ...

    def store(
        self,
        *,
        project_id: str,
        sha256: str,
        content: bytes,
        canonical_suffix: str,
    ) -> str: ...

    def read_bytes(self, storage_path: str) -> bytes: ...

    def byte_size(self, storage_path: str) -> int: ...


class CaptureReviewWorkflow(Protocol):
    def digest(self, candidate: object) -> str: ...

    def candidate_source_sha256(self, candidate: object) -> str: ...

    def claim_commit(
        self,
        *,
        project_id: str,
        document_id: str,
        operation_id: str,
        session_id: str,
        candidate: object,
        client_request_id: str,
    ) -> tuple[CaptureReviewSession, bool]: ...

    def begin_review(
        self,
        *,
        project_id: str,
        document_id: str,
        operation_id: str,
        session_id: str,
        file_name: str,
        content: bytes,
        media_type: str,
        source_kind: str,
        should_cancel: Callable[[], bool],
        on_runtime_started: Callable[[str], None],
    ) -> None: ...

    def commit_review(
        self,
        *,
        project_id: str,
        document_id: str,
        operation_id: str,
        session_id: str,
        candidate: object,
        should_cancel: Callable[[], bool],
    ) -> SourceDocument: ...


class CaptureReviewMaintenance(Protocol):
    def expire(self) -> tuple[str, ...]: ...

    def recover(self) -> tuple[str, ...]: ...


class CaptureRuntime(Protocol):
    def report_structuring_failure(
        self,
        runtime_capture_id: str,
        *,
        operation_id: str,
        code: str,
        message: str,
    ) -> StructuringFailureNotice: ...

    def cancel(self, runtime_capture_id: str) -> RuntimeCancellation: ...

    def delete(self, runtime_capture_id: str) -> None: ...

    def read_operation(self, runtime_capture_id: str) -> object: ...

    def read_partial(self, runtime_capture_id: str) -> object: ...

    def read_raw(self, runtime_capture_id: str) -> object: ...

    def read_operation_for_ocr(self, runtime_capture_id: str) -> object: ...

    def read_ocr_projection(self, runtime_capture_id: str) -> object: ...

    def fetch_result(self, runtime_capture_id: str) -> object: ...

    def release_result(self, runtime_capture_id: str) -> None: ...

    def validate_review(self, raw: object, review: object) -> None: ...

    def structure(
        self,
        *,
        operation_id: str,
        capture_id: str,
        review: object,
        should_cancel: Callable[[], bool],
    ) -> object: ...

    def status_is(self, operation: object, token: str) -> bool: ...

    def status_equals(self, operation: object, *tokens: str) -> bool: ...

    def iter_events(
        self, runtime_capture_id: str, *, last_event_id: int | None = None
    ) -> Iterator[object]: ...

    def event_is_terminal(self, event: object) -> bool: ...

    def event_awaits_structuring(self, event: object) -> bool: ...


class CaptureBackgroundWork(Protocol):
    def submit(
        self,
        *,
        operation_id: str,
        run: Callable[[], None],
        cancel_queued: Callable[[], None],
    ) -> None: ...

    def is_closed(self) -> bool: ...


class CaptureReviewEvents(Protocol):
    def publish_runtime(self, project_id: str, session_id: str, runtime_id: str) -> None: ...

    def publish_terminal(self, project_id: str, session_id: str, terminal: str) -> None: ...

    def publish_review_ready(self, project_id: str, session_id: str) -> None: ...


class CaptureEventSignal(Protocol):
    """Wakes one event stream. Waiting stays off CaptureReviewEvents."""

    def revision(self) -> int: ...

    def wait_for_change(self, observed: int, *, timeout_seconds: float) -> int: ...


class CaptureQuestionDrafting(Protocol):
    def enqueue_document(self, project_id: str, document_id: str) -> None: ...


class CaptureRuntimeSetup(Protocol):
    """Setup calls on Capture Runtime. Results stay opaque to the use cases."""

    def handshake(self) -> object: ...

    def provenance(self) -> object: ...

    def requirements(self) -> object: ...

    def start_installation(
        self, requirement_id: str, *, idempotency_key: UUID
    ) -> object: ...

    def installations(self) -> object: ...

    def installation(self, installation_id: str) -> object: ...

    def cancel_installation(self, installation_id: str) -> object: ...
