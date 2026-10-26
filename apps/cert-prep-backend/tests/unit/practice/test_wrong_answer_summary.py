"""WrongAnswerSummary: current, cleared and repeatedly missed questions, grouped by page."""

from __future__ import annotations

from cert_prep_backend.practice.domain import (
    AnsweredQuestion,
    PracticeAttempt,
    PracticeQuestion,
    WrongAnswerSummary,
)


def _answered(attempt_id: str, question_id: str, *, correct: bool, at: str, page: int) -> AnsweredQuestion:
    return AnsweredQuestion(
        attempt=PracticeAttempt(
            id=attempt_id,
            session_id="session-1",
            project_id="project-1",
            question_id=question_id,
            selected_answer="Right" if correct else "Wrong",
            is_correct=correct,
            created_at=at,
        ),
        question=PracticeQuestion(
            id=question_id,
            question=f"{question_id}?",
            choices=("Right", "Wrong"),
            correct_answer="Right",
            citation_page=page,
            document_id="document-1",
        ),
    )


def test_an_empty_history_has_nothing_to_review() -> None:
    summary = WrongAnswerSummary.from_history([])

    assert summary == WrongAnswerSummary(
        current_wrong_count=0,
        cleared_count=0,
        last_wrong_date=None,
        repeated_misses=(),
        clusters=(),
    )


def test_the_summary_counts_current_cleared_and_repeated_misses_per_page() -> None:
    # Newest first, as the repository returns the history.
    history = [
        _answered("a5", "cleared", correct=True, at="t5", page=2),
        _answered("a4", "repeated", correct=False, at="t4", page=1),
        _answered("a3", "cleared", correct=False, at="t3", page=2),
        _answered("a2", "repeated", correct=False, at="t2", page=1),
        _answered("a1", "never-wrong", correct=True, at="t1", page=3),
    ]

    summary = WrongAnswerSummary.from_history(history)

    assert summary.current_wrong_count == 1
    assert summary.cleared_count == 1
    assert summary.last_wrong_date == "t4"
    assert [(miss.question_id, miss.miss_count, miss.last_wrong_at) for miss in summary.repeated_misses] == [
        ("repeated", 2, "t4")
    ]
    assert [
        (cluster.citation_page, cluster.current_wrong_count, cluster.cleared_count, cluster.last_wrong_at)
        for cluster in summary.clusters
    ] == [(1, 1, 0, "t4"), (2, 0, 1, "t3")]
