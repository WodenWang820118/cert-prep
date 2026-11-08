"""The exam state Question Authoring records on a document after it writes drafts."""

from __future__ import annotations

from dataclasses import replace

import pytest

from cert_prep_backend.platform.errors import NotFoundError
from cert_prep_backend.source_library.application import use_cases
from cert_prep_backend.source_library.domain.document import SourceDocument
from cert_prep_backend.source_library.domain.statuses import SourceDocumentStatus

NOW = "2026-11-08T00:00:00+00:00"


def _document(**changes: object) -> SourceDocument:
    document = SourceDocument(
        id="document",
        project_id="project",
        filename="notes.pdf",
        sha256="abc",
        language_hint="ja",
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


class RecordingDocuments:
    def __init__(self, document: SourceDocument | None) -> None:
        self._document = document
        self.recorded: list[tuple[str, str, str, int]] = []

    def document(self, project_id: str, document_id: str) -> SourceDocument:
        if self._document is None:
            raise NotFoundError("Document not found.")
        return self._document

    def record_exam_state(
        self, project_id: str, document_id: str, *, status: str, exam_item_count: int
    ) -> None:
        self.recorded.append((project_id, document_id, status, exam_item_count))


@pytest.mark.parametrize(
    ("changes", "status"),
    [
        ({"status": SourceDocumentStatus.PROCESSING}, "processing"),
        ({"status": SourceDocumentStatus.EXAM_FAILED, "has_text": False}, "ready"),
        ({"status": SourceDocumentStatus.READY, "chunks_count": 0}, "ready"),
    ],
)
def test_drafts_the_learner_asked_for_leave_the_document_ready_unless_it_is_processing(
    changes, status
) -> None:
    documents = RecordingDocuments(_document(**changes))

    use_cases.record_draft_count(documents, "project", "document", 4)

    assert documents.recorded == [("project", "document", status, 4)]


@pytest.mark.parametrize(
    ("changes", "status"),
    [
        ({"status": SourceDocumentStatus.PROCESSING}, "processing"),
        ({"status": SourceDocumentStatus.EXAM_FAILED}, "ready"),
        ({"chunks_count": 0}, "exam_failed"),
        ({"has_text": False}, "exam_failed"),
    ],
)
def test_drafts_written_after_import_need_text_and_chunks(changes, status) -> None:
    documents = RecordingDocuments(_document(**changes))

    use_cases.record_import_draft_count(documents, "project", "document", 2)

    assert documents.recorded == [("project", "document", status, 2)]


def test_a_missing_document_records_nothing() -> None:
    documents = RecordingDocuments(None)

    with pytest.raises(NotFoundError, match="^Document not found.$"):
        use_cases.record_import_draft_count(documents, "project", "document", 1)

    assert documents.recorded == []
