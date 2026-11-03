"""Drafts of an imported document: streaming queues jobs, writing at import writes them now,
and an unavailable model leaves the document with none."""

from __future__ import annotations

from dataclasses import replace

import pytest

from cert_prep_backend.authoring.application import use_cases
from cert_prep_backend.authoring.domain.generation import (
    DraftGenerationJob,
    DraftGenerationJobStatus,
    all_jobs_ended,
)
from cert_prep_backend.authoring.domain.models import DraftSuggestion, SourceChunk
from cert_prep_backend.platform.errors import ProviderUnavailableError

CHUNK = SourceChunk(id="chunk", page_number=1, text="text")


def _suggestion(question: str) -> DraftSuggestion:
    return DraftSuggestion(
        chunk_id="chunk",
        question=question,
        choices=["a", "b"],
        answer="a",
        answer_key_source="ai_inferred",
        rationale="R",
        citation_page=1,
        source_excerpt="E",
        status="needs_review",
    )


class Recorder:
    def __init__(self, *, suggestions: list[DraftSuggestion] | Exception = ()) -> None:
        self._suggestions = suggestions
        self.calls: list[tuple] = []

    # DraftGenerationWork
    def enqueue_document(self, project_id: str, document_id: str) -> None:
        self.calls.append(("enqueue", document_id))

    # DraftSources
    def chunks_of(self, project_id: str, document_id: str) -> list[SourceChunk]:
        return [CHUNK]

    def record_import_draft_count(self, project_id: str, document_id: str, count: int) -> None:
        self.calls.append(("record", count))

    # DraftWriting
    def import_suggestions(self, model: object, chunks, limit: int) -> list[DraftSuggestion]:
        self.calls.append(("write", model, limit))
        if isinstance(self._suggestions, Exception):
            raise self._suggestions
        return list(self._suggestions)

    # QuestionDraftRepository
    def add_generated(self, project_id: str, document_id: str, suggestions) -> list[object]:
        self.calls.append(("add", [suggestion.status for suggestion in suggestions]))
        return list(suggestions)[:1]


def _draft(recorder: Recorder, *, streams: bool, writes: bool) -> None:
    use_cases.draft_imported_document(
        recorder,
        recorder,
        recorder,
        recorder,
        "model",
        project_id="project",
        document_id="document",
        streams_drafts=streams,
        writes_drafts=writes,
        limit=7,
    )


@pytest.mark.parametrize(("streams", "writes"), [(True, True), (True, False), (False, False)])
def test_drafts_are_only_queued_unless_import_writes_them_without_streaming(streams, writes) -> None:
    recorder = Recorder(suggestions=[_suggestion("Q")])

    _draft(recorder, streams=streams, writes=writes)

    assert recorder.calls == [("enqueue", "document")]


def test_drafts_written_at_import_are_playable_and_counted() -> None:
    recorder = Recorder(suggestions=[_suggestion("Q1"), _suggestion("Q2")])

    _draft(recorder, streams=False, writes=True)

    assert recorder.calls == [
        ("enqueue", "document"),
        ("write", "model", 7),
        ("add", ["approved", "approved"]),
        ("record", 1),
    ]


@pytest.mark.parametrize("outcome", [[], ProviderUnavailableError("no model")])
def test_an_import_without_drafts_records_none(outcome) -> None:
    recorder = Recorder(suggestions=outcome)

    _draft(recorder, streams=False, writes=True)

    assert recorder.calls[-1] == ("record", 0)
    assert not any(call[0] == "add" for call in recorder.calls)


def _job(status: DraftGenerationJobStatus) -> DraftGenerationJob:
    return DraftGenerationJob(
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
    ended = _job(DraftGenerationJobStatus.SKIPPED_MISSING_MODEL)

    assert not all_jobs_ended([])
    assert all_jobs_ended([ended, replace(ended, status=DraftGenerationJobStatus.SUCCEEDED)])
    assert not all_jobs_ended([ended, replace(ended, status=DraftGenerationJobStatus.RUNNING)])
