import pytest

from cert_prep_backend.domains.practice import (
    NO_PLAYABLE_QUESTIONS_MESSAGE,
    QUESTION_NOT_IN_SESSION_MESSAGE,
    SELECTED_ANSWER_NOT_AVAILABLE_MESSAGE,
    PracticeAttempt,
    PracticeQuestion,
    PracticeRuleViolation,
    PracticeSession,
    PracticeSessionStatus,
    QuestionDraftStatus,
    build_practice_attempt,
    current_wrong_answers,
    is_playable_practice_question,
    select_session_question_ids,
)


def test_practice_models_preserve_current_serialized_values() -> None:
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
    assert QuestionDraftStatus.APPROVED.value == "approved"
    assert session.to_record()["status"] == "active"
    assert session.to_record()["question_ids"] == ["question-1"]
    assert session.to_record()["mode"] == "random_draw"
    assert session.to_record()["document_id"] is None
    assert session.to_record()["question_count"] == 10
    assert session.to_record()["random_seed"] is None
    assert question.status is QuestionDraftStatus.APPROVED


def test_select_session_questions_preserves_playable_order_and_requires_questions() -> None:
    assert select_session_question_ids(["q-1", "q-2", "q-3"], 2) == ("q-1", "q-2")

    with pytest.raises(PracticeRuleViolation) as exc_info:
        select_session_question_ids([], 10)

    assert str(exc_info.value) == NO_PLAYABLE_QUESTIONS_MESSAGE


def test_playable_practice_question_requires_complete_approved_grounded_content() -> None:
    question = PracticeQuestion(
        id="question-1",
        question="Which access model should be applied?",
        choices=("Use least privilege", "Allow unrestricted access"),
        correct_answer="Use least privilege",
        rationale="The document says permissions should remain scoped.",
        citation_page=1,
    )

    assert is_playable_practice_question(question) is True
    assert (
        is_playable_practice_question(
            PracticeQuestion(
                id="question-2",
                question="   ",
                choices=question.choices,
                correct_answer=question.correct_answer,
                rationale=question.rationale,
                citation_page=question.citation_page,
            )
        )
        is False
    )
    assert (
        is_playable_practice_question(
            PracticeQuestion(
                id="question-3",
                question=question.question,
                choices=("Use least privilege", "   "),
                correct_answer=question.correct_answer,
                rationale=question.rationale,
                citation_page=question.citation_page,
            )
        )
        is False
    )
    assert (
        is_playable_practice_question(
            PracticeQuestion(
                id="question-4",
                question=question.question,
                choices=question.choices,
                correct_answer="Missing answer",
                rationale=question.rationale,
                citation_page=question.citation_page,
            )
        )
        is False
    )
    assert (
        is_playable_practice_question(
            PracticeQuestion(
                id="question-5",
                question=question.question,
                choices=question.choices,
                correct_answer=question.correct_answer,
                rationale=" ",
                citation_page=question.citation_page,
            )
        )
        is False
    )
    assert (
        is_playable_practice_question(
            PracticeQuestion(
                id="question-6",
                question=question.question,
                choices=question.choices,
                correct_answer=question.correct_answer,
                rationale=question.rationale,
                citation_page=None,
                source_excerpt="",
            )
        )
        is False
    )


def test_practice_attempt_policy_validates_membership_and_grades_answer() -> None:
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

    attempt = build_practice_attempt(
        attempt_id="attempt-1",
        session=session,
        question=question,
        selected_answer="Ignore the cited source",
        created_at="2026-06-11T00:01:00Z",
    )

    assert attempt.to_record() == {
        "id": "attempt-1",
        "session_id": "session-1",
        "project_id": "project-1",
        "question_id": "question-1",
        "selected_answer": "Ignore the cited source",
        "is_correct": False,
        "created_at": "2026-06-11T00:01:00Z",
    }

    corrected = build_practice_attempt(
        attempt_id="attempt-2",
        session=session,
        question=question,
        selected_answer="Apply the cited concept",
        created_at="2026-06-11T00:02:00Z",
    )

    assert corrected.is_correct is True

    with pytest.raises(PracticeRuleViolation) as missing_choice:
        build_practice_attempt(
            attempt_id="attempt-3",
            session=session,
            question=question,
            selected_answer="Not a listed choice",
            created_at="2026-06-11T00:03:00Z",
        )

    assert str(missing_choice.value) == SELECTED_ANSWER_NOT_AVAILABLE_MESSAGE

    outside_session_question = PracticeQuestion(
        id="question-2",
        choices=("A", "B"),
        correct_answer="A",
    )

    with pytest.raises(PracticeRuleViolation) as outside_session:
        build_practice_attempt(
            attempt_id="attempt-4",
            session=session,
            question=outside_session_question,
            selected_answer="A",
            created_at="2026-06-11T00:04:00Z",
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
    assert wrong_answers[0].to_record() == {
        "attempt_id": "attempt-latest-wrong",
        "session_id": "session-1",
        "question_id": "question-2",
        "question": "Which answer is grounded?",
        "selected_answer": "Ungrounded",
        "correct_answer": "Grounded",
        "rationale": "The page says it directly.",
        "citation_page": 2,
        "source_excerpt": "Grounded answer evidence.",
        "document_id": None,
        "created_at": "2026-06-11T00:04:00Z",
    }
