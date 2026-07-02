from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
import random

from cert_prep_backend.domains.practice.models import (
    PracticeAttempt,
    PracticeQuestion,
    PracticeSession,
    QuestionDraftStatus,
    WrongAnswer,
)


NO_PLAYABLE_QUESTIONS_MESSAGE = "No playable questions are available for practice."
DOCUMENT_REQUIRED_FOR_FULL_DOCUMENT_MESSAGE = (
    "Document id is required for full document practice."
)
QUESTION_NOT_IN_SESSION_MESSAGE = "Question is not part of this practice session."
SELECTED_ANSWER_NOT_AVAILABLE_MESSAGE = "Selected answer is not one of the available choices."


class PracticeRuleViolation(ValueError):
    pass


def is_playable_practice_question(question: PracticeQuestion) -> bool:
    if question.status is not QuestionDraftStatus.APPROVED:
        return False
    if not question.question.strip():
        return False

    nonempty_choices = [choice.strip() for choice in question.choices if choice.strip()]
    if len(nonempty_choices) < 2:
        return False

    correct_answer = (question.correct_answer or "").strip()
    if not correct_answer or correct_answer not in nonempty_choices:
        return False

    if not (question.rationale or "").strip():
        return False

    return question.citation_page is not None or bool((question.source_excerpt or "").strip())


def select_session_question_ids(
    playable_question_ids: Sequence[str], question_count: int
) -> tuple[str, ...]:
    selected_question_ids = tuple(playable_question_ids[:question_count])
    if not selected_question_ids:
        raise PracticeRuleViolation(NO_PLAYABLE_QUESTIONS_MESSAGE)
    return selected_question_ids


def select_random_session_question_ids(
    playable_question_ids: Sequence[str], question_count: int, random_seed: int
) -> tuple[str, ...]:
    if not playable_question_ids:
        raise PracticeRuleViolation(NO_PLAYABLE_QUESTIONS_MESSAGE)
    selected_count = min(question_count, len(playable_question_ids))
    return tuple(random.Random(random_seed).sample(tuple(playable_question_ids), selected_count))


def ensure_question_belongs_to_session(session: PracticeSession, question_id: str) -> None:
    if not session.includes_question(question_id):
        raise PracticeRuleViolation(QUESTION_NOT_IN_SESSION_MESSAGE)


def ensure_selected_answer_is_available(question: PracticeQuestion, selected_answer: str) -> None:
    if not question.has_choice(selected_answer):
        raise PracticeRuleViolation(SELECTED_ANSWER_NOT_AVAILABLE_MESSAGE)


def build_practice_attempt(
    *,
    attempt_id: str,
    session: PracticeSession,
    question: PracticeQuestion,
    selected_answer: str,
    created_at: str,
) -> PracticeAttempt:
    ensure_question_belongs_to_session(session, question.id)
    ensure_selected_answer_is_available(question, selected_answer)

    return PracticeAttempt(
        id=attempt_id,
        session_id=session.id,
        project_id=session.project_id,
        question_id=question.id,
        selected_answer=selected_answer,
        is_correct=question.is_correct(selected_answer),
        created_at=created_at,
    )


def current_wrong_answers(
    attempts: Iterable[PracticeAttempt],
    questions_by_id: Mapping[str, PracticeQuestion],
) -> tuple[WrongAnswer, ...]:
    latest_attempt_by_question: dict[str, PracticeAttempt] = {}
    for attempt in sorted(attempts, key=lambda item: item.created_at, reverse=True):
        latest_attempt_by_question.setdefault(attempt.question_id, attempt)

    return tuple(
        WrongAnswer.from_attempt_and_question(attempt, questions_by_id[attempt.question_id])
        for attempt in latest_attempt_by_question.values()
        if not attempt.is_correct
    )
