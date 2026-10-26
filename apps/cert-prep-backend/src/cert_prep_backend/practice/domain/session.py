"""The PracticeSession aggregate: one practice run over a fixed snapshot of questions."""

from __future__ import annotations

from collections.abc import Callable, Collection, Sequence
from dataclasses import dataclass, replace
from enum import Enum
import random

from cert_prep_backend.practice.domain.attempt import PracticeAttempt
from cert_prep_backend.practice.domain.exceptions import (
    PracticeRuleViolation,
    PracticeSessionConflict,
)

DEFAULT_RANDOM_QUESTION_COUNT = 10
NO_PLAYABLE_QUESTIONS_MESSAGE = "No playable questions are available for practice."
DOCUMENT_REQUIRED_FOR_FULL_DOCUMENT_MESSAGE = "Document id is required for full document practice."
QUESTION_NOT_IN_SESSION_MESSAGE = "Question is not part of this practice session."
SELECTED_ANSWER_NOT_AVAILABLE_MESSAGE = "Selected answer is not one of the available choices."


class PracticeSessionStatus(str, Enum):
    ACTIVE = "active"
    COMPLETED = "completed"
    ABANDONED = "abandoned"


class PracticeSessionMode(str, Enum):
    RANDOM_DRAW = "random_draw"
    FULL_DOCUMENT = "full_document"
    REVIEW_RETRY = "review_retry"


class QuestionDraftStatus(str, Enum):
    APPROVED = "approved"


@dataclass(frozen=True, slots=True)
class PracticeQuestion:
    """A question as practice sees it: an approved draft or a session's snapshot of one."""

    id: str
    choices: tuple[str, ...]
    correct_answer: str | None
    question: str = ""
    status: QuestionDraftStatus = QuestionDraftStatus.APPROVED
    rationale: str | None = None
    citation_page: int | None = None
    source_excerpt: str | None = None
    document_id: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "choices", tuple(self.choices))
        object.__setattr__(self, "status", QuestionDraftStatus(self.status))

    def has_choice(self, selected_answer: str) -> bool:
        return selected_answer in self.choices

    def is_correct(self, selected_answer: str) -> bool:
        return selected_answer == self.correct_answer

    def is_playable(self) -> bool:
        """Approved, with a question, two real choices, the answer among them, a rationale
        and a citation page or source excerpt to point back to."""

        if self.status is not QuestionDraftStatus.APPROVED:
            return False
        if not self.question.strip():
            return False
        nonempty_choices = [choice.strip() for choice in self.choices if choice.strip()]
        if len(nonempty_choices) < 2:
            return False
        correct_answer = (self.correct_answer or "").strip()
        if not correct_answer or correct_answer not in nonempty_choices:
            return False
        if not (self.rationale or "").strip():
            return False
        return self.citation_page is not None or bool((self.source_excerpt or "").strip())


@dataclass(frozen=True, slots=True)
class QuestionSelection:
    """Which questions a new session asks, and how they were chosen."""

    question_ids: tuple[str, ...]
    question_count: int
    random_seed: int | None
    document_id: str | None


def select_questions(
    mode: PracticeSessionMode,
    candidate_ids: Sequence[str],
    *,
    requested_count: int | None,
    random_seed: int | None,
    document_id: str | None,
    new_seed: Callable[[], int],
) -> QuestionSelection:
    """Choose a session's questions from the playable candidates of its mode.

    A random draw asks ten questions unless told otherwise, drawn with a seed it keeps so
    the draw can be told apart later; the other modes ask every candidate in order.
    """

    if requested_count is not None:
        question_count = requested_count
    elif mode in {PracticeSessionMode.FULL_DOCUMENT, PracticeSessionMode.REVIEW_RETRY}:
        question_count = len(candidate_ids)
    else:
        question_count = DEFAULT_RANDOM_QUESTION_COUNT

    if mode is PracticeSessionMode.RANDOM_DRAW:
        if not candidate_ids:
            raise PracticeRuleViolation(NO_PLAYABLE_QUESTIONS_MESSAGE)
        seed = random_seed if random_seed is not None else new_seed()
        drawn = min(question_count, len(candidate_ids))
        return QuestionSelection(
            question_ids=tuple(random.Random(seed).sample(tuple(candidate_ids), drawn)),
            question_count=question_count,
            random_seed=seed,
            document_id=None,
        )

    question_ids = tuple(candidate_ids[:question_count])
    if not question_ids:
        raise PracticeRuleViolation(NO_PLAYABLE_QUESTIONS_MESSAGE)
    return QuestionSelection(
        question_ids=question_ids,
        question_count=question_count,
        random_seed=None,
        document_id=document_id if mode is PracticeSessionMode.FULL_DOCUMENT else None,
    )


@dataclass(frozen=True, slots=True)
class PracticeSession:
    """A practice run. Its questions are fixed when it starts; it ends completed once every
    question has an answer, or abandoned when the learner stops."""

    id: str
    project_id: str
    question_ids: tuple[str, ...]
    created_at: str
    status: PracticeSessionStatus = PracticeSessionStatus.ACTIVE
    mode: PracticeSessionMode = PracticeSessionMode.RANDOM_DRAW
    source_document_id: str | None = None
    requested_question_count: int = DEFAULT_RANDOM_QUESTION_COUNT
    random_seed: int | None = None
    completed_at: str | None = None
    abandoned_at: str | None = None
    questions: tuple[PracticeQuestion, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "question_ids", tuple(self.question_ids))
        object.__setattr__(self, "status", PracticeSessionStatus(self.status))
        object.__setattr__(self, "mode", PracticeSessionMode(self.mode))
        object.__setattr__(self, "questions", tuple(self.questions))

    @classmethod
    def start(
        cls,
        *,
        session_id: str,
        project_id: str,
        mode: PracticeSessionMode,
        selection: QuestionSelection,
        candidates: Sequence[PracticeQuestion],
        now: str,
    ) -> PracticeSession:
        """A new active session with a snapshot of its selected questions."""

        by_id = {question.id: question for question in candidates}
        return cls(
            id=session_id,
            project_id=project_id,
            question_ids=selection.question_ids,
            created_at=now,
            mode=mode,
            source_document_id=selection.document_id,
            requested_question_count=selection.question_count,
            random_seed=selection.random_seed,
            questions=tuple(by_id[question_id] for question_id in selection.question_ids),
        )

    def includes_question(self, question_id: str) -> bool:
        return question_id in self.question_ids

    def abandon(self, now: str) -> PracticeSession:
        if self.status is PracticeSessionStatus.COMPLETED:
            raise PracticeSessionConflict(
                "practice_session_completed",
                "Completed practice sessions cannot be abandoned.",
            )
        if self.status is PracticeSessionStatus.ABANDONED:
            return self
        return replace(self, status=PracticeSessionStatus.ABANDONED, abandoned_at=now)

    def ensure_accepts_answers(self) -> None:
        if self.status is PracticeSessionStatus.ABANDONED:
            raise PracticeSessionConflict(
                "practice_session_abandoned",
                "Abandoned practice sessions cannot accept attempts.",
            )

    def answer(
        self,
        *,
        attempt_id: str,
        question: PracticeQuestion,
        selected_answer: str,
        now: str,
    ) -> PracticeAttempt:
        """Grade an answer to one of this session's questions."""

        self.ensure_accepts_answers()
        if not self.includes_question(question.id):
            raise PracticeRuleViolation(QUESTION_NOT_IN_SESSION_MESSAGE)
        if not question.has_choice(selected_answer):
            raise PracticeRuleViolation(SELECTED_ANSWER_NOT_AVAILABLE_MESSAGE)
        return PracticeAttempt(
            id=attempt_id,
            session_id=self.id,
            project_id=self.project_id,
            question_id=question.id,
            selected_answer=selected_answer,
            is_correct=question.is_correct(selected_answer),
            created_at=now,
        )

    def complete_if_all_answered(
        self, answered_question_ids: Collection[str], now: str
    ) -> PracticeSession:
        """Complete an active session once every one of its questions has an answer."""

        if self.status is not PracticeSessionStatus.ACTIVE:
            return self
        required = tuple(dict.fromkeys(self.question_ids))
        if not required or any(question_id not in answered_question_ids for question_id in required):
            return self
        return replace(
            self,
            status=PracticeSessionStatus.COMPLETED,
            completed_at=self.completed_at or now,
        )
