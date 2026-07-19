from __future__ import annotations

from pydantic import BaseModel

from cert_prep_backend.domains.exam_content import ContentProfileValue
from cert_prep_backend.domains.source_documents.models import (
    DocumentStatus,
    ExtractionMethod,
)


class DocumentRead(BaseModel):
    id: str
    project_id: str
    filename: str
    sha256: str
    language_hint: str
    page_count: int
    has_text: bool
    status: DocumentStatus
    extraction_method: ExtractionMethod
    ocr_device: str | None
    ocr_fallback_reason: str | None
    ocr_duration_ms: int
    processed_page_count: int
    parse_wall_duration_ms: int
    render_duration_ms: int
    ocr_engine_duration_ms: int
    ocr_worker_count: int
    first_chunk_ms: int
    exam_item_count: int
    content_profile: ContentProfileValue
    classification_detail: str
    chunks_count: int
    created_at: str
    updated_at: str
    source_kind: str = "document"
    duration_ms: int | None = None
    transcription_status: str = "not_applicable"
    translation_status: str = "not_applicable"
    configured_transcription_model: str | None = None
    effective_transcription_model: str | None = None
    transcription_device: str | None = None
    transcription_warning: str | None = None


class DocumentList(BaseModel):
    items: list[DocumentRead]


class ChunkRead(BaseModel):
    id: str
    document_id: str
    page_number: int
    chunk_index: int
    text: str
    raw_text: str
    line_start: int | None
    line_end: int | None
    line_count: int
    source_excerpt: str
    extraction_method: ExtractionMethod
    content_profile: ContentProfileValue
    created_at: str
    locator_kind: str = "page"
    start_ms: int | None = None
    end_ms: int | None = None
    source_revision: int = 1
    translated_text: str | None = None
    translation_source_revision: int | None = None
    translation_stale: bool = False


class ChunkUpdate(BaseModel):
    text: str


class ChunkList(BaseModel):
    items: list[ChunkRead]
