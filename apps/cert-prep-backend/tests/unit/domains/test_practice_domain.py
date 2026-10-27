import pytest

from cert_prep_backend.practice.domain import (
    NO_PLAYABLE_QUESTIONS_MESSAGE,
    QUESTION_NOT_IN_SESSION_MESSAGE,
    SELECTED_ANSWER_NOT_AVAILABLE_MESSAGE,
    PracticeAttempt,
    PracticeQuestion,
    PracticeRuleViolation,
    PracticeSession,
    PracticeSessionMode,
    PracticeSessionStatus,
    QuestionDraftStatus,
    answer_matches_key,
    current_wrong_answers,
    select_questions,
)


def _never_seed() -> int:
    raise AssertionError("a seed was not needed")


def test_practice_enums_keep_their_serialized_values() -> None:
    session = PracticeSession(
        id="session-1",
        project_id="project-1",
        question_ids=("question-1",),
        status="active",
        created_at="2026-06-11T00:00:00Z",
    )
    question = PracticeQuestion(
        id="question-1",
        choices=("A", "B"),
        correct_answer="B",
        status="approved",
    )

    assert PracticeSessionStatus.ACTIVE.value == "active"
    assert PracticeSessionStatus.COMPLETED.value == "completed"
    assert PracticeSessionStatus.ABANDONED.value == "abandoned"
    assert QuestionDraftStatus.APPROVED.value == "approved"
    assert session.status is PracticeSessionStatus.ACTIVE
    assert session.question_ids == ("question-1",)
    assert session.mode is PracticeSessionMode.RANDOM_DRAW
    assert session.source_document_id is None
    assert session.requested_question_count == 10
    assert session.random_seed is None
    assert session.completed_at is None
    assert session.abandoned_at is None
    assert question.status is QuestionDraftStatus.APPROVED


def test_ordered_selection_keeps_playable_order_and_requires_questions() -> None:
    selection = select_questions(
        PracticeSessionMode.FULL_DOCUMENT,
        ["q-1", "q-2", "q-3"],
        requested_count=2,
        random_seed=None,
        document_id="document-1",
        new_seed=_never_seed,
    )

    assert selection.question_ids == ("q-1", "q-2")
    assert selection.document_id == "document-1"
    with pytest.raises(PracticeRuleViolation) as exc_info:
        select_questions(
            PracticeSessionMode.REVIEW_RETRY,
            [],
            requested_count=10,
            random_seed=None,
            document_id=None,
            new_seed=_never_seed,
        )
    assert str(exc_info.value) == NO_PLAYABLE_QUESTIONS_MESSAGE


def test_playable_question_requires_complete_approved_grounded_content() -> None:
    question = PracticeQuestion(
        id="question-1",
        question="Which access model should be applied?",
        choices=("Use least privilege", "Allow unrestricted access"),
        correct_answer="Use least privilege",
        rationale="The document says permissions should remain scoped.",
        citation_page=1,
    )

    assert question.is_playable() is True
    unplayable = [
        PracticeQuestion(
            id="blank-question",
            question="   ",
            choices=question.choices,
            correct_answer=question.correct_answer,
            rationale=question.rationale,
            citation_page=question.citation_page,
        ),
        PracticeQuestion(
            id="one-real-choice",
            question=question.question,
            choices=("Use least privilege", "   "),
            correct_answer=question.correct_answer,
            rationale=question.rationale,
            citation_page=question.citation_page,
        ),
        PracticeQuestion(
            id="answer-not-a-choice",
            question=question.question,
            choices=question.choices,
            correct_answer="Missing answer",
            rationale=question.rationale,
            citation_page=question.citation_page,
        ),
        PracticeQuestion(
            id="blank-rationale",
            question=question.question,
            choices=question.choices,
            correct_answer=question.correct_answer,
            rationale=" ",
            citation_page=question.citation_page,
        ),
        PracticeQuestion(
            id="no-evidence",
            question=question.question,
            choices=question.choices,
            correct_answer=question.correct_answer,
            rationale=question.rationale,
            citation_page=None,
            source_excerpt="",
        ),
    ]
    assert [item.id for item in unplayable if item.is_playable()] == []


def test_answering_checks_membership_and_choice_and_grades_the_answer() -> None:
    session = PracticeSession(
        id="session-1",
        project_id="project-1",
        question_ids=("question-1",),
        created_at="2026-06-11T00:00:00Z",
    )
    question = PracticeQuestion(
        id="question-1",
        choices=("Ignore the cited source", "Apply the cited concept"),
        correct_answer="Apply the cited concept",
    )

    attempt = session.answer(
        attempt_id="attempt-1",
        question=question,
        selected_answer="Ignore the cited source",
        now="2026-06-11T00:01:00Z",
    )

    assert attempt == PracticeAttempt(
        id="attempt-1",
        session_id="session-1",
        project_id="project-1",
        question_id="question-1",
        selected_answer="Ignore the cited source",
        is_correct=False,
        created_at="2026-06-11T00:01:00Z",
    )
    corrected = session.answer(
        attempt_id="attempt-2",
        question=question,
        selected_answer="Apply the cited concept",
        now="2026-06-11T00:02:00Z",
    )
    assert corrected.is_correct is True

    with pytest.raises(PracticeRuleViolation) as missing_choice:
        session.answer(
            attempt_id="attempt-3",
            question=question,
            selected_answer="Not a listed choice",
            now="2026-06-11T00:03:00Z",
        )
    assert str(missing_choice.value) == SELECTED_ANSWER_NOT_AVAILABLE_MESSAGE

    with pytest.raises(PracticeRuleViolation) as outside_session:
        session.answer(
            attempt_id="attempt-4",
            question=PracticeQuestion(id="question-2", choices=("A", "B"), correct_answer="A"),
            selected_answer="A",
            now="2026-06-11T00:04:00Z",
        )
    assert str(outside_session.value) == QUESTION_NOT_IN_SESSION_MESSAGE


def test_current_wrong_answers_uses_latest_attempt_per_question() -> None:
    questions = {
        "question-1": PracticeQuestion(
            id="question-1",
            question="What should you do with cited concepts?",
            choices=("Ignore the cited source", "Apply the cited concept"),
            correct_answer="Apply the cited concept",
            rationale="The citation supports applying the concept.",
            citation_page=1,
            source_excerpt="Least privilege keeps permissions scoped.",
        ),
        "question-2": PracticeQuestion(
            id="question-2",
            question="Which answer is grounded?",
            choices=("Ungrounded", "Grounded"),
            correct_answer="Grounded",
            rationale="The page says it directly.",
            citation_page=2,
            source_excerpt="Grounded answer evidence.",
        ),
    }
    attempts = [
        PracticeAttempt(
            id="attempt-old-wrong",
            session_id="session-1",
            project_id="project-1",
            question_id="question-1",
            selected_answer="Ignore the cited source",
            is_correct=False,
            created_at="2026-06-11T00:01:00Z",
        ),
        PracticeAttempt(
            id="attempt-new-correct",
            session_id="session-1",
            project_id="project-1",
            question_id="question-1",
            selected_answer="Apply the cited concept",
            is_correct=True,
            created_at="2026-06-11T00:03:00Z",
        ),
        PracticeAttempt(
            id="attempt-latest-wrong",
            session_id="session-1",
            project_id="project-1",
            question_id="question-2",
            selected_answer="Ungrounded",
            is_correct=False,
            created_at="2026-06-11T00:04:00Z",
        ),
    ]

    wrong_answers = current_wrong_answers(attempts, questions)

    assert [item.question_id for item in wrong_answers] == ["question-2"]
    wrong = wrong_answers[0]
    assert (wrong.attempt_id, wrong.selected_answer, wrong.correct_answer) == (
        "attempt-latest-wrong",
        "Ungrounded",
        "Grounded",
    )
    assert (wrong.citation_page, wrong.document_id, wrong.created_at) == (
        2,
        None,
        "2026-06-11T00:04:00Z",
    )


def test_regrading_uses_the_same_key_match_as_answering() -> None:
    session = PracticeSession(
        id="session-1",
        project_id="project-1",
        question_ids=("question-1",),
        created_at="2026-06-11T00:00:00Z",
    )
    question = PracticeQuestion(
        id="question-1",
        choices=("Ignore the cited source", "Apply the cited concept"),
        correct_answer="Apply the cited concept",
    )
    attempt = session.answer(
        attempt_id="attempt-1",
        question=question,
        selected_answer="Ignore the cited source",
        now="2026-06-11T00:01:00Z",
    )

    assert attempt.is_correct is False
    assert attempt.is_correct is question.is_correct(attempt.selected_answer)
    assert attempt.is_correct is answer_matches_key(
        attempt.selected_answer, question.correct_answer
    )
    assert answer_matches_key("Apply the cited concept", None) is False
    assert answer_matches_key("Apply ", "Apply") is False

    unchanged = attempt.regraded(question.correct_answer)
    assert unchanged is attempt

    corrected_key = PracticeQuestion(
        id=question.id,
        choices=question.choices,
        correct_answer=attempt.selected_answer,
    )
    graded_again = session.answer(
        attempt_id="attempt-2",
        question=corrected_key,
        selected_answer=attempt.selected_answer,
        now="2026-06-11T00:02:00Z",
    )
    regraded = attempt.regraded(corrected_key.correct_answer)
    assert regraded is not attempt
    assert regraded.is_correct is graded_again.is_correct is True
    assert regraded.selected_answer == attempt.selected_answer

    marked_wrong = regraded.regraded(question.correct_answer)
    assert marked_wrong.is_correct is False
    assert marked_wrong is not regraded
