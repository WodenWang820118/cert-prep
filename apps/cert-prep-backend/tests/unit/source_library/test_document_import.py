"""Importing a document without a capture review: which failures fail its operation, how an
upload id already in use is refused, and how extraction and drafting finish the run."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, replace

import pytest

from cert_prep_backend.platform.errors import (
    DocumentOperationConflictError,
    DocumentProcessingCanceledError,
    NotFoundError,
)
from cert_prep_backend.source_library.application import use_cases
from cert_prep_backend.source_library.application.errors import (
    SourceExtractionFailed,
    SourceTextNotDetected,
    SourceTooLarge,
)
from cert_prep_backend.source_library.domain.document import (
    SourceDocument,
    language_hint_or_auto,
    upload_size_limit,
)
from cert_prep_backend.source_library.domain.operation import DocumentOperation
from cert_prep_backend.source_library.domain.statuses import (
    DocumentOperationPhase as Phase,
    DocumentOperationStatus as Status,
    SourceDocumentStatus,
)

NOW = "2026-11-03T00:00:00+00:00"


def _document(**changes: object) -> SourceDocument:
    document = SourceDocument(
        id="document",
        project_id="project",
        filename="notes.pdf",
        sha256="abc",
        language_hint="ja",
        page_count=1,
        has_text=True,
        status=SourceDocumentStatus.PROCESSING,
        extraction_method="none",
        ocr_device=None,
        ocr_fallback_reason=None,
        ocr_duration_ms=0,
        processed_page_count=0,
        parse_wall_duration_ms=0,
        render_duration_ms=0,
        ocr_engine_duration_ms=0,
        ocr_worker_count=0,
        first_chunk_ms=0,
        exam_item_count=0,
        content_profile="unknown",
        classification_detail="",
        chunks_count=0,
        created_at=NOW,
        updated_at=NOW,
    )
    return replace(document, **changes)


class FakeUpload:
    def __init__(self, content: bytes) -> None:
        self._content = content

    async def read(self, size: int = -1) -> bytes:
        piece, self._content = self._content[:size], self._content[size:]
        return piece


class FakeProjects:
    def get(self, project_id: str) -> object | None:
        return object() if project_id == "project" else None


class FakeOperations:
    def __init__(self, *, claimed: bool = True, existing_status: Status = Status.QUEUED) -> None:
        self.current = DocumentOperation.claim_upload(
            operation_id="operation", project_id="project", now=NOW
        )
        if not claimed:
            self.current = replace(self.current, status=existing_status)
        self._claimed = claimed
        self.failures: list[dict] = []
        self.calls: list[str] = []

    def claim(self, project_id: str, operation_id: str) -> tuple[DocumentOperation, bool]:
        return self.current, self._claimed

    def operation(self, project_id: str, operation_id: str) -> DocumentOperation:
        return self.current

    def fail(self, project_id: str, operation_id: str, **failure: object) -> DocumentOperation:
        self.failures.append(failure)
        self.current = replace(self.current, status=Status.FAILED, cancellable=False)
        return self.current

    def acknowledge_cancellation(self, project_id: str, operation_id: str) -> DocumentOperation:
        self.calls.append("acknowledge_cancellation")
        return self.current

    def cancel(self, project_id: str, operation_id: str) -> DocumentOperation:
        self.calls.append("cancel")
        return self.current


class FakeDocuments:
    def __init__(self, operations: FakeOperations) -> None:
        self._operations = operations
        self.stored = _document()
        self.attached: dict | None = None

    def attach_document(self, project_id: str, operation_id: str, **values: object) -> SourceDocument:
        self.attached = values
        self.stored = replace(self.stored, filename=str(values["filename"]))
        self._operations.current = self._operations.current.attach_document("document", NOW)
        return self.stored

    def document(self, project_id: str, document_id: str) -> SourceDocument:
        return self.stored


@dataclass(frozen=True)
class Prepared:
    raw_bytes: bytes
    kind: str = "pdf"
    canonical_suffix: str = ".pdf"
    page_count: int = 1
    duration_ms: int | None = None


class FakeFiles:
    def prepare(self, content: bytes, **limits: object) -> Prepared:
        return Prepared(raw_bytes=content)

    def store(self, *, project_id: str, sha256: str, content: bytes, canonical_suffix: str) -> str:
        return f"uploads/{sha256}{canonical_suffix}"


class FakeWork:
    def submit(self, **item: object) -> None:
        raise AssertionError("processing runs within the request in these tests")

    def cancel(self, operation_id: str) -> bool:
        return False

    def is_closed(self) -> bool:
        return False


class FakeExtraction:
    def __init__(self, documents: FakeDocuments, *, chunks: int = 2, error: Exception | None = None) -> None:
        self._documents = documents
        self._chunks = chunks
        self._error = error
        self.calls: list[dict] = []

    def extract(self, **request: object) -> SourceDocument:
        self.calls.append(request)
        if self._error is not None:
            raise self._error
        self._documents.stored = replace(
            self._documents.stored, status=SourceDocumentStatus.READY, chunks_count=self._chunks
        )
        return self._documents.stored


class FakeDrafting:
    def __init__(self) -> None:
        self.documents: list[str] = []

    def draft_questions(self, project_id: str, document_id: str) -> None:
        self.documents.append(document_id)


@dataclass(frozen=True)
class Limits:
    max_upload_bytes: int = 64
    max_audio_upload_bytes: int = 128
    max_pdf_pages: int = 10
    max_image_pixels: int = 1000


def _import(
    operations: FakeOperations,
    documents: FakeDocuments,
    extraction: FakeExtraction,
    drafting: FakeDrafting,
    *,
    content: bytes = b"%PDF source",
    filename: str = "notes.pdf",
    project_id: str = "project",
) -> SourceDocument | DocumentOperation:
    return asyncio.run(
        use_cases.import_document(
            FakeProjects(),
            documents,
            operations,
            FakeFiles(),
            FakeWork(),
            extraction,
            drafting,
            project_id=project_id,
            operation_id="operation",
            upload=FakeUpload(content),
            filename=filename,
            language_hint="xx",
            limits=Limits(),
            in_background=False,
        )
    )


def _parts() -> tuple[FakeOperations, FakeDocuments, FakeDrafting]:
    operations = FakeOperations()
    return operations, FakeDocuments(operations), FakeDrafting()


def test_an_upload_is_read_until_it_passes_its_limit() -> None:
    assert asyncio.run(use_cases.receive_upload(FakeUpload(b"12345"), 5)) == b"12345"
    with pytest.raises(SourceTooLarge, match="the limit is 4 bytes"):
        asyncio.run(use_cases.receive_upload(FakeUpload(b"12345"), 4))


def test_a_recording_has_its_own_size_limit_and_unknown_hints_become_auto() -> None:
    assert upload_size_limit("talk.M4A", max_bytes=1, max_audio_bytes=9) == 9
    assert upload_size_limit("notes.pdf", max_bytes=1, max_audio_bytes=9) == 1
    assert upload_size_limit(None, max_bytes=1, max_audio_bytes=9) == 1
    assert language_hint_or_auto("ja") == "ja"
    assert language_hint_or_auto("klingon") == "auto"


@pytest.mark.parametrize(
    ("existing", "error"),
    [
        (Status.CANCELED, DocumentProcessingCanceledError),
        (Status.CANCEL_REQUESTED, DocumentProcessingCanceledError),
        (Status.RUNNING, DocumentOperationConflictError),
    ],
)
def test_an_upload_id_in_use_is_refused_without_touching_its_operation(existing, error) -> None:
    operations = FakeOperations(claimed=False, existing_status=existing)
    documents = FakeDocuments(operations)

    with pytest.raises(error):
        _import(operations, documents, FakeExtraction(documents), FakeDrafting())

    assert operations.failures == []
    assert documents.attached is None


def test_a_missing_project_is_not_found_before_any_claim() -> None:
    operations, documents, drafting = _parts()

    with pytest.raises(NotFoundError):
        _import(operations, documents, FakeExtraction(documents), drafting, project_id="gone")

    assert operations.failures == []


def test_a_claimed_upload_that_is_too_large_fails_its_operation() -> None:
    operations, documents, drafting = _parts()

    with pytest.raises(SourceTooLarge):
        _import(operations, documents, FakeExtraction(documents), drafting, content=b"x" * 65)

    assert operations.failures == [{"error": "Document upload did not pass validation."}]


def test_an_upload_canceled_while_it_was_validated_stops_without_a_document() -> None:
    operations, documents, drafting = _parts()
    operations.current = replace(operations.current, status=Status.CANCEL_REQUESTED)

    with pytest.raises(DocumentProcessingCanceledError):
        _import(operations, documents, FakeExtraction(documents), drafting)

    assert documents.attached is None
    assert operations.failures == []


def test_an_import_with_chunks_starts_its_drafts() -> None:
    operations, documents, drafting = _parts()
    extraction = FakeExtraction(documents)

    document = _import(operations, documents, extraction, drafting)

    assert isinstance(document, SourceDocument)
    assert document.chunks_count == 2
    assert drafting.documents == ["document"]
    assert documents.attached is not None
    assert documents.attached["language_hint"] == "auto"
    assert extraction.calls[0]["source_kind"] == "pdf"
    assert extraction.calls[0]["language_hint"] == "ja"


def test_an_import_without_chunks_starts_no_drafts() -> None:
    operations, documents, drafting = _parts()

    _import(operations, documents, FakeExtraction(documents, chunks=0), drafting)

    assert drafting.documents == []


def test_extraction_without_text_fails_the_operation_and_marks_the_document() -> None:
    operations, documents, drafting = _parts()
    extraction = FakeExtraction(documents, error=SourceTextNotDetected("No text was detected."))

    result = _import(operations, documents, extraction, drafting)

    assert isinstance(result, DocumentOperation)
    assert operations.failures == [
        {
            "error": "No text was detected.",
            "document_status": "no_text_detected",
            "extraction_method": "none",
        }
    ]
    assert drafting.documents == []


def test_a_failed_extraction_records_its_message_and_propagates() -> None:
    operations, documents, drafting = _parts()
    extraction = FakeExtraction(documents, error=SourceExtractionFailed("Source extraction failed."))

    with pytest.raises(SourceExtractionFailed):
        _import(operations, documents, extraction, drafting)

    assert operations.failures[0] == {"error": "Source extraction failed."}


def test_a_canceled_extraction_is_acknowledged() -> None:
    operations, documents, drafting = _parts()
    extraction = FakeExtraction(documents, error=DocumentProcessingCanceledError("stopped"))

    document = _import(operations, documents, extraction, drafting)

    assert isinstance(document, SourceDocument)
    assert operations.calls == ["acknowledge_cancellation"]
    assert operations.failures == []


def test_an_upload_waits_only_while_its_operation_is_queued_without_a_document() -> None:
    upload = DocumentOperation.claim_upload(operation_id="o", project_id="p", now=NOW)
    upload.ensure_awaiting_upload()

    with pytest.raises(DocumentProcessingCanceledError):
        replace(upload, status=Status.CANCELED).ensure_awaiting_upload()
    with pytest.raises(Exception, match="no longer available"):
        upload.attach_document("document", NOW).ensure_awaiting_upload()


def test_extraction_goes_on_only_while_the_operation_processes_that_document() -> None:
    processing = DocumentOperation.claim_upload(
        operation_id="o", project_id="p", now=NOW
    ).attach_document("document", NOW)

    assert processing.phase == Phase.PROCESSING
    assert processing.is_processing("document")
    assert not processing.is_processing("other")
    assert not replace(processing, cancellable=False).is_processing("document")
    assert not replace(processing, status=Status.CANCEL_REQUESTED).is_processing("document")


@pytest.mark.parametrize(
    ("changes", "status"),
    [
        ({"status": SourceDocumentStatus.PROCESSING}, "processing"),
        ({"status": SourceDocumentStatus.READY, "chunks_count": 3}, "ready"),
        ({"status": SourceDocumentStatus.READY, "chunks_count": 0}, "exam_failed"),
        ({"status": SourceDocumentStatus.READY, "chunks_count": 3, "has_text": False}, "exam_failed"),
    ],
)
def test_drafts_written_at_import_leave_the_document_ready_only_with_text(changes, status) -> None:
    assert _document(**changes).status_after_import_drafts() == status
