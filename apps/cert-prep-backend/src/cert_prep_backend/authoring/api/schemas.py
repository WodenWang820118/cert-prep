from __future__ import annotations

from pydantic import BaseModel, Field

from cert_prep_backend.source_library.domain.exam_content import QuestionItemKind, QuestionItemKindValue
from cert_prep_backend.authoring.domain.models import (
    AnswerKeySource,
    AnswerKeySourceValue,
    DraftGenerationStrategy,
    DraftStatusValue,
)
from cert_prep_backend.authoring.domain.generation import (
    DraftGenerationJobStatus,
    ManualDraftOperationStatus,
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
    citation_locator_kind: str = "page"
    citation_start_ms: int | None = None
    citation_end_ms: int | None = None
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
    status: DraftGenerationJobStatus
    phase: str
    cancellable: bool
    provider: str
    model: str
    effective_provider: str | None
    effective_model: str | None
    fallback_reason: str | None
    generated_count: int
    retry_count: int
    last_error: str | None
    created_at: str
    updated_at: str


class DraftGenerationJobList(BaseModel):
    items: list[DraftGenerationJobRead]


class UnavailableDraftBlockRead(BaseModel):
    status: str = "needs_review"
    chunk_id: str
    citation_page: int
    source_excerpt: str
    source_order: int | None = None
    source_question_number: str | None = None
    reason: str


class ManualDraftGenerationOperationRead(BaseModel):
    id: str
    project_id: str
    document_id: str
    limit: int
    strategy: DraftGenerationStrategy
    status: ManualDraftOperationStatus
    phase: str
    cancellable: bool
    provider: str
    model: str
    effective_provider: str | None = None
    effective_model: str | None = None
    fallback_reason: str | None = None
    generated_count: int
    unavailable_blocks: list[UnavailableDraftBlockRead] = Field(default_factory=list)
    error: str | None = None
    created_at: str
    updated_at: str
    commit_started_at: str | None = None
