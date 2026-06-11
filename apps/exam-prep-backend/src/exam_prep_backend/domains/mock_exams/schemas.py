from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from exam_prep_backend.domains.mock_exams.downloads import ModelDownloadStatus
from exam_prep_backend.domains.mock_exams.models import (
    AnswerKeySource,
    AnswerKeySourceValue,
    DraftStatusValue,
)


class DraftGenerateRequest(BaseModel):
    limit: int = Field(default=5, ge=1, le=50)


class QuestionDraftCreate(BaseModel):
    question: str = ""
    choices: list[str] = Field(default_factory=list)
    answer: str | None = None
    answer_key_source: AnswerKeySourceValue = AnswerKeySource.MANUAL
    rationale: str | None = None
    citation_page: int | None = Field(default=None, ge=1)
    source_excerpt: str | None = None
    document_id: str | None = None
    chunk_id: str | None = None


class QuestionDraftUpdate(BaseModel):
    question: str | None = None
    choices: list[str] | None = None
    answer: str | None = None
    answer_key_source: AnswerKeySourceValue | None = None
    rationale: str | None = None
    citation_page: int | None = Field(default=None, ge=1)
    source_excerpt: str | None = None


class QuestionDraftRead(BaseModel):
    id: str
    project_id: str
    document_id: str | None
    chunk_id: str | None
    question: str
    choices: list[str]
    answer: str | None
    answer_key_source: AnswerKeySourceValue
    rationale: str | None
    citation_page: int | None
    source_excerpt: str | None
    status: DraftStatusValue
    rejection_reason: str | None
    created_at: str
    updated_at: str


class QuestionDraftList(BaseModel):
    items: list[QuestionDraftRead]


class LLMHealthRead(BaseModel):
    provider: str
    model: str
    available: bool
    detail: str


class ModelDownloadRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    provider: str
    model: str
    status: ModelDownloadStatus
    detail: str
    completed: int | None
    total: int | None
    created_at: str
    updated_at: str
