from __future__ import annotations

from pydantic import BaseModel, Field


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1)
    description: str = ""


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1)
    description: str | None = None


class ProjectRead(BaseModel):
    id: str
    name: str
    description: str
    created_at: str
    updated_at: str


class ProjectList(BaseModel):
    items: list[ProjectRead]


class DocumentRead(BaseModel):
    id: str
    project_id: str
    filename: str
    sha256: str
    page_count: int
    has_text: bool
    status: str
    extraction_method: str
    ocr_device: str | None
    ocr_fallback_reason: str | None
    ocr_duration_ms: int
    processed_page_count: int
    exam_item_count: int
    chunks_count: int
    created_at: str


class ChunkRead(BaseModel):
    id: str
    document_id: str
    page_number: int
    chunk_index: int
    text: str
    source_excerpt: str
    extraction_method: str
    created_at: str


class ChunkList(BaseModel):
    items: list[ChunkRead]


class DraftGenerateRequest(BaseModel):
    limit: int = Field(default=5, ge=1, le=50)


class QuestionDraftCreate(BaseModel):
    question: str = ""
    choices: list[str] = Field(default_factory=list)
    answer: str | None = None
    answer_key_source: str = "manual"
    rationale: str | None = None
    citation_page: int | None = Field(default=None, ge=1)
    source_excerpt: str | None = None
    document_id: str | None = None
    chunk_id: str | None = None


class QuestionDraftUpdate(BaseModel):
    question: str | None = None
    choices: list[str] | None = None
    answer: str | None = None
    answer_key_source: str | None = None
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
    answer_key_source: str
    rationale: str | None
    citation_page: int | None
    source_excerpt: str | None
    status: str
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


class OCRHealthRead(BaseModel):
    provider: str
    engine: str
    available: bool
    detail: str
    python_version: str
    paddle_version: str | None
    paddleocr_version: str | None
    selected_device: str | None
    cuda_available: bool
    gpu_count: int
    model_cache_dir: str | None
    fallback_reason: str | None


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
