"""Questions of an imported source: background queues jobs, writing at import writes them now,
and an unavailable model leaves the source with none."""

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
        self.calls: list[tuple] = []

    # QuestionGenerationWork
    def enqueue_source(self, project_id: str, source_id: str) -> None:
        self.calls.append(("enqueue", source_id))

    # QuestionSources
    def chunks_of(self, project_id: str, source_id: str) -> list[SourceChunk]:
        return [CHUNK]

    # QuestionWriting
    def import_suggestions(self, model: object, chunks, limit: int) -> list[QuestionSuggestion]:
        self.calls.append(("write", model, limit))
        if isinstance(self._suggestions, Exception):
            raise self._suggestions
        return list(self._suggestions)

    # QuestionRepository
    def append_import_questions_and_record_count(
        self, project_id: str, source_id: str, suggestions
    ) -> list[object]:
        self.calls.append(("append_and_record_count", project_id, source_id, len(suggestions)))
        return list(suggestions)[:1]


def _question(recorder: Recorder, *, streams: bool, writes: bool) -> None:
    use_cases.generate_imported_questions(
        recorder,
        recorder,
        recorder,
        recorder,
        "model",
        project_id="project",
        source_id="document",
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
        ("append_and_record_count", "project", "document", 2),
    ]


@pytest.mark.parametrize("outcome", [[], LanguageModelUnavailable("no model")])
def test_an_import_without_questions_records_none(outcome) -> None:
    recorder = Recorder(suggestions=outcome)

    _question(recorder, streams=False, writes=True)

    assert recorder.calls[-1] == ("append_and_record_count", "project", "document", 0)


def _job(status: QuestionGenerationJobStatus) -> QuestionGenerationJob:
    return QuestionGenerationJob(
        id="job",
        project_id="project",
        source_id="document",
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


def test_generation_ends_once_every_job_of_the_source_has_ended() -> None:
    ended = _job(QuestionGenerationJobStatus.SKIPPED_MISSING_MODEL)

    assert not all_jobs_ended([])
    assert all_jobs_ended([ended, replace(ended, status=QuestionGenerationJobStatus.SUCCEEDED)])
    assert not all_jobs_ended([ended, replace(ended, status=QuestionGenerationJobStatus.RUNNING)])
