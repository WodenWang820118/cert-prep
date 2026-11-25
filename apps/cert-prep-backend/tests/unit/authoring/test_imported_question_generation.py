"""Questions of an imported document: background queues jobs, writing at import writes them now,
and an unavailable model leaves the document with none."""

from __future__ import annotations

from dataclasses import replace

import pytest

from cert_prep_backend.authoring.application import use_cases
from cert_prep_backend.authoring.domain.generation import (
    QuestionGenerationJob,
    QuestionGenerationJobStatus,
    all_jobs_ended,
)
from cert_prep_backend.authoring.domain.models import QuestionSuggestion, SourceChunk
from cert_prep_backend.platform.errors import LanguageModelUnavailable

CHUNK = SourceChunk(id="chunk", page_number=1, text="text")


def _suggestion(question: str) -> QuestionSuggestion:
    return QuestionSuggestion(
        chunk_id="chunk",
        question=question,
        choices=["a", "b"],
        answer="a",
        answer_key_source="ai_inferred",
        rationale="R",
        citation_page=1,
        source_excerpt="E",
    )


class Recorder:
    def __init__(self, *, suggestions: list[QuestionSuggestion] | Exception = ()) -> None:
        self._suggestions = suggestions
        self.stored = 0
        self.calls: list[tuple] = []

    # QuestionGenerationWork
    def enqueue_document(self, project_id: str, document_id: str) -> None:
        self.calls.append(("enqueue", document_id))

    # QuestionSources
    def chunks_of(self, project_id: str, document_id: str) -> list[SourceChunk]:
        return [CHUNK]

    def record_import_question_count(self, project_id: str, document_id: str, count: int) -> None:
        self.calls.append(("record", count))

    # QuestionWriting
    def import_suggestions(self, model: object, chunks, limit: int) -> list[QuestionSuggestion]:
        self.calls.append(("write", model, limit))
        if isinstance(self._suggestions, Exception):
            raise self._suggestions
        return list(self._suggestions)

    # QuestionRepository
    def add_generated(self, project_id: str, document_id: str, suggestions) -> list[object]:
        self.calls.append(("add", len(suggestions)))
        self.stored += 1
        return list(suggestions)[:1]

    def count_for_source(self, project_id: str, document_id: str) -> int:
        return self.stored


def _question(recorder: Recorder, *, streams: bool, writes: bool) -> None:
    use_cases.generate_imported_questions(
        recorder,
        recorder,
        recorder,
        recorder,
        "model",
        project_id="project",
        document_id="document",
        schedules_question_jobs=streams,
        writes_questions=writes,
        limit=7,
    )


@pytest.mark.parametrize(("streams", "writes"), [(True, True), (True, False), (False, False)])
def test_questions_are_only_queued_unless_import_writes_them_without_background(streams, writes) -> None:
    recorder = Recorder(suggestions=[_suggestion("Q")])

    _question(recorder, streams=streams, writes=writes)

    assert recorder.calls == [("enqueue", "document")]


def test_questions_written_at_import_are_playable_and_counted() -> None:
    recorder = Recorder(suggestions=[_suggestion("Q1"), _suggestion("Q2")])

    _question(recorder, streams=False, writes=True)

    assert recorder.calls == [
        ("enqueue", "document"),
        ("write", "model", 7),
        ("add", 2),
        ("record", 1),
    ]


def test_writing_at_import_twice_records_the_documents_total() -> None:
    recorder = Recorder(suggestions=[_suggestion("Q1"), _suggestion("Q2")])

    _question(recorder, streams=False, writes=True)
    _question(recorder, streams=False, writes=True)

    # Each run keeps one question; the count is every question the document has.
    assert [call for call in recorder.calls if call[0] == "record"] == [
        ("record", 1),
        ("record", 2),
    ]


@pytest.mark.parametrize("outcome", [[], LanguageModelUnavailable("no model")])
def test_an_import_without_questions_records_none(outcome) -> None:
    recorder = Recorder(suggestions=outcome)

    _question(recorder, streams=False, writes=True)

    assert recorder.calls[-1] == ("record", 0)
    assert not any(call[0] == "add" for call in recorder.calls)


def _job(status: QuestionGenerationJobStatus) -> QuestionGenerationJob:
    return QuestionGenerationJob(
        id="job",
        project_id="project",
        document_id="document",
        chunk_id="chunk",
        page_number=1,
        strategy="hybrid_reasoning",
        status=status,
        provider="fake",
        model="model",
        effective_provider=None,
        effective_model=None,
        fallback_reason=None,
        phase="queued",
        cancellable=True,
        generated_count=0,
        retry_count=0,
        last_error=None,
        created_at="now",
        updated_at="now",
    )


def test_generation_ends_once_every_job_of_the_document_has_ended() -> None:
    ended = _job(QuestionGenerationJobStatus.SKIPPED_MISSING_MODEL)

    assert not all_jobs_ended([])
    assert all_jobs_ended([ended, replace(ended, status=QuestionGenerationJobStatus.SUCCEEDED)])
    assert not all_jobs_ended([ended, replace(ended, status=QuestionGenerationJobStatus.RUNNING)])
