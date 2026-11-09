"""What the Source Library use cases need from storage, stored files, translation, the
document worker pool, and the downstream contexts that extract text and write drafts."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Protocol

from cert_prep_backend.source_library.domain.document import (
    DocumentChunk,
    SourceDocument,
    SourceFile,
)
from cert_prep_backend.source_library.domain.operation import DocumentOperation


class DocumentRepository(Protocol):
    """Documents and chunks; NotFoundError when the project or document does not exist."""

    def documents_of(self, project_id: str) -> list[SourceDocument]: ...

    def document(self, project_id: str, document_id: str) -> SourceDocument: ...

    def source_file(self, project_id: str, document_id: str) -> SourceFile: ...

    def chunks_of(self, project_id: str, document_id: str) -> list[DocumentChunk]: ...

    def chunk(self, project_id: str, document_id: str, chunk_id: str) -> DocumentChunk:
        """One chunk of the document; NotFoundError "Document chunk not found." when the
        document has no such chunk (whether or not the document exists)."""
        ...

    def edit_chunk_text(
        self, project_id: str, document_id: str, chunk_id: str, text: str
    ) -> DocumentChunk:
        """Store a transcript chunk's new text as a new revision; its translation goes stale."""
        ...

    def recover_processing(self) -> int:
        """Settle documents an app restart left marked as processing."""
        ...

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
        source_kind: str = "document",
        duration_ms: int | None = None,
    ) -> SourceDocument:
        """Store a processing document and attach it to the upload that claimed the operation."""
        ...

    def record_exam_state(
        self, project_id: str, document_id: str, *, status: str, exam_item_count: int
    ) -> None:
        """Store the document's status and its count of question drafts."""
        ...


class DocumentOperationRepository(Protocol):
    """Operations; each transition is stored atomically, guarded by the state it came from."""

    def operation(self, project_id: str, operation_id: str) -> DocumentOperation: ...

    def active_operation_of(self, project_id: str, document_id: str) -> DocumentOperation | None:
        """The queued, running or canceling operation of a document, if any."""
        ...

    def claim(self, project_id: str, operation_id: str) -> tuple[DocumentOperation, bool]:
        """The operation under this id, and whether this call claimed it for a new upload."""
        ...

    def start_retry(
        self, project_id: str, document_id: str, operation_id: str
    ) -> DocumentOperation:
        """Reset a retryable document and start its processing under a new operation id."""
        ...

    def fail(
        self,
        project_id: str,
        operation_id: str,
        *,
        error: str,
        document_status: str | None = None,
        extraction_method: str | None = None,
    ) -> DocumentOperation: ...

    def cancel(self, project_id: str, operation_id: str) -> DocumentOperation:
        """Cancel or request cancellation; an unknown id is stored as canceled before it starts."""
        ...

    def acknowledge_cancellation(
        self, project_id: str, operation_id: str
    ) -> DocumentOperation: ...

    def cancel_processing_of(self, project_id: str, document_id: str) -> DocumentOperation:
        """Cancel the operation processing a document."""
        ...

    def recover_interrupted(self) -> int:
        """Acknowledge requested cancellations and fail work an app restart interrupted."""
        ...


class StudyProjects(Protocol):
    """Whether a study project exists. Study Projects owns that fact (D17)."""

    def exists(self, project_id: str) -> bool: ...


class DocumentDraftJobs(Protocol):
    """Question Authoring's draft generation jobs of a document. Question Authoring owns them
    (D17)."""

    def discard_unfinished(self, project_id: str, document_id: str) -> None:
        """Drop the document's jobs that have not ended; ended jobs stay as its draft history."""
        ...


class PreparedUpload(Protocol):
    """What the use cases read from a validated upload."""

    raw_bytes: bytes
    kind: str
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
        """Store the original bytes and return the path recorded on the document."""
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

    max_upload_bytes: int
    max_audio_upload_bytes: int
    max_pdf_pages: int
    max_image_pixels: int


class SourceUpload(Protocol):
    """An uploaded file read in pieces, such as FastAPI's UploadFile."""

    async def read(self, size: int = -1) -> bytes: ...


class TraditionalChineseTranslator(Protocol):
    """Translate transcript text into Traditional Chinese used in Taiwan."""

    def translate(self, japanese: str) -> str: ...


class ChunkTranslator(Protocol):
    def translate_chunk(
        self, project_id: str, document_id: str, chunk_id: str
    ) -> DocumentChunk: ...

    def translate_stale_chunks(self, project_id: str, document_id: str) -> list[DocumentChunk]:
        """Translate every transcript chunk edited since its translation was made."""
        ...


class QueuedDocumentWork(Protocol):
    def cancel(self, operation_id: str) -> bool:
        """Drop the operation's work if it is still queued; True when its cancellation was stored."""
        ...


class DocumentWork(QueuedDocumentWork, Protocol):
    """The document worker pool: processing runs there, one operation per item."""

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
    """Extracts a document's text and stores it as its chunks (Capture Integration's
    Capture Runtime, without a review).

    Errors: DocumentProcessingCanceledError when should_cancel stopped it,
    ProviderUnavailableError when extraction cannot run, SourceTextNotDetected and
    SourceExtractionFailed when it ran and failed."""

    def extract(
        self,
        *,
        project_id: str,
        document_id: str,
        operation_id: str,
        file_name: str,
        content: bytes,
        canonical_suffix: str,
        source_kind: str,
        sha256: str,
        language_hint: str,
        should_cancel: Callable[[], bool],
    ) -> SourceDocument: ...


class ImportedDocumentDrafting(Protocol):
    """Starts question drafts for a document whose import produced chunks (Question
    Authoring)."""

    def draft_questions(self, project_id: str, document_id: str) -> None: ...
