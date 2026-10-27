"""Use cases of the Practice and Review context, named after what the learner does."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
import secrets
from uuid import uuid4

from cert_prep_backend.platform.errors import NotFoundError, ValidationError
from cert_prep_backend.practice.application.explanations import (
    WrongAnswerExplanation,
    explain_wrong_answer,
)
from cert_prep_backend.practice.application.ports import PracticeRepository, PracticeStore
from cert_prep_backend.practice.domain.attempt import PracticeAttempt
from cert_prep_backend.practice.domain.exceptions import (
    PracticeRuleViolation,
    PracticeSessionConflict,
)
from cert_prep_backend.practice.domain.session import (
    DOCUMENT_REQUIRED_FOR_FULL_DOCUMENT_MESSAGE,
    PracticeQuestion,
    PracticeSession,
    PracticeSessionMode,
    select_questions,
)
from cert_prep_backend.practice.domain.wrong_answer import (
    WrongAnswer,
    WrongAnswerSummary,
    current_wrong_answers_in,
)

__all__ = [
    "abandon_practice",
    "answer_question",
    "list_active_practice",
    "list_wrong_answers",
    "regrade_question",
    "request_explanation",
    "review_wrong_answers",
    "start_practice",
    "view_practice",
]


@dataclass(frozen=True, slots=True)
class PracticeSessionDetails:
    """A session with the attempts made in it."""

    session: PracticeSession
    attempts: tuple[PracticeAttempt, ...]


@dataclass(frozen=True, slots=True)
class QuestionRegrade:
    """How regrading one question changed the attempts stored for it."""

    question_id: str
    regraded_attempts: int
    latest_attempt_wrong: bool


def start_practice(
    store: PracticeStore,
    project_id: str,
    *,
    mode: PracticeSessionMode,
    document_id: str | None,
    question_count: int | None,
    random_seed: int | None,
    wrong_attempt_ids: Sequence[str] | None,
    now: str,
    new_seed: Callable[[], int] = lambda: secrets.randbits(63),
) -> PracticeSessionDetails:
    mode = PracticeSessionMode(mode)
    if mode is PracticeSessionMode.FULL_DOCUMENT and document_id is None:
        raise ValidationError(DOCUMENT_REQUIRED_FOR_FULL_DOCUMENT_MESSAGE)
    if mode is PracticeSessionMode.FULL_DOCUMENT:
        store.require_document(project_id, document_id)
    session_id = str(uuid4())
    with store.writing() as practice:
        _require_project(practice, project_id)
        active = practice.active_session(project_id)
        if active is not None:
            raise PracticeSessionConflict(
                "active_session_exists",
                "An active practice session already exists for this project.",
                active_session=active,
            )
        candidates = _candidates(practice, project_id, mode, document_id, wrong_attempt_ids)
        try:
            selection = select_questions(
                mode,
                [question.id for question in candidates],
                requested_count=question_count,
                random_seed=random_seed,
                document_id=document_id,
                new_seed=new_seed,
            )
        except PracticeRuleViolation as exc:
            raise ValidationError(str(exc)) from exc
        practice.add_session(
            PracticeSession.start(
                session_id=session_id,
                project_id=project_id,
                mode=mode,
                selection=selection,
                candidates=candidates,
                now=now,
            )
        )
        return _details(practice, project_id, session_id)


def list_active_practice(store: PracticeStore, project_id: str) -> list[PracticeSession]:
    with store.reading() as practice:
        _require_project(practice, project_id)
        active = practice.active_session(project_id)
    return [] if active is None else [active]


def view_practice(store: PracticeStore, project_id: str, session_id: str) -> PracticeSessionDetails:
    with store.reading() as practice:
        return _details(practice, project_id, session_id)


def abandon_practice(
    store: PracticeStore, project_id: str, session_id: str, *, now: str
) -> PracticeSessionDetails:
    with store.writing() as practice:
        session = _session(practice, project_id, session_id)
        abandoned = session.abandon(now)
        if abandoned is not session:
            practice.save_status(abandoned)
        return _details(practice, project_id, session_id)


def answer_question(
    store: PracticeStore,
    project_id: str,
    session_id: str,
    *,
    question_id: str,
    selected_answer: str,
    now: str,
) -> PracticeAttempt:
    attempt_id = str(uuid4())
    with store.writing() as practice:
        session = _session(practice, project_id, session_id)
        session.ensure_accepts_answers()
        question = practice.question_for_answer(session, question_id)
        if question is None:
            raise NotFoundError("Playable question not found.")
        try:
            attempt = session.answer(
                attempt_id=attempt_id,
                question=question,
                selected_answer=selected_answer,
                now=now,
            )
        except PracticeRuleViolation as exc:
            raise ValidationError(str(exc)) from exc
        practice.add_attempt(attempt)
        completed = session.complete_if_all_answered(practice.answered_question_ids(session), now)
        if completed is not session:
            practice.save_status(completed)
    return attempt


def regrade_question(store: PracticeStore, project_id: str, question_id: str) -> QuestionRegrade:
    """Re-evaluate every stored attempt of one question against its current answer key."""

    with store.writing() as practice:
        _require_project(practice, project_id)
        question = practice.current_question(project_id, question_id)
        if question is None:
            raise NotFoundError("Question not found.")
        attempts = practice.attempts_for_question(project_id, question_id)
        regraded = [attempt.regraded(question.correct_answer) for attempt in attempts]
        changed = [
            updated
            for original, updated in zip(attempts, regraded, strict=True)
            if updated is not original
        ]
        if changed:
            practice.save_attempt_grades(changed)
        latest_attempt_wrong = bool(regraded) and not regraded[-1].is_correct
    return QuestionRegrade(
        question_id=question.id,
        regraded_attempts=len(changed),
        latest_attempt_wrong=latest_attempt_wrong,
    )


def list_wrong_answers(store: PracticeStore, project_id: str) -> tuple[WrongAnswer, ...]:
    with store.reading() as practice:
        _require_project(practice, project_id)
        history = practice.answer_history(project_id)
    return current_wrong_answers_in(history)


def review_wrong_answers(store: PracticeStore, project_id: str) -> WrongAnswerSummary:
    with store.reading() as practice:
        _require_project(practice, project_id)
        history = practice.answer_history(project_id)
    return WrongAnswerSummary.from_history(history)


def request_explanation(
    store: PracticeStore, provider: object, project_id: str, attempt_id: str
) -> WrongAnswerExplanation:
    with store.reading() as practice:
        _require_project(practice, project_id)
        history = practice.answer_history_since(project_id, attempt_id)
    for wrong_answer in current_wrong_answers_in(history):
        if wrong_answer.attempt_id == attempt_id:
            return explain_wrong_answer(provider, wrong_answer)
    raise NotFoundError("Wrong answer not found.")


def _require_project(practice: PracticeRepository, project_id: str) -> None:
    if not practice.project_exists(project_id):
        raise NotFoundError("Project not found.")


def _session(practice: PracticeRepository, project_id: str, session_id: str) -> PracticeSession:
    session = practice.session(project_id, session_id)
    if session is None:
        raise NotFoundError("Practice session not found.")
    return session


def _details(practice: PracticeRepository, project_id: str, session_id: str) -> PracticeSessionDetails:
    session = _session(practice, project_id, session_id)
    return PracticeSessionDetails(session=session, attempts=tuple(practice.attempts_of(session)))


def _candidates(
    practice: PracticeRepository,
    project_id: str,
    mode: PracticeSessionMode,
    document_id: str | None,
    wrong_attempt_ids: Sequence[str] | None,
) -> list[PracticeQuestion]:
    if mode is PracticeSessionMode.REVIEW_RETRY:
        return _retry_candidates(practice, project_id, wrong_attempt_ids)
    approved = practice.approved_questions(
        project_id,
        document_id=document_id if mode is PracticeSessionMode.FULL_DOCUMENT else None,
    )
    return [question for question in approved if question.is_playable()]


def _retry_candidates(
    practice: PracticeRepository,
    project_id: str,
    wrong_attempt_ids: Sequence[str] | None,
) -> list[PracticeQuestion]:
    current = list(current_wrong_answers_in(practice.answer_history(project_id)))
    if wrong_attempt_ids is not None:
        by_attempt_id = {wrong_answer.attempt_id: wrong_answer for wrong_answer in current}
        try:
            current = [by_attempt_id[attempt_id] for attempt_id in dict.fromkeys(wrong_attempt_ids)]
        except KeyError as exc:
            raise ValidationError(
                "Wrong attempt ids must refer to current wrong answers in this project."
            ) from exc
    if not current:
        raise ValidationError("No current wrong answers are available for review retry.")
    return [wrong_answer.as_question() for wrong_answer in current]
