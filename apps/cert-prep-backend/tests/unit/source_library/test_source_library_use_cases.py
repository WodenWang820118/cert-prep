"""Source Library use cases: what can be exported or played, how transcript edits are kept,
and how cancellation reaches work still waiting in the queue."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest

from cert_prep_backend.source_library.application import use_cases
from cert_prep_backend.source_library.domain.document import (
    DocumentChunk,
    SourceDocument,
    SourceFile,
)
from cert_prep_backend.source_library.domain.exceptions import SourceDocumentUnavailable
from cert_prep_backend.source_library.domain.operation import DocumentOperation
from cert_prep_backend.source_library.domain.statuses import SourceDocumentStatus

NOW = "2026-10-27T00:00:00+00:00"


def _document(**changes: object) -> SourceDocument:
    document = SourceDocument(
        id="document",
        project_id="project",
        filename="notes.pdf",
        sha256="abc",
        language_hint="auto",
        page_count=1,
        has_text=True,
        status=SourceDocumentStatus.READY,
        extraction_method="embedded",
        ocr_device=None,
        ocr_fallback_reason=None,
        ocr_duration_ms=0,
        processed_page_count=1,
        parse_wall_duration_ms=0,
        render_duration_ms=0,
        ocr_engine_duration_ms=0,
        ocr_worker_count=0,
        first_chunk_ms=0,
        exam_item_count=0,
        content_profile="unknown",
        classification_detail="",
        chunks_count=1,
        created_at=NOW,
        updated_at=NOW,
    )
    return replace(document, **changes)


def _chunk() -> DocumentChunk:
    return DocumentChunk(
        id="chunk",
        document_id="document",
        page_number=1,
        chunk_index=0,
        text="本文",
        raw_text="本文",
        line_start=None,
        line_end=None,
        line_count=1,
        source_excerpt="本文",
        extraction_method="embedded",
        content_profile="unknown",
        created_at=NOW,
    )


class FakeDocuments:
    def __init__(self, document: SourceDocument, chunks: list[DocumentChunk]) -> None:
        self.stored = document
        self.chunks = chunks
        self.edits: list[str] = []
        self.calls: list[str] = []

    def documents_of(self, project_id: str) -> list[SourceDocument]:
        return [self.stored]

    def document(self, project_id: str, document_id: str) -> SourceDocument:
        return self.stored

    def source_file(self, project_id: str, document_id: str) -> SourceFile:
        return SourceFile(filename="talk.m4a", sha256="abc", storage_path="uploads/abc.m4a")

    def chunks_of(self, project_id: str, document_id: str) -> list[DocumentChunk]:
        return self.chunks

    def edit_chunk_text(
        self, project_id: str, document_id: str, chunk_id: str, text: str
    ) -> DocumentChunk:
        self.edits.append(text)
        return replace(self.chunks[0], text=text)

    def recover_processing(self) -> int:
        self.calls.append("documents")
        return 0


class FakeFiles:
    def __init__(self, path: Path, sha256: str) -> None:
        self.path = path
        self.digest = sha256

    def resolve(self, project_id: str, storage_path: str) -> Path:
        return self.path

    def sha256(self, source_path: Path) -> str:
        return self.digest


class FakeOperations:
    def __init__(self) -> None:
        running = DocumentOperation.start_retry(
            operation_id="op", project_id="project", document_id="document", now=NOW
        )
        self.requested = running.cancel(NOW)
        self.after_queue_cancel = self.requested.acknowledge_cancellation(NOW)
        self.calls: list[str] = []

    def operation(self, project_id: str, operation_id: str) -> DocumentOperation:
        self.calls.append("reread")
        return self.after_queue_cancel

    def cancel(self, project_id: str, operation_id: str) -> DocumentOperation:
        return self.requested

    def cancel_processing_of(self, project_id: str, document_id: str) -> DocumentOperation:
        return self.requested

    def recover_interrupted(self) -> int:
        self.calls.append("operations")
        return 0


class FakeQueue:
    def __init__(self, *, queued: bool) -> None:
        self.queued = queued
        self.canceled: list[str] = []

    def cancel(self, operation_id: str) -> bool:
        self.canceled.append(operation_id)
        return self.queued


def test_a_ready_pdf_exports_markdown_from_its_chunks() -> None:
    projection = use_cases.export_markdown(
        FakeDocuments(_document(), [_chunk()]), "project", "document"
    )

    assert projection.document.filename == "notes.pdf"
    assert projection.chunks == (_chunk(),)


@pytest.mark.parametrize(
    ("document", "message"),
    [
        (_document(filename="scan.png"), "PDF documents only"),
        (_document(source_kind="audio", filename="talk.pdf"), "PDF documents only"),
        (_document(status=SourceDocumentStatus.PROCESSING), "after document processing completes"),
    ],
)
def test_only_a_processed_pdf_has_markdown(document: SourceDocument, message: str) -> None:
    with pytest.raises(SourceDocumentUnavailable, match=message) as raised:
        use_cases.export_markdown(FakeDocuments(document, [_chunk()]), "project", "document")

    assert raised.value.code == "markdown_unavailable"


def test_markdown_needs_at_least_one_chunk() -> None:
    with pytest.raises(SourceDocumentUnavailable, match="at least one persisted document chunk"):
        use_cases.export_markdown(FakeDocuments(_document(), []), "project", "document")


def test_a_verified_recording_is_played_with_its_media_type(tmp_path: Path) -> None:
    documents = FakeDocuments(_document(source_kind="audio", filename="talk.m4a"), [])

    source = use_cases.open_audio_source(
        documents, FakeFiles(tmp_path / "abc.m4a", "abc"), "project", "document"
    )

    assert (source.media_type, source.filename) == ("audio/mp4", "talk.m4a")


@pytest.mark.parametrize(
    ("document", "path", "sha256", "message"),
    [
        (_document(), "abc.m4a", "abc", "Only audio documents"),
        (_document(source_kind="audio"), "abc.m4a", "changed", "failed integrity verification"),
        (_document(source_kind="audio"), "abc.ogg", "abc", "failed integrity verification"),
    ],
)
def test_only_an_intact_recording_can_be_played(
    tmp_path: Path, document: SourceDocument, path: str, sha256: str, message: str
) -> None:
    with pytest.raises(SourceDocumentUnavailable, match=message) as raised:
        use_cases.open_audio_source(
            FakeDocuments(document, []), FakeFiles(tmp_path / path, sha256), "project", "document"
        )

    assert raised.value.code == "audio_source_unavailable"


def test_a_transcript_edit_is_trimmed_and_never_empty() -> None:
    documents = FakeDocuments(_document(source_kind="audio"), [_chunk()])

    edited = use_cases.edit_chunk(documents, "project", "document", "chunk", "  新しい本文 \n")

    assert edited.text == "新しい本文"
    with pytest.raises(ValueError, match="must not be empty"):
        use_cases.edit_chunk(documents, "project", "document", "chunk", "   ")
    assert documents.edits == ["新しい本文"]


@pytest.mark.parametrize("cancel", [use_cases.cancel_operation, use_cases.cancel_processing])
def test_canceling_queued_work_reads_back_what_the_queue_recorded(cancel) -> None:
    operations = FakeOperations()
    queue = FakeQueue(queued=True)

    operation = cancel(
        operations, queue, "project", "op" if cancel is use_cases.cancel_operation else "document"
    )

    assert queue.canceled == ["op"]
    assert operations.calls == ["reread"]
    assert operation is operations.after_queue_cancel


@pytest.mark.parametrize("cancel", [use_cases.cancel_operation, use_cases.cancel_processing])
def test_canceling_running_work_returns_the_requested_cancellation(cancel) -> None:
    operations = FakeOperations()

    operation = cancel(operations, FakeQueue(queued=False), "project", "op")

    assert operations.calls == []
    assert operation is operations.requested


def test_a_restart_settles_operations_before_documents() -> None:
    operations = FakeOperations()
    documents = FakeDocuments(_document(), [])
    order: list[str] = []
    operations.calls = order
    documents.calls = order

    use_cases.recover_interrupted_work(operations, documents)

    assert order == ["operations", "documents"]
