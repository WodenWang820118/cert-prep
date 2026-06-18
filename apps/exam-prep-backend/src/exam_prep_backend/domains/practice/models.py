from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class PracticeSessionStatus(str, Enum):
    ACTIVE = "active"


class PracticeSessionMode(str, Enum):
    RANDOM_DRAW = "random_draw"
    FULL_DOCUMENT = "full_document"


class QuestionDraftStatus(str, Enum):
    DRAFT = "draft"
    APPROVED = "approved"


@dataclass(frozen=True, slots=True)
class PracticeSession:
    id: str
    project_id: str
    question_ids: tuple[str, ...]
    created_at: str
    status: PracticeSessionStatus = PracticeSessionStatus.ACTIVE
    mode: PracticeSessionMode = PracticeSessionMode.RANDOM_DRAW
    source_document_id: str | None = None
    requested_question_count: int = 10
    random_seed: int | None = None
    completed_at: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "question_ids", tuple(self.question_ids))
        object.__setattr__(self, "status", PracticeSessionStatus(self.status))
        object.__setattr__(self, "mode", PracticeSessionMode(self.mode))

    def includes_question(self, question_id: str) -> bool:
        return question_id in self.question_ids

    def to_record(self) -> dict[str, object]:
        return {
            "id": self.id,
            "project_id": self.project_id,
            "question_ids": list(self.question_ids),
            "status": self.status.value,
            "mode": self.mode.value,
            "document_id": self.source_document_id,
            "question_count": self.requested_question_count,
            "random_seed": self.random_seed,
            "created_at": self.created_at,
            "completed_at": self.completed_at,
        }


@dataclass(frozen=True, slots=True)
class PracticeQuestion:
    id: str
    choices: tuple[str, ...]
    correct_answer: str | None
    question: str = ""
    status: QuestionDraftStatus = QuestionDraftStatus.APPROVED
    rationale: str | None = None
    citation_page: int | None = None
    source_excerpt: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "choices", tuple(self.choices))
        object.__setattr__(self, "status", QuestionDraftStatus(self.status))

    def has_choice(self, selected_answer: str) -> bool:
        return selected_answer in self.choices

    def is_correct(self, selected_answer: str) -> bool:
        return selected_answer == self.correct_answer


@dataclass(frozen=True, slots=True)
class PracticeAttempt:
    id: str
    session_id: str
    project_id: str
    question_id: str
    selected_answer: str
    is_correct: bool
    created_at: str

    def to_record(self) -> dict[str, object]:
        return {
            "id": self.id,
            "session_id": self.session_id,
            "project_id": self.project_id,
            "question_id": self.question_id,
            "selected_answer": self.selected_answer,
            "is_correct": self.is_correct,
            "created_at": self.created_at,
        }


@dataclass(frozen=True, slots=True)
class WrongAnswer:
    attempt_id: str
    session_id: str
    question_id: str
    question: str
    selected_answer: str
    correct_answer: str | None
    rationale: str | None
    citation_page: int | None
    source_excerpt: str | None
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
            selected_answer=attempt.selected_answer,
            correct_answer=question.correct_answer,
            rationale=question.rationale,
            citation_page=question.citation_page,
            source_excerpt=question.source_excerpt,
            created_at=attempt.created_at,
        )

    def to_record(self) -> dict[str, object]:
        return {
            "attempt_id": self.attempt_id,
            "session_id": self.session_id,
            "question_id": self.question_id,
            "question": self.question,
            "selected_answer": self.selected_answer,
            "correct_answer": self.correct_answer,
            "rationale": self.rationale,
            "citation_page": self.citation_page,
            "source_excerpt": self.source_excerpt,
            "created_at": self.created_at,
        }
