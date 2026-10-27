"""Regrading one question applies the current answer key to every stored attempt."""

from __future__ import annotations

import pytest

from cert_prep_backend.platform.errors import NotFoundError
from cert_prep_backend.practice.application.use_cases import QuestionRegrade, regrade_question
from cert_prep_backend.practice.domain.attempt import PracticeAttempt
from cert_prep_backend.practice.domain.session import PracticeQuestion


def _attempt(
    attempt_id: str,
    *,
    question_id: str = "question-1",
    selected_answer: str = "Allow unrestricted access",
    is_correct: bool = False,
    created_at: str = "2026-06-11T00:01:00Z",
    project_id: str = "project-1",
) -> PracticeAttempt:
    return PracticeAttempt(
        id=attempt_id,
        session_id="session-1",
        project_id=project_id,
        question_id=question_id,
        selected_answer=selected_answer,
        is_correct=is_correct,
        created_at=created_at,
    )


def _question(
    *,
    question_id: str = "question-1",
    correct_answer: str | None = "Allow unrestricted access",
) -> PracticeQuestion:
    return PracticeQuestion(
        id=question_id,
        choices=("Use least privilege", "Allow unrestricted access"),
        correct_answer=correct_answer,
    )


class FakePractice:
    def __init__(
        self,
        *,
        project_exists: bool = True,
        question: PracticeQuestion | None = None,
        attempts: list[PracticeAttempt] | None = None,
    ) -> None:
        self._project_exists = project_exists
        self.question = question
        self.attempts = list(attempts or [])
        self.saved: list[PracticeAttempt] = []
        self.question_queries: list[tuple[str, str]] = []
        self.attempt_queries: list[tuple[str, str]] = []

    def project_exists(self, project_id: str) -> bool:
        return self._project_exists and project_id == "project-1"

    def current_question(self, project_id: str, question_id: str) -> PracticeQuestion | None:
        self.question_queries.append((project_id, question_id))
        if self.question is None or self.question.id != question_id:
            return None
        return self.question

    def attempts_for_question(self, project_id: str, question_id: str) -> list[PracticeAttempt]:
        self.attempt_queries.append((project_id, question_id))
        return [
            attempt
            for attempt in self.attempts
            if attempt.project_id == project_id and attempt.question_id == question_id
        ]

    def save_attempt_grades(self, attempts: list[PracticeAttempt]) -> None:
        self.saved.extend(attempts)


class FakeStore:
    def __init__(self, practice: FakePractice) -> None:
        self.practice = practice

    def writing(self) -> _UnitOfWork:
        return _UnitOfWork(self.practice)


class _UnitOfWork:
    def __init__(self, practice: FakePractice) -> None:
        self._practice = practice

    def __enter__(self) -> FakePractice:
        return self._practice

    def __exit__(self, *_exc: object) -> None:
        return None


def test_regrade_marks_attempts_that_now_match_and_reports_the_latest() -> None:
    older_wrong = _attempt("attempt-old", created_at="2026-06-11T00:01:00Z")
    latest_wrong = _attempt(
        "attempt-new",
        selected_answer="Use least privilege",
        created_at="2026-06-11T00:02:00Z",
    )
    other_question = _attempt("attempt-other", question_id="question-2", is_correct=False)
    practice = FakePractice(
        question=_question(),
        attempts=[older_wrong, latest_wrong, other_question],
    )

    result = regrade_question(FakeStore(practice), "project-1", "question-1")

    assert result == QuestionRegrade(
        question_id="question-1",
        regraded_attempts=1,
        latest_attempt_wrong=True,
    )
    assert practice.question_queries == [("project-1", "question-1")]
    assert practice.attempt_queries == [("project-1", "question-1")]
    assert [attempt.id for attempt in practice.saved] == ["attempt-old"]
    assert practice.saved[0].is_correct is True
    assert practice.saved[0] is not older_wrong
    assert latest_wrong.is_correct is False
    assert other_question.is_correct is False


def test_regrade_marks_a_previously_correct_attempt_wrong_when_the_key_changes() -> None:
    attempt = _attempt(
        "attempt-1",
        selected_answer="Use least privilege",
        is_correct=True,
    )
    practice = FakePractice(
        question=_question(correct_answer="Allow unrestricted access"),
        attempts=[attempt],
    )

    result = regrade_question(FakeStore(practice), "project-1", "question-1")

    assert result.regraded_attempts == 1
    assert result.latest_attempt_wrong is True
    assert practice.saved[0].is_correct is False


def test_regrade_leaves_an_unchanged_attempt_unwritten() -> None:
    attempt = _attempt("attempt-1", is_correct=True)
    practice = FakePractice(question=_question(), attempts=[attempt])

    result = regrade_question(FakeStore(practice), "project-1", "question-1")

    assert result == QuestionRegrade(
        question_id="question-1",
        regraded_attempts=0,
        latest_attempt_wrong=False,
    )
    assert practice.saved == []


def test_regrade_with_no_attempts_reports_that_the_latest_is_not_wrong() -> None:
    practice = FakePractice(question=_question(), attempts=[])

    result = regrade_question(FakeStore(practice), "project-1", "question-1")

    assert result.regraded_attempts == 0
    assert result.latest_attempt_wrong is False
    assert practice.saved == []


def test_regrade_counts_every_attempt_whose_grade_changed() -> None:
    first = _attempt("attempt-1", is_correct=False, created_at="2026-06-11T00:01:00Z")
    second = _attempt(
        "attempt-2",
        selected_answer="Use least privilege",
        is_correct=True,
        created_at="2026-06-11T00:02:00Z",
    )
    practice = FakePractice(question=_question(), attempts=[first, second])

    result = regrade_question(FakeStore(practice), "project-1", "question-1")

    assert result.regraded_attempts == 2
    assert result.latest_attempt_wrong is True
    assert [attempt.is_correct for attempt in practice.saved] == [True, False]


@pytest.mark.parametrize(
    ("project_exists", "question", "message"),
    [
        (False, _question(), "Project not found."),
        (True, None, "Question not found."),
    ],
)
def test_regrade_uses_the_same_not_found_error_as_the_other_practice_use_cases(
    project_exists: bool,
    question: PracticeQuestion | None,
    message: str,
) -> None:
    practice = FakePractice(project_exists=project_exists, question=question, attempts=[])

    with pytest.raises(NotFoundError, match=f"^{message}$"):
        regrade_question(FakeStore(practice), "project-1", "question-1")

    assert practice.saved == []
