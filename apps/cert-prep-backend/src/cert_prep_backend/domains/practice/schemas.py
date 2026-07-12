from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from cert_prep_backend.domains.practice.models import PracticeSessionMode, PracticeSessionStatus


class PracticeSessionCreate(BaseModel):
    mode: PracticeSessionMode = PracticeSessionMode.RANDOM_DRAW
    document_id: str | None = None
    question_count: int | None = Field(default=None, ge=1, le=100)
    random_seed: int | None = None
    wrong_attempt_ids: list[str] | None = None


class PracticeSessionQuestionRead(BaseModel):
    id: str
    question: str
    choices: list[str]
    answer: str | None
    rationale: str | None
    citation_page: int | None
    source_excerpt: str | None
    document_id: str | None


class PracticeAttemptRead(BaseModel):
    id: str
    session_id: str
    project_id: str
    question_id: str
    selected_answer: str
    is_correct: bool
    created_at: str


class PracticeSessionSummaryRead(BaseModel):
    id: str
    project_id: str
    mode: PracticeSessionMode
    document_id: str | None
    status: PracticeSessionStatus
    created_at: str


class PracticeSessionList(BaseModel):
    items: list[PracticeSessionSummaryRead]


class PracticeSessionConflictRead(BaseModel):
    code: Literal[
        "active_session_exists",
        "practice_session_completed",
        "practice_session_abandoned",
    ]
    message: str
    details: dict[str, object] | None = None


class PracticeSessionRead(BaseModel):
    id: str
    project_id: str
    question_ids: list[str]
    questions: list[PracticeSessionQuestionRead]
    mode: PracticeSessionMode
    document_id: str | None
    question_count: int
    random_seed: int | None
    status: PracticeSessionStatus
    created_at: str
    completed_at: str | None
    abandoned_at: str | None
    attempts: list[PracticeAttemptRead]


class PracticeAttemptCreate(BaseModel):
    question_id: str
    selected_answer: str = Field(min_length=1)


class WrongAnswerRead(BaseModel):
    attempt_id: str
    session_id: str
    question_id: str
    question: str
    selected_answer: str
    correct_answer: str | None
    rationale: str | None
    citation_page: int | None
    source_excerpt: str | None
    document_id: str | None
    created_at: str


class WrongAnswerList(BaseModel):
    items: list[WrongAnswerRead]


class WrongAnswerRepeatedMissRead(BaseModel):
    question_id: str
    question: str
    document_id: str | None
    citation_page: int | None
    source_excerpt: str | None
    miss_count: int
    last_wrong_at: str


class WrongAnswerClusterRead(BaseModel):
    document_id: str | None
    citation_page: int | None
    current_wrong_count: int
    cleared_count: int
    last_wrong_at: str | None


class WrongAnswerSummaryRead(BaseModel):
    current_wrong_count: int
    cleared_count: int
    last_wrong_date: str | None
    repeated_misses: list[WrongAnswerRepeatedMissRead]
    clusters: list[WrongAnswerClusterRead]


class WrongAnswerGroundedFields(BaseModel):
    question: str
    selected_answer: str
    correct_answer: str | None
    rationale: str | None
    citation_page: int | None
    source_excerpt: str | None


class WrongAnswerExplanationRead(BaseModel):
    attempt_id: str
    explanation: str
    provider: str
    model: str
    grounded_fields: WrongAnswerGroundedFields
    fallback: bool
