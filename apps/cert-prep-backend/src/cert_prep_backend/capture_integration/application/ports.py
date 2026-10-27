"""What the capture review use cases need from sessions, Source Library, files, and work."""

from __future__ import annotations

from collections.abc import Callable
from typing import Protocol

from cert_prep_backend.capture_integration.application.results import (
    RuntimeCancellation,
    StructuringFailureNotice,
)
from cert_prep_backend.capture_integration.domain.review_session import (
    CaptureReviewSession,
    CaptureReviewStatus,
)
from cert_prep_backend.source_library.domain.document import SourceDocument, SourceFile
from cert_prep_backend.source_library.domain.operation import DocumentOperation


class PreparedCaptureSource(Protocol):
    """The prepared-source attributes a capture review reads. It is not PreparedSource."""

    kind: str
    canonical_suffix: str
    page_count: int


class CaptureReviewStore(Protocol):
    def get(self, *, project_id: str, session_id: str) -> CaptureReviewSession: ...

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


class CaptureReviewWorkflow(Protocol):
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
