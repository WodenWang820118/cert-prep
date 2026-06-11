from __future__ import annotations

from pydantic import BaseModel, Field


class PracticeSessionCreate(BaseModel):
    question_count: int = Field(default=10, ge=1, le=100)


class PracticeSessionRead(BaseModel):
    id: str
    project_id: str
    question_ids: list[str]
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
