"""The question count and status that Question Authoring records on a source after it writes questions."""

from __future__ import annotations

from dataclasses import replace

import pytest

from cert_prep_backend.platform.errors import NotFoundError
from cert_prep_backend.source_library.application import use_cases
from cert_prep_backend.source_library.domain.source import Source
from cert_prep_backend.source_library.domain.statuses import SourceStatus

NOW = "2026-11-08T00:00:00+00:00"


def _source(**changes: object) -> Source:
    source = Source(
        id="document",
        project_id="project",
        filename="notes.pdf",
        source_kind="pdf",
        sha256="abc",
        language_hint="ja",
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


class RecordingSources:
    def __init__(self, source: Source | None) -> None:
        self._source = source
        self.recorded: list[tuple[str, str, str, int]] = []

    def source(self, project_id: str, source_id: str) -> Source:
        if self._source is None:
            raise NotFoundError("Document not found.")
        return self._source

    def record_question_count(
        self, project_id: str, source_id: str, *, status: str, question_count: int
    ) -> None:
        self.recorded.append((project_id, source_id, status, question_count))


@pytest.mark.parametrize(
    ("changes", "status"),
    [
        ({"status": SourceStatus.PROCESSING}, "processing"),
        ({"status": SourceStatus.NO_TEXT_DETECTED, "has_text": False}, "ready"),
        ({"status": SourceStatus.READY, "chunks_count": 0}, "ready"),
    ],
)
def test_questions_the_learner_asked_for_leave_the_source_ready_unless_it_is_processing(
    changes, status
) -> None:
    sources = RecordingSources(_source(**changes))

    use_cases.record_question_count(sources, "project", "document", 4)

    assert sources.recorded == [("project", "document", status, 4)]


@pytest.mark.parametrize(
    ("changes", "status"),
    [
        ({"status": SourceStatus.PROCESSING}, "processing"),
        ({"status": SourceStatus.NO_TEXT_DETECTED}, "ready"),
        ({"chunks_count": 0}, "no_text_detected"),
        ({"has_text": False}, "no_text_detected"),
    ],
)
def test_questions_written_after_import_need_text_and_chunks(changes, status) -> None:
    sources = RecordingSources(_source(**changes))

    use_cases.record_import_question_count(sources, "project", "document", 2)

    assert sources.recorded == [("project", "document", status, 2)]


def test_a_missing_source_records_nothing() -> None:
    sources = RecordingSources(None)

    with pytest.raises(NotFoundError, match="^Document not found.$"):
        use_cases.record_import_question_count(sources, "project", "document", 1)

    assert sources.recorded == []
