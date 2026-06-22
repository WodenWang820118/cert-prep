from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from exam_prep_backend.domains.exam_content import QuestionItemKind, QuestionItemKindValue
from exam_prep_backend.domains.mock_exams.models import (
    AnswerKeySource,
    AnswerKeySourceValue,
    DraftGenerationStrategy,
    DraftStatusValue,
)


class DraftGenerateRequest(BaseModel):
    limit: int = Field(default=5, ge=1, le=50)
    strategy: DraftGenerationStrategy = DraftGenerationStrategy.DETERMINISTIC_ONLY


class QuestionDraftCreate(BaseModel):
    question: str = ""
    choices: list[str] = Field(default_factory=list)
    answer: str | None = None
    answer_key_source: AnswerKeySourceValue = AnswerKeySource.MANUAL
    rationale: str | None = None
    citation_page: int | None = Field(default=None, ge=1)
    source_excerpt: str | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    document_id: str | None = None
    chunk_id: str | None = None
    source_order: int | None = Field(default=None, ge=0)
    source_question_number: str | None = None
    item_kind: QuestionItemKindValue = QuestionItemKind.UNKNOWN
    group_key: str | None = None
    group_prompt: str | None = None


class QuestionDraftUpdate(BaseModel):
    question: str | None = None
    choices: list[str] | None = None
    answer: str | None = None
    answer_key_source: AnswerKeySourceValue | None = None
    rationale: str | None = None
    citation_page: int | None = Field(default=None, ge=1)
    source_excerpt: str | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    source_order: int | None = Field(default=None, ge=0)
    source_question_number: str | None = None
    item_kind: QuestionItemKindValue | None = None
    group_key: str | None = None
    group_prompt: str | None = None


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
    confidence: float | None
    source_order: int | None
    source_question_number: str | None
    item_kind: QuestionItemKindValue
    group_key: str | None
    group_prompt: str | None
    status: DraftStatusValue
    rejection_reason: str | None
    created_at: str
    updated_at: str


class QuestionDraftList(BaseModel):
    items: list[QuestionDraftRead]


class DraftGenerationJobRead(BaseModel):
    id: str
    project_id: str
    document_id: str
    chunk_id: str
    page_number: int
    strategy: DraftGenerationStrategy
    status: str
    provider: str
    model: str
    generated_count: int
    retry_count: int
    last_error: str | None
    created_at: str
    updated_at: str


class DraftGenerationJobList(BaseModel):
    items: list[DraftGenerationJobRead]


class LLMHealthRead(BaseModel):
    provider: str
    model: str
    available: bool
    detail: str
    unavailable_reason: str | None = None
    configured_model: str | None = None
    effective_model: str | None = None
    fallback_models: list[str] = Field(default_factory=list)
    fallback_reason: str | None = None


class ModelDownloadRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    provider: str
    model: str
    status: str
    detail: str
    completed: int | None
    total: int | None
    created_at: str
    updated_at: str
    error: str | None = None
