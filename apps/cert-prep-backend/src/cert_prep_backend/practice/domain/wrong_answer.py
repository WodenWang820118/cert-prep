"""Wrong answers and their review: which questions a learner still gets wrong."""

from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass

from cert_prep_backend.practice.domain.attempt import PracticeAttempt
from cert_prep_backend.practice.domain.session import PracticeQuestion


@dataclass(frozen=True, slots=True)
class WrongAnswer:
    """A question whose latest answer was wrong, with what the learner chose."""

    attempt_id: str
    session_id: str
    question_id: str
    question: str
    choices: tuple[str, ...]
    selected_answer: str
    correct_answer: str | None
    rationale: str | None
    citation_page: int | None
    source_excerpt: str | None
    document_id: str | None
    created_at: str

    @classmethod
    def from_attempt_and_question(
        cls, attempt: PracticeAttempt, question: PracticeQuestion
    ) -> WrongAnswer:
        return cls(
            attempt_id=attempt.id,
            session_id=attempt.session_id,
            question_id=attempt.question_id,
            question=question.question,
            choices=question.choices,
            selected_answer=attempt.selected_answer,
            correct_answer=question.correct_answer,
            rationale=question.rationale,
            citation_page=question.citation_page,
            source_excerpt=question.source_excerpt,
            document_id=question.document_id,
            created_at=attempt.created_at,
        )

    def as_question(self) -> PracticeQuestion:
        """The question to ask again when the learner retries it."""

        return PracticeQuestion(
            id=self.question_id,
            question=self.question,
            choices=self.choices,
            correct_answer=self.correct_answer,
            rationale=self.rationale,
            citation_page=self.citation_page,
            source_excerpt=self.source_excerpt,
            document_id=self.document_id,
        )


@dataclass(frozen=True, slots=True)
class AnsweredQuestion:
    """One attempt with the question as it was asked; a project's answer history is a
    sequence of these, newest first."""

    attempt: PracticeAttempt
    question: PracticeQuestion


def current_wrong_answers(
    attempts: Iterable[PracticeAttempt],
    questions_by_id: Mapping[str, PracticeQuestion],
) -> tuple[WrongAnswer, ...]:
    """Questions whose latest attempt is wrong, newest first."""

    latest_attempt_by_question: dict[str, PracticeAttempt] = {}
    for attempt in sorted(attempts, key=lambda item: item.created_at, reverse=True):
        latest_attempt_by_question.setdefault(attempt.question_id, attempt)
    return tuple(
        WrongAnswer.from_attempt_and_question(attempt, questions_by_id[attempt.question_id])
        for attempt in latest_attempt_by_question.values()
        if not attempt.is_correct
    )


def current_wrong_answers_in(history: Sequence[AnsweredQuestion]) -> tuple[WrongAnswer, ...]:
    """Current wrong answers of an answer history (newest first)."""

    questions: dict[str, PracticeQuestion] = {}
    for answered in history:
        questions.setdefault(answered.attempt.question_id, answered.question)
    return current_wrong_answers([answered.attempt for answered in history], questions)


@dataclass(frozen=True, slots=True)
class RepeatedMiss:
    """A question answered wrong more than once."""

    question_id: str
    question: str
    document_id: str | None
    citation_page: int | None
    source_excerpt: str | None
    miss_count: int
    last_wrong_at: str


@dataclass(frozen=True, slots=True)
class WrongAnswerCluster:
    """Wrong answers grouped by the document page they come from."""

    document_id: str | None
    citation_page: int | None
    current_wrong_count: int
    cleared_count: int
    last_wrong_at: str | None


@dataclass(frozen=True, slots=True)
class WrongAnswerSummary:
    """How a learner is doing with the questions they got wrong. A question is cleared
    once its latest answer is right after at least one wrong answer."""

    current_wrong_count: int
    cleared_count: int
    last_wrong_date: str | None
    repeated_misses: tuple[RepeatedMiss, ...]
    clusters: tuple[WrongAnswerCluster, ...]

    @classmethod
    def from_history(cls, history: Sequence[AnsweredQuestion]) -> WrongAnswerSummary:
        attempts = [answered.attempt for answered in history]
        wrong = [answered for answered in history if not answered.attempt.is_correct]
        current = current_wrong_answers_in(history)
        wrong_count_by_question = Counter(answered.attempt.question_id for answered in wrong)
        last_wrong_by_question: dict[str, str] = {}
        questions: dict[str, PracticeQuestion] = {}
        for answered in wrong:
            last_wrong_by_question.setdefault(answered.attempt.question_id, answered.attempt.created_at)
            questions.setdefault(answered.attempt.question_id, answered.question)

        latest_attempt_by_question: dict[str, PracticeAttempt] = {}
        for attempt in sorted(attempts, key=lambda item: item.created_at, reverse=True):
            latest_attempt_by_question.setdefault(attempt.question_id, attempt)
        cleared_question_ids = {
            question_id
            for question_id, attempt in latest_attempt_by_question.items()
            if attempt.is_correct and wrong_count_by_question[question_id] > 0
        }
        return cls(
            current_wrong_count=len(current),
            cleared_count=len(cleared_question_ids),
            last_wrong_date=wrong[0].attempt.created_at if wrong else None,
            repeated_misses=_repeated_misses(wrong_count_by_question, questions, last_wrong_by_question),
            clusters=_clusters(current, cleared_question_ids, questions, last_wrong_by_question),
        )


def _repeated_misses(
    wrong_count_by_question: Counter[str],
    questions: dict[str, PracticeQuestion],
    last_wrong_by_question: dict[str, str],
) -> tuple[RepeatedMiss, ...]:
    repeated = [
        RepeatedMiss(
            question_id=question_id,
            question=questions[question_id].question,
            document_id=questions[question_id].document_id,
            citation_page=questions[question_id].citation_page,
            source_excerpt=questions[question_id].source_excerpt,
            miss_count=miss_count,
            last_wrong_at=last_wrong_by_question[question_id],
        )
        for question_id, miss_count in wrong_count_by_question.items()
        if miss_count > 1 and question_id in questions
    ]
    return tuple(
        sorted(repeated, key=lambda item: (-item.miss_count, item.last_wrong_at, item.question_id))
    )


def _clusters(
    current: tuple[WrongAnswer, ...],
    cleared_question_ids: set[str],
    questions: dict[str, PracticeQuestion],
    last_wrong_by_question: dict[str, str],
) -> tuple[WrongAnswerCluster, ...]:
    counts: defaultdict[tuple[str | None, int | None], dict] = defaultdict(
        lambda: {"current": 0, "cleared": 0, "last_wrong_at": None}
    )
    for wrong_answer in current:
        cluster = counts[(wrong_answer.document_id, wrong_answer.citation_page)]
        cluster["current"] += 1
        cluster["last_wrong_at"] = _latest(cluster["last_wrong_at"], wrong_answer.created_at)
    for question_id in cleared_question_ids:
        question = questions.get(question_id)
        if question is None:
            continue
        cluster = counts[(question.document_id, question.citation_page)]
        cluster["cleared"] += 1
        cluster["last_wrong_at"] = _latest(cluster["last_wrong_at"], last_wrong_by_question[question_id])
    clusters = [
        WrongAnswerCluster(
            document_id=document_id,
            citation_page=citation_page,
            current_wrong_count=cluster["current"],
            cleared_count=cluster["cleared"],
            last_wrong_at=cluster["last_wrong_at"],
        )
        for (document_id, citation_page), cluster in counts.items()
    ]
    return tuple(
        sorted(
            clusters,
            key=lambda item: (
                item.document_id or "",
                item.citation_page if item.citation_page is not None else -1,
            ),
        )
    )


def _latest(current: str | None, candidate: str) -> str:
    if current is None or candidate > current:
        return candidate
    return current
