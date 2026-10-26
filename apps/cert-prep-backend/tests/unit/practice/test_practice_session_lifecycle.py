"""The PracticeSession aggregate: how a session starts, takes answers, completes and is abandoned."""

from __future__ import annotations

import pytest

from cert_prep_backend.practice.domain import (
    PracticeQuestion,
    PracticeRuleViolation,
    PracticeSession,
    PracticeSessionConflict,
    PracticeSessionMode,
    PracticeSessionStatus,
    select_questions,
)

NOW = "2026-10-26T00:00:00+00:00"
LATER = "2026-10-26T00:05:00+00:00"


def _question(question_id: str) -> PracticeQuestion:
    return PracticeQuestion(
        id=question_id,
        question=f"Question {question_id}?",
        choices=("Right", "Wrong"),
        correct_answer="Right",
        rationale="Because.",
        citation_page=1,
    )


def _session(*question_ids: str) -> PracticeSession:
    candidates = [_question(question_id) for question_id in question_ids]
    selection = select_questions(
        PracticeSessionMode.FULL_DOCUMENT,
        list(question_ids),
        requested_count=None,
        random_seed=None,
        document_id="document-1",
        new_seed=lambda: 0,
    )
    return PracticeSession.start(
        session_id="session-1",
        project_id="project-1",
        mode=PracticeSessionMode.FULL_DOCUMENT,
        selection=selection,
        candidates=candidates,
        now=NOW,
    )


def test_a_random_draw_asks_ten_questions_unless_told_otherwise_and_keeps_its_seed() -> None:
    candidates = [f"q-{index}" for index in range(12)]

    selection = select_questions(
        PracticeSessionMode.RANDOM_DRAW,
        candidates,
        requested_count=None,
        random_seed=None,
        document_id="ignored",
        new_seed=lambda: 1234,
    )

    assert selection.question_count == 10
    assert len(selection.question_ids) == 10
    assert selection.random_seed == 1234
    assert selection.document_id is None
    again = select_questions(
        PracticeSessionMode.RANDOM_DRAW,
        candidates,
        requested_count=None,
        random_seed=1234,
        document_id=None,
        new_seed=lambda: 0,
    )
    assert again.question_ids == selection.question_ids


def test_a_random_draw_asks_at_most_the_candidates_but_records_the_requested_count() -> None:
    selection = select_questions(
        PracticeSessionMode.RANDOM_DRAW,
        ["q-1", "q-2"],
        requested_count=5,
        random_seed=7,
        document_id=None,
        new_seed=lambda: 0,
    )

    assert sorted(selection.question_ids) == ["q-1", "q-2"]
    assert selection.question_count == 5


def test_a_random_draw_without_candidates_cannot_start() -> None:
    with pytest.raises(PracticeRuleViolation):
        select_questions(
            PracticeSessionMode.RANDOM_DRAW,
            [],
            requested_count=None,
            random_seed=1,
            document_id=None,
            new_seed=lambda: 0,
        )


def test_a_new_session_is_active_and_keeps_a_snapshot_of_its_questions() -> None:
    session = _session("q-1", "q-2")

    assert session.status is PracticeSessionStatus.ACTIVE
    assert [question.id for question in session.questions] == ["q-1", "q-2"]
    assert session.requested_question_count == 2
    assert session.source_document_id == "document-1"


def test_a_session_completes_once_every_question_has_an_answer() -> None:
    session = _session("q-1", "q-2")

    assert session.complete_if_all_answered({"q-1"}, LATER) is session
    completed = session.complete_if_all_answered({"q-1", "q-2"}, LATER)
    assert completed.status is PracticeSessionStatus.COMPLETED
    assert completed.completed_at == LATER


def test_an_abandoned_session_takes_no_answers_and_stays_abandoned() -> None:
    abandoned = _session("q-1").abandon(LATER)

    assert abandoned.status is PracticeSessionStatus.ABANDONED
    assert abandoned.abandoned_at == LATER
    assert abandoned.abandon("2026-10-27T00:00:00+00:00") is abandoned
    assert abandoned.complete_if_all_answered({"q-1"}, LATER) is abandoned
    with pytest.raises(PracticeSessionConflict) as conflict:
        abandoned.answer(
            attempt_id="attempt-1", question=_question("q-1"), selected_answer="Right", now=LATER
        )
    assert conflict.value.code == "practice_session_abandoned"


def test_a_completed_session_cannot_be_abandoned_but_still_takes_answers() -> None:
    completed = _session("q-1").complete_if_all_answered({"q-1"}, LATER)

    with pytest.raises(PracticeSessionConflict) as conflict:
        completed.abandon(LATER)
    assert conflict.value.code == "practice_session_completed"
    attempt = completed.answer(
        attempt_id="attempt-2", question=_question("q-1"), selected_answer="Wrong", now=LATER
    )
    assert attempt.is_correct is False
