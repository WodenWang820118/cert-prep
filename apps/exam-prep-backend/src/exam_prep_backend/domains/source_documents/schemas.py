from __future__ import annotations

from pydantic import BaseModel

from exam_prep_backend.domains.source_documents.models import (
    DocumentStatus,
    ExtractionMethod,
)


class DocumentRead(BaseModel):
    id: str
    project_id: str
    filename: str
    sha256: str
    page_count: int
    has_text: bool
    status: DocumentStatus
    extraction_method: ExtractionMethod
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
    extraction_method: ExtractionMethod
    created_at: str


class ChunkList(BaseModel):
    items: list[ChunkRead]
