"""Question Authoring use cases: generating drafts for a document records how many were kept,
and nothing is written for a document without text."""

from __future__ import annotations

from collections.abc import Sequence

import pytest

from cert_prep_backend.authoring.application import use_cases
from cert_prep_backend.authoring.domain.draft import DraftEdit, NewQuestionDraft
from cert_prep_backend.authoring.domain.models import (
    DraftGenerationStrategy,
    DraftSuggestion,
    SourceChunk,
)
from cert_prep_backend.platform.errors import ValidationError

CHUNK = SourceChunk(id="chunk", page_number=1, text="1 Reading? 1 a 2 b 3 c 4 d")


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
    )


class FakeDrafts:
    def __init__(self, *, keep: int) -> None:
        self.keep = keep
        self.calls: list[tuple] = []

    def drafts_of(self, project_id: str):
        self.calls.append(("drafts_of", project_id))
        return []

    def write(self, project_id: str, draft: NewQuestionDraft):
        self.calls.append(("write", project_id, draft))
        return draft

    def edit(self, project_id: str, draft_id: str, edit: DraftEdit):
        self.calls.append(("edit", project_id, draft_id, edit))
        return edit

    def add_generated(self, project_id: str, document_id: str, suggestions: Sequence[DraftSuggestion]):
        self.calls.append(("add_generated", project_id, document_id, list(suggestions)))
        return list(suggestions)[: self.keep]


class FakeSources:
    def __init__(self, chunks: list[SourceChunk]) -> None:
        self.chunks = chunks
        self.counts: list[tuple[str, str, int]] = []

    def chunks_of(self, project_id: str, document_id: str) -> list[SourceChunk]:
        return self.chunks

    def record_draft_count(self, project_id: str, document_id: str, count: int) -> None:
        self.counts.append((project_id, document_id, count))


class FakeWriting:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def suggestions(self, model, chunks, limit, strategy):
        self.calls.append((model, list(chunks), limit, strategy))
        return [_suggestion("One?"), _suggestion("Two?")]


def test_generating_drafts_records_how_many_drafts_were_kept() -> None:
    drafts, sources, writing = FakeDrafts(keep=1), FakeSources([CHUNK]), FakeWriting()

    added = use_cases.generate_document_drafts(
        drafts,
        sources,
        writing,
        "model",
        project_id="project",
        document_id="document",
        limit=5,
        strategy=DraftGenerationStrategy.HYBRID_REASONING,
    )

    assert [draft.question for draft in added] == ["One?"]
    assert writing.calls == [("model", [CHUNK], 5, DraftGenerationStrategy.HYBRID_REASONING)]
    assert sources.counts == [("project", "document", 1)]


def test_a_document_without_text_gets_no_drafts() -> None:
    drafts, sources, writing = FakeDrafts(keep=5), FakeSources([]), FakeWriting()

    with pytest.raises(ValidationError, match="no extracted text chunks"):
        use_cases.generate_document_drafts(
            drafts,
            sources,
            writing,
            "model",
            project_id="project",
            document_id="document",
            limit=5,
            strategy=DraftGenerationStrategy.DETERMINISTIC_ONLY,
        )

    assert writing.calls == [] and drafts.calls == [] and sources.counts == []


def test_draft_use_cases_pass_the_learner_input_to_the_repository() -> None:
    drafts = FakeDrafts(keep=0)
    new = NewQuestionDraft(question="Q?")
    edit = DraftEdit(answer="b")

    use_cases.list_drafts(drafts, "project")
    use_cases.write_draft(drafts, "project", new)
    use_cases.edit_draft(drafts, "project", "draft", edit)

    assert drafts.calls == [
        ("drafts_of", "project"),
        ("write", "project", new),
        ("edit", "project", "draft", edit),
    ]


class FakeWork:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def retry_jobs(self, project_id, document_id):
        self.calls.append(("retry_jobs", project_id, document_id))
        return []

    def start_manual_operation(self, project_id, document_id, limit, strategy):
        self.calls.append(("start", project_id, document_id, limit, strategy))

    def manual_operation(self, project_id, document_id, operation_id):
        self.calls.append(("view", project_id, document_id, operation_id))

    def cancel_manual_operation(self, project_id, document_id, operation_id):
        self.calls.append(("cancel", project_id, document_id, operation_id))


class FakeJobs:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def jobs_of(self, project_id, document_id):
        self.calls.append(("jobs_of", project_id, document_id))
        return []

    def cancel(self, project_id, document_id, job_id):
        self.calls.append(("cancel", project_id, document_id, job_id))


def test_generation_use_cases_reach_the_background_work_and_the_jobs() -> None:
    work, jobs = FakeWork(), FakeJobs()

    use_cases.retry_generation_jobs(work, "p", "d")
    use_cases.start_manual_generation(work, "p", "d", limit=3, strategy=DraftGenerationStrategy.HYBRID_REASONING)
    use_cases.view_manual_generation(work, "p", "d", "op")
    use_cases.cancel_manual_generation(work, "p", "d", "op")
    use_cases.list_generation_jobs(jobs, "p", "d")
    use_cases.cancel_generation_job(jobs, "p", "d", "job")

    assert work.calls == [
        ("retry_jobs", "p", "d"),
        ("start", "p", "d", 3, DraftGenerationStrategy.HYBRID_REASONING),
        ("view", "p", "d", "op"),
        ("cancel", "p", "d", "op"),
    ]
    assert jobs.calls == [("jobs_of", "p", "d"), ("cancel", "p", "d", "job")]
