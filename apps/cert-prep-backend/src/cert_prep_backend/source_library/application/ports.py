"""What the Source Library use cases need from storage, stored files, translation, the
source worker pool, and the downstream contexts that extract text and write questions."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Protocol

from cert_prep_contracts.sources import SourceKind

from cert_prep_backend.source_library.domain.source import (
    SourceChunk,
    Source,
    SourceFile,
)
from cert_prep_backend.source_library.domain.operation import SourceOperation


class SourceRepository(Protocol):
    """Sources and chunks; NotFoundError when the project or source does not exist."""

    def sources_of(self, project_id: str) -> list[Source]: ...

    def source(self, project_id: str, source_id: str) -> Source: ...

    def source_file(self, project_id: str, source_id: str) -> SourceFile: ...

    def chunks_of(self, project_id: str, source_id: str) -> list[SourceChunk]: ...

    def chunk(self, project_id: str, source_id: str, chunk_id: str) -> SourceChunk:
        """One chunk of the source; NotFoundError "Source chunk not found." when the
        source has no such chunk (whether or not the source exists)."""
        ...

    def edit_chunk_text(
        self, project_id: str, source_id: str, chunk_id: str, text: str
    ) -> SourceChunk:
        """Store a transcript chunk's new text as a new revision; its translation goes stale."""
        ...

    def recover_processing(self) -> int:
        """Settle sources an app restart left marked as processing."""
        ...

    def attach_source(
        self,
        project_id: str,
        operation_id: str,
        *,
        filename: str,
        sha256: str,
        language_hint: str,
        storage_path: str,
        page_count: int,
        source_kind: SourceKind,
        duration_ms: int | None = None,
    ) -> Source:
        """Store a processing source and attach it to the upload that claimed the operation."""
        ...

    def record_question_count(
        self, project_id: str, source_id: str, *, status: str, question_count: int
    ) -> None:
        """Store the source's status and its count of questions."""
        ...


class SourceOperationRepository(Protocol):
    """Operations; each transition is stored atomically, guarded by the state it came from."""

    def operation(self, project_id: str, operation_id: str) -> SourceOperation: ...

    def active_operation_of(self, project_id: str, source_id: str) -> SourceOperation | None:
        """The queued, running or canceling operation of a source, if any."""
        ...

    def claim(self, project_id: str, operation_id: str) -> tuple[SourceOperation, bool]:
        """The operation under this id, and whether this call claimed it for a new upload."""
        ...

    def start_retry(
        self, project_id: str, source_id: str, operation_id: str
    ) -> SourceOperation:
        """Reset a retryable source and start its processing under a new operation id."""
        ...

    def fail(
        self,
        project_id: str,
        operation_id: str,
        *,
        error: str,
        source_status: str | None = None,
        extraction_method: str | None = None,
    ) -> SourceOperation: ...

    def cancel(self, project_id: str, operation_id: str) -> SourceOperation:
        """Cancel or request cancellation; an unknown id is stored as canceled before it starts."""
        ...

    def acknowledge_cancellation(
        self, project_id: str, operation_id: str
    ) -> SourceOperation: ...

    def cancel_processing_of(self, project_id: str, source_id: str) -> SourceOperation:
        """Cancel the operation processing a source."""
        ...

    def recover_interrupted(self) -> int:
        """Acknowledge requested cancellations and fail work an app restart interrupted."""
        ...


class StudyProjects(Protocol):
    """Whether a study project exists. Study Projects owns that fact (D17)."""

    def exists(self, project_id: str) -> bool: ...


class SourceQuestionJobs(Protocol):
    """Question Authoring's question generation jobs of a source. Question Authoring owns them
    (D17)."""

    def discard_unfinished(self, project_id: str, source_id: str) -> None:
        """Drop the source's jobs that have not ended; ended jobs stay as its question history."""
        ...


class PreparedUpload(Protocol):
    """What the use cases read from a validated upload."""

    raw_bytes: bytes
    kind: SourceKind
    canonical_suffix: str
    page_count: int
    duration_ms: int | None


class SourceFileStore(Protocol):
    def resolve(self, project_id: str, storage_path: str) -> Path:
        """The stored file; InvalidSourceError when it is missing or outside the project."""
        ...

    def sha256(self, source_path: Path) -> str: ...

    def prepare(
        self,
        content: bytes,
        *,
        max_pdf_pages: int,
        max_image_pixels: int,
        filename: str | None,
    ) -> PreparedUpload:
        """Validate an upload's format and limits; InvalidSourceError when it is not accepted."""
        ...

    def store(
        self, *, project_id: str, sha256: str, content: bytes, canonical_suffix: str
    ) -> str:
        """Store the original bytes and return the path recorded on the source."""
        ...

    def verified_path(self, project_id: str, storage_path: str, expected_sha256: str) -> Path:
        """The stored file, after checking its digest; InvalidSourceError otherwise."""
        ...

    def verified_content(
        self, project_id: str, storage_path: str, expected_sha256: str
    ) -> bytes:
        """The stored bytes, after checking their digest; InvalidSourceError otherwise."""
        ...


class SourceLimits(Protocol):
    """The size limits of a source, as the settings configure them."""

    max_page_source_upload_bytes: int
    max_recording_upload_bytes: int
    max_pdf_pages: int
    max_image_pixels: int


class SourceUpload(Protocol):
    """An uploaded file read in pieces, such as FastAPI's UploadFile."""

    async def read(self, size: int = -1) -> bytes: ...


class TraditionalChineseTranslator(Protocol):
    """Translate transcript text into Traditional Chinese used in Taiwan."""

    def translate(self, source_text: str, *, source_language: str) -> str: ...


class ChunkTranslator(Protocol):
    def translate_chunk(
        self, project_id: str, source_id: str, chunk_id: str
    ) -> SourceChunk: ...

    def translate_stale_chunks(self, project_id: str, source_id: str) -> list[SourceChunk]:
        """Translate every transcript chunk edited since its translation was made."""
        ...


class QueuedSourceWork(Protocol):
    def cancel(self, operation_id: str) -> bool:
        """Drop the operation's work if it is still queued; True when its cancellation was stored."""
        ...


class SourceWork(QueuedSourceWork, Protocol):
    """The source worker pool: processing runs there, one operation per item."""

    def submit(
        self,
        *,
        operation_id: str,
        run: Callable[[], object],
        cancel_queued: Callable[[], None],
    ) -> None: ...

    def is_closed(self) -> bool:
        """True once the app is shutting down; running work stops as if canceled."""
        ...


class SourceExtraction(Protocol):
    """Extracts a source's text and stores it as its chunks (Capture Integration's
    Capture Runtime, without a review).

    Errors: SourceProcessingCanceledError when should_cancel stopped it,
    CaptureRequirementUnavailable for a missing requirement, CaptureRuntimeUnavailable
    for an unreachable runtime, SourceTextNotDetected and
    SourceExtractionFailed when it ran and failed."""

    def extract(
        self,
        *,
        project_id: str,
        source_id: str,
        operation_id: str,
        file_name: str,
        content: bytes,
        canonical_suffix: str,
        source_kind: SourceKind,
        sha256: str,
        language_hint: str,
        should_cancel: Callable[[], bool],
    ) -> Source: ...


class ImportedQuestionGeneration(Protocol):
    """Starts questions for a source whose import produced chunks (Question
    Authoring)."""

    def start_question_generation(self, project_id: str, source_id: str) -> None: ...
