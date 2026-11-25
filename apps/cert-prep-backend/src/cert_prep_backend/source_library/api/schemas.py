from __future__ import annotations

from dataclasses import asdict

from pydantic import BaseModel

from cert_prep_contracts.sources import SourceKind

from cert_prep_backend.source_library.domain.source import SourceChunk, SourceStatus
from cert_prep_backend.source_library.domain.exam_content import ContentProfileValue
from cert_prep_backend.source_library.domain.statuses import ExtractionMethodValue


class SourceRead(BaseModel):
    id: str
    project_id: str
    filename: str
    sha256: str
    language_hint: str
    page_count: int
    has_text: bool
    status: SourceStatus
    extraction_method: ExtractionMethodValue
    ocr_device: str | None
    extraction_warnings: str | None
    failure_message: str | None
    processed_page_count: int
    question_count: int
    content_profile: ContentProfileValue
    classification_detail: str
    chunks_count: int
    created_at: str
    updated_at: str
    source_kind: SourceKind
    duration_ms: int | None = None
    transcription_status: str = "not_applicable"
    translation_status: str = "not_applicable"
    configured_transcription_model: str | None = None
    effective_transcription_model: str | None = None
    transcription_device: str | None = None
    transcription_warning: str | None = None


class SourceList(BaseModel):
    items: list[SourceRead]


class ChunkRead(BaseModel):
    id: str
    source_id: str
    page_number: int
    chunk_index: int
    text: str
    raw_text: str
    line_start: int | None
    line_end: int | None
    line_count: int
    source_excerpt: str
    extraction_method: ExtractionMethodValue
    content_profile: ContentProfileValue
    created_at: str
    locator_kind: str = "page"
    start_ms: int | None = None
    end_ms: int | None = None
    source_revision: int = 1
    translated_text: str | None = None
    translation_source_revision: int | None = None
    translation_stale: bool = False

    @classmethod
    def from_chunk(cls, chunk: SourceChunk) -> ChunkRead:
        return cls(**asdict(chunk), translation_stale=chunk.translation_stale)


class ChunkUpdate(BaseModel):
    text: str


class ChunkList(BaseModel):
    items: list[ChunkRead]
