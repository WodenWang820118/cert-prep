"""Source Library use cases: what can be exported or played, how transcript edits are kept,
and how cancellation reaches work still waiting in the queue."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest

from cert_prep_backend.platform.errors import InvalidSourceError
from cert_prep_backend.source_library.application import use_cases
from cert_prep_backend.source_library.domain.source import (
    SourceChunk,
    Source,
    SourceFile,
)
from cert_prep_backend.source_library.domain.exceptions import SourceUnavailable
from cert_prep_backend.source_library.domain.operation import SourceOperation
from cert_prep_backend.source_library.domain.statuses import SourceStatus

NOW = "2026-10-27T00:00:00+00:00"


def _source(**changes: object) -> Source:
    source = Source(
        id="document",
        project_id="project",
        filename="notes.pdf",
        source_kind="pdf",
        sha256="abc",
        language_hint="auto",
        page_count=1,
        has_text=True,
        status=SourceStatus.READY,
        extraction_method="text_recognition",
        ocr_device=None,
        extraction_warnings=None,
        failure_message=None,
        processed_page_count=1,
        question_count=0,
        content_profile="unknown",
        classification_detail="",
        chunks_count=1,
        created_at=NOW,
        updated_at=NOW,
    )
    return replace(source, **changes)


def _chunk() -> SourceChunk:
    return SourceChunk(
        id="chunk",
        source_id="document",
        page_number=1,
        chunk_index=0,
        text="本文",
        raw_text="本文",
        line_start=None,
        line_end=None,
        line_count=1,
        source_excerpt="本文",
        extraction_method="text_recognition",
        content_profile="unknown",
        created_at=NOW,
    )


class FakeSources:
    def __init__(self, source: Source, chunks: list[SourceChunk]) -> None:
        self.stored = source
        self.chunks = chunks
        self.edits: list[str] = []
        self.calls: list[str] = []

    def sources_of(self, project_id: str) -> list[Source]:
        return [self.stored]

    def source(self, project_id: str, source_id: str) -> Source:
        return self.stored

    def source_file(self, project_id: str, source_id: str) -> SourceFile:
        return SourceFile(filename="talk.m4a", sha256="abc", storage_path="uploads/abc.m4a")

    def chunks_of(self, project_id: str, source_id: str) -> list[SourceChunk]:
        return self.chunks

    def edit_chunk_text(
        self, project_id: str, source_id: str, chunk_id: str, text: str
    ) -> SourceChunk:
        self.edits.append(text)
        return replace(self.chunks[0], text=text)

    def recover_processing(self) -> int:
        self.calls.append("sources")
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
        running = SourceOperation.start_retry(
            operation_id="op", project_id="project", source_id="document", now=NOW
        )
        self.requested = running.cancel(NOW)
        self.after_queue_cancel = self.requested.acknowledge_cancellation(NOW)
        self.calls: list[str] = []

    def operation(self, project_id: str, operation_id: str) -> SourceOperation:
        self.calls.append("reread")
        return self.after_queue_cancel

    def cancel(self, project_id: str, operation_id: str) -> SourceOperation:
        return self.requested

    def cancel_processing_of(self, project_id: str, source_id: str) -> SourceOperation:
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
        FakeSources(_source(), [_chunk()]), "project", "document"
    )

    assert projection.source.filename == "notes.pdf"
    assert projection.chunks == (_chunk(),)


@pytest.mark.parametrize(
    ("source", "message"),
    [
        (_source(filename="scan.png", source_kind="image"), "PDF documents only"),
        (_source(source_kind="recording", filename="talk.pdf"), "PDF documents only"),
        (_source(status=SourceStatus.PROCESSING), "after document processing completes"),
    ],
)
def test_only_a_processed_pdf_has_markdown(source: Source, message: str) -> None:
    with pytest.raises(SourceUnavailable, match=message) as raised:
        use_cases.export_markdown(FakeSources(source, [_chunk()]), "project", "document")

    assert raised.value.code == "markdown_unavailable"


def test_markdown_needs_at_least_one_chunk() -> None:
    with pytest.raises(SourceUnavailable, match="at least one persisted document chunk"):
        use_cases.export_markdown(FakeSources(_source(), []), "project", "document")


def test_a_verified_recording_is_played_with_its_media_type(tmp_path: Path) -> None:
    sources = FakeSources(_source(source_kind="recording", filename="talk.m4a"), [])

    source = use_cases.open_audio_source(
        sources, FakeFiles(tmp_path / "abc.m4a", "abc"), "project", "document"
    )

    assert (source.media_type, source.filename) == ("audio/mp4", "talk.m4a")


@pytest.mark.parametrize(
    ("source", "path", "sha256", "message"),
    [
        (_source(), "abc.m4a", "abc", "Only recordings"),
        (_source(source_kind="recording"), "abc.m4a", "changed", "failed integrity verification"),
        (_source(source_kind="recording"), "abc.ogg", "abc", "failed integrity verification"),
    ],
)
def test_only_an_intact_recording_can_be_played(
    tmp_path: Path, source: Source, path: str, sha256: str, message: str
) -> None:
    with pytest.raises(SourceUnavailable, match=message) as raised:
        use_cases.open_audio_source(
            FakeSources(source, []), FakeFiles(tmp_path / path, sha256), "project", "document"
        )

    assert raised.value.code == "audio_source_unavailable"


class MissingFiles:
    def resolve(self, project_id: str, storage_path: str) -> Path:
        raise InvalidSourceError("The stored source file is unavailable.")

    def sha256(self, source_path: Path) -> str:
        raise AssertionError("a missing file is never hashed")


def test_a_recording_whose_file_is_gone_is_unavailable() -> None:
    sources = FakeSources(_source(source_kind="recording"), [])

    with pytest.raises(
        SourceUnavailable, match="stored audio source is unavailable"
    ) as raised:
        use_cases.open_audio_source(sources, MissingFiles(), "project", "document")

    assert raised.value.code == "audio_source_unavailable"


def test_a_transcript_edit_is_trimmed_and_never_empty() -> None:
    sources = FakeSources(_source(source_kind="recording"), [_chunk()])

    edited = use_cases.edit_chunk(sources, "project", "document", "chunk", "  新しい本文 \n")

    assert edited.text == "新しい本文"
    with pytest.raises(ValueError, match="must not be empty"):
        use_cases.edit_chunk(sources, "project", "document", "chunk", "   ")
    assert sources.edits == ["新しい本文"]


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


def test_a_restart_settles_operations_before_sources() -> None:
    operations = FakeOperations()
    sources = FakeSources(_source(), [])
    order: list[str] = []
    operations.calls = order
    sources.calls = order

    use_cases.recover_interrupted_work(operations, sources)

    assert order == ["operations", "sources"]
