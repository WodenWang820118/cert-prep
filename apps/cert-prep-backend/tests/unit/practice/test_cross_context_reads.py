"""Practice's ports over Study Projects, Source Library and Question Authoring."""

from __future__ import annotations

from collections.abc import Sequence

import pytest

from cert_prep_backend.authoring.domain.question import Question
from cert_prep_backend.bootstrap.practice_reads import (
    SourceMembership,
    AuthoringPracticeQuestions,
    ProjectExistence,
)
from cert_prep_backend.platform.errors import NotFoundError
from cert_prep_backend.practice.application.ports import PracticeSourceQuestion
from cert_prep_backend.projects.domain.project import Project, ProjectName


def _question(
    question_id: str, *, answer_key_source: object = "manual"
) -> Question:
    return Question(
        id=question_id,
        project_id="project",
        source_id="document",
        chunk_id=None,
        question="Which access model?",
        choices=("Least privilege", "Open access"),
        answer="Least privilege",
        answer_key_source=answer_key_source,
        rationale="Keep permissions scoped.",
        citation_page=2,
        citation_locator_kind="page",
        citation_start_ms=None,
        citation_end_ms=None,
        source_excerpt="Least privilege.",
        confidence=None,
        source_order=4,
        source_question_number=None,
        item_kind="unknown",
        group_key=None,
        group_prompt=None,
        created_at="t1",
        updated_at="t1",
    )


class QuestionRepository:
    def __init__(self, questions: list[Question]) -> None:
        self.questions = questions
        self.source_id: str | None = None

    def for_source(self, project_id: str, *, source_id: str | None) -> list[Question]:
        assert project_id == "project"
        self.source_id = source_id
        return self.questions

    def find(self, project_id: str, question_id: str) -> Question | None:
        assert project_id == "project"
        return next((authored_question for authored_question in self.questions if authored_question.id == question_id), None)

    def find_many(self, project_id: str, question_ids: Sequence[str]) -> list[Question]:
        assert project_id == "project"
        by_id = {authored_question.id: authored_question for authored_question in self.questions}
        return [by_id[question_id] for question_id in question_ids if question_id in by_id]


class Projects:
    def __init__(self, project_id: str | None) -> None:
        self.project_id = project_id

    def get(self, project_id: str) -> Project | None:
        if project_id != self.project_id:
            return None
        return Project(
            id=project_id,
            name=ProjectName("JLPT"),
            description="",
            created_at="t0",
            updated_at="t0",
        )


class Sources:
    def __init__(self, found: bool) -> None:
        self.found = found
        self.calls: list[tuple[str, str]] = []

    def source(self, project_id: str, source_id: str) -> object:
        self.calls.append((project_id, source_id))
        if not self.found:
            raise NotFoundError("Document not found.")
        return object()


def test_project_existence_uses_the_study_project() -> None:
    assert ProjectExistence(Projects("project")).exists("project") is True
    assert ProjectExistence(Projects("project")).exists("other") is False


def test_source_membership_requires_the_source() -> None:
    missing = Sources(found=False)
    with pytest.raises(NotFoundError, match="^Document not found.$"):
        SourceMembership(missing).require("project", "document")
    assert missing.calls == [("project", "document")]

    SourceMembership(Sources(found=True)).require("project", "document")


def test_questions_are_read_as_practice_questions_without_reordering() -> None:
    first, second = _question("second"), _question("first")
    repository = QuestionRepository([first, second])
    questions = AuthoringPracticeQuestions(repository)

    source_questions = questions.for_source("project", source_id="document")
    assert [authored_question.id for authored_question in source_questions] == ["second", "first"]
    assert repository.source_id == "document"
    assert questions.current("project", "missing") is None
    assert questions.current_many("project", ["missing", "first"])[0].id == "first"


def test_a_question_standing_in_for_a_snapshot_preserves_evidence() -> None:
    source_question = PracticeSourceQuestion(
        id="question",
        choices=("A", "B"),
        correct_answer="A",
        question="Q?",
        rationale=None,
        citation_page=1,
        source_excerpt=None,
        source_id="document",
        answer_key_source="source",
    )

    shown = source_question.as_question()
    current = AuthoringPracticeQuestions(QuestionRepository([_question("question")])).current(
        "project", "question"
    )

    assert shown.answer_key_source == "source"
    assert current is not None
    assert current.as_question().source_id == "document"


def test_a_non_text_answer_key_source_is_left_out() -> None:
    source_question = AuthoringPracticeQuestions(
        QuestionRepository([_question("question", answer_key_source=None)])
    ).current("project", "question")

    assert source_question is not None
    assert source_question.answer_key_source is None
