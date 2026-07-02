from __future__ import annotations

from pydantic import BaseModel, Field

from cert_prep_backend.domains.practice.models import PracticeSessionMode


class PracticeSessionCreate(BaseModel):
    mode: PracticeSessionMode = PracticeSessionMode.RANDOM_DRAW
    document_id: str | None = None
    question_count: int | None = Field(default=None, ge=1, le=100)
    random_seed: int | None = None


class PracticeSessionRead(BaseModel):
    id: str
    project_id: str
    question_ids: list[str]
    mode: PracticeSessionMode
    document_id: str | None
    question_count: int
    random_seed: int | None
    status: str
    created_at: str
    completed_at: str | None


class PracticeAttemptCreate(BaseModel):
    question_id: str
    selected_answer: str = Field(min_length=1)


class PracticeAttemptRead(BaseModel):
    id: str
    session_id: str
    project_id: str
    question_id: str
    selected_answer: str
    is_correct: bool
    created_at: str


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
    created_at: str


class WrongAnswerList(BaseModel):
    items: list[WrongAnswerRead]


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
