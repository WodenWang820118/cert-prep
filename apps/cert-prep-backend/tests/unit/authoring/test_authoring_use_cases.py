"""Question Authoring use cases for generation, writing and editing."""

from __future__ import annotations

from collections.abc import Sequence

import pytest

from cert_prep_backend.authoring.application import use_cases
from cert_prep_backend.authoring.domain.question import QuestionEdit, NewQuestion
from cert_prep_backend.authoring.domain.models import (
    QuestionGenerationStrategy,
    QuestionSuggestion,
    SourceChunk,
)
from cert_prep_backend.platform.errors import ValidationError

CHUNK = SourceChunk(id="chunk", page_number=1, text="1 Reading? 1 a 2 b 3 c 4 d")


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


class FakeQuestions:
    def __init__(self, *, keep: int) -> None:
        self.keep = keep
        self.calls: list[tuple] = []

    def questions_of(self, project_id: str):
        self.calls.append(("questions_of", project_id))
        return []

    def write(self, project_id: str, authored_question: NewQuestion):
        self.calls.append(("write", project_id, authored_question))
        return authored_question

    def edit(self, project_id: str, question_id: str, edit: QuestionEdit):
        self.calls.append(("edit", project_id, question_id, edit))
        return edit

    def append_generated_questions_and_record_count(
        self, project_id: str, source_id: str, suggestions: Sequence[QuestionSuggestion]
    ):
        self.calls.append(("append_and_record_count", project_id, source_id, list(suggestions)))
        return list(suggestions)[: self.keep]


class FakeSources:
    def __init__(self, chunks: list[SourceChunk]) -> None:
        self.chunks = chunks

    def chunks_of(self, project_id: str, source_id: str) -> list[SourceChunk]:
        return self.chunks


class FakeWriting:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def suggestions(self, model, chunks, limit, strategy):
        self.calls.append((model, list(chunks), limit, strategy))
        return [_suggestion("One?"), _suggestion("Two?")]


def test_generation_passes_suggestions_to_the_atomic_write() -> None:
    questions, sources, writing = FakeQuestions(keep=1), FakeSources([CHUNK]), FakeWriting()

    def generate():
        return use_cases.generate_source_questions(
            questions,
            sources,
            writing,
            "model",
            project_id="project",
            source_id="document",
            limit=5,
            strategy=QuestionGenerationStrategy.HYBRID_REASONING,
        )

    first = generate()
    second = generate()

    assert [question.question for question in first + second] == ["One?", "One?"]
    assert writing.calls == [("model", [CHUNK], 5, QuestionGenerationStrategy.HYBRID_REASONING)] * 2
    assert questions.calls == [
        ("append_and_record_count", "project", "document", [_suggestion("One?"), _suggestion("Two?")])
    ] * 2


def test_a_source_without_text_gets_no_questions() -> None:
    questions, sources, writing = FakeQuestions(keep=5), FakeSources([]), FakeWriting()

    with pytest.raises(ValidationError, match="no extracted text chunks"):
        use_cases.generate_source_questions(
            questions,
            sources,
            writing,
            "model",
            project_id="project",
            source_id="document",
            limit=5,
            strategy=QuestionGenerationStrategy.DETERMINISTIC_ONLY,
        )

    assert writing.calls == [] and questions.calls == []


def test_question_use_cases_pass_the_learner_input_to_the_repository() -> None:
    questions = FakeQuestions(keep=0)
    new = NewQuestion(question="Q?")
    edit = QuestionEdit(answer="b")

    use_cases.list_questions(questions, "project")
    use_cases.write_question(questions, "project", new)
    use_cases.edit_question(questions, "project", "authored_question", edit)

    assert questions.calls == [
        ("questions_of", "project"),
        ("write", "project", new),
        ("edit", "project", "authored_question", edit),
    ]


class FakeWork:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def retry_jobs(self, project_id, source_id):
        self.calls.append(("retry_jobs", project_id, source_id))
        return []

    def start_manual_operation(self, project_id, source_id, limit, strategy):
        self.calls.append(("start", project_id, source_id, limit, strategy))

    def manual_operation(self, project_id, source_id, operation_id):
        self.calls.append(("view", project_id, source_id, operation_id))

    def cancel_manual_operation(self, project_id, source_id, operation_id):
        self.calls.append(("cancel", project_id, source_id, operation_id))


class FakeJobs:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def jobs_of(self, project_id, source_id):
        self.calls.append(("jobs_of", project_id, source_id))
        return []

    def cancel(self, project_id, source_id, job_id):
        self.calls.append(("cancel", project_id, source_id, job_id))

    def discard_unfinished(self, project_id, source_id):
        self.calls.append(("discard_unfinished", project_id, source_id))


def test_generation_use_cases_reach_the_background_work_and_the_jobs() -> None:
    work, jobs = FakeWork(), FakeJobs()

    use_cases.retry_generation_jobs(work, "p", "d")
    use_cases.start_manual_generation(work, "p", "d", limit=3, strategy=QuestionGenerationStrategy.HYBRID_REASONING)
    use_cases.view_manual_generation(work, "p", "d", "op")
    use_cases.cancel_manual_generation(work, "p", "d", "op")
    use_cases.list_generation_jobs(jobs, "p", "d")
    use_cases.cancel_generation_job(jobs, "p", "d", "job")
    use_cases.discard_unfinished_generation_jobs(jobs, "p", "d")

    assert work.calls == [
        ("retry_jobs", "p", "d"),
        ("start", "p", "d", 3, QuestionGenerationStrategy.HYBRID_REASONING),
        ("view", "p", "d", "op"),
        ("cancel", "p", "d", "op"),
    ]
    assert jobs.calls == [
        ("jobs_of", "p", "d"),
        ("cancel", "p", "d", "job"),
        ("discard_unfinished", "p", "d"),
    ]
