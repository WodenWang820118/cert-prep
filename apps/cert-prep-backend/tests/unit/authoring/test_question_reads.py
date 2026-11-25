"""Question reads practice asks for: questions, one question, and questions by id."""

from __future__ import annotations

from collections.abc import Sequence

from cert_prep_backend.authoring.application import use_cases
from cert_prep_backend.authoring.domain.question import Question


def _question(question_id: str, *, source_order: int | None = None) -> Question:
    return Question(
        id=question_id,
        project_id="project",
        document_id="document",
        chunk_id=None,
        question=f"Question {question_id}?",
        choices=("A", "B"),
        answer="A",
        answer_key_source="manual",
        rationale="Because",
        citation_page=1,
        citation_locator_kind="page",
        citation_start_ms=None,
        citation_end_ms=None,
        source_excerpt="Excerpt",
        confidence=None,
        source_order=source_order,
        source_question_number=None,
        item_kind="unknown",
        group_key=None,
        group_prompt=None,
        created_at="t1",
        updated_at="t1",
    )


class RecordingQuestions:
    def __init__(self, questions: list[Question]) -> None:
        self.questions = {authored_question.id: authored_question for authored_question in questions}
        self.source_calls: list[tuple[str, str | None]] = []
        self.find_calls: list[tuple[str, str]] = []
        self.find_many_calls: list[tuple[str, tuple[str, ...]]] = []

    def for_source(self, project_id: str, *, document_id: str | None) -> list[Question]:
        self.source_calls.append((project_id, document_id))
        return list(self.questions.values())

    def find(self, project_id: str, question_id: str) -> Question | None:
        self.find_calls.append((project_id, question_id))
        authored_question = self.questions.get(question_id)
        return authored_question if authored_question is not None and authored_question.project_id == project_id else None

    def find_many(self, project_id: str, question_ids: Sequence[str]) -> list[Question]:
        self.find_many_calls.append((project_id, tuple(question_ids)))
        return [
            authored_question
            for question_id in question_ids
            if (authored_question := self.questions.get(question_id)) is not None and authored_question.project_id == project_id
        ]


def test_source_questions_returns_the_repository_order() -> None:
    first, second = _question("a", source_order=2), _question("b", source_order=1)
    questions = RecordingQuestions([first, second])

    assert use_cases.source_questions(questions, "project", document_id="document") == [
        first,
        second,
    ]
    assert questions.source_calls == [("project", "document")]


def test_find_question_is_none_when_the_question_is_gone() -> None:
    questions = RecordingQuestions([_question("kept")])

    assert use_cases.find_question(questions, "project", "kept") == questions.questions["kept"]
    assert use_cases.find_question(questions, "project", "missing") is None
    assert questions.find_calls == [("project", "kept"), ("project", "missing")]


def test_questions_for_skips_ids_with_no_question() -> None:
    kept = _question("kept")
    questions = RecordingQuestions([kept])

    assert use_cases.questions_for(questions, "project", ["missing", "kept"]) == [kept]
    assert questions.find_many_calls == [("project", ("missing", "kept"))]
