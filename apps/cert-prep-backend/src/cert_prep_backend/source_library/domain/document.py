"""The SourceDocument aggregate: an imported PDF, image or recording, its chunks and its
content profile."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import PurePath
from typing import Final

from cert_prep_backend.source_library.domain.exam_content import ContentProfileValue
from cert_prep_backend.source_library.domain.exceptions import SourceDocumentUnavailable

from cert_prep_backend.source_library.domain.statuses import PdfExtractionMethodValue, SourceDocumentStatus, SourceDocumentStatusValue


DocumentStatus = SourceDocumentStatusValue
ExtractionMethod = PdfExtractionMethodValue

AUDIO_MEDIA_TYPES: Final = {".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4"}
MARKDOWN_UNAVAILABLE: Final = "markdown_unavailable"
AUDIO_SOURCE_UNAVAILABLE: Final = "audio_source_unavailable"


@dataclass(frozen=True, slots=True)
class SourceFile:
    filename: str
    sha256: str
    storage_path: str
    content: bytes | None = None


@dataclass(frozen=True, slots=True)
class ExtractedPage:
    page_number: int
    text: str
    source_excerpt: str
    extraction_method: PdfExtractionMethodValue
    raw_text: str = ""
    line_start: int | None = None
    line_end: int | None = None
    line_count: int = 0
    content_profile: ContentProfileValue = "unknown"


@dataclass(frozen=True, slots=True)
class PdfExtraction:
    page_count: int
    pages: tuple[ExtractedPage, ...]
    status: SourceDocumentStatus
    extraction_method: PdfExtractionMethodValue
    ocr_device: str | None
    ocr_fallback_reason: str | None
    ocr_duration_ms: int
    processed_page_count: int
    parse_wall_duration_ms: int = 0
    render_duration_ms: int = 0
    ocr_engine_duration_ms: int = 0
    ocr_worker_count: int = 0
    first_chunk_ms: int = 0

    @property
    def has_text(self) -> bool:
        return bool(self.pages)


PdfExtractionResult = PdfExtraction


@dataclass(frozen=True, slots=True)
class SourceDocument:
    id: str
    project_id: str
    filename: str
    sha256: str
    language_hint: str
    page_count: int
    has_text: bool
    status: SourceDocumentStatus
    extraction_method: PdfExtractionMethodValue
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

    def ensure_markdown_exportable(self) -> None:
        """Only a PDF whose processing has completed has a Markdown projection."""

        if self.source_kind != "document" or PurePath(self.filename).suffix.lower() != ".pdf":
            raise SourceDocumentUnavailable(
                MARKDOWN_UNAVAILABLE,
                "Markdown projection is currently available for PDF documents only.",
            )
        if self.status != "ready":
            raise SourceDocumentUnavailable(
                MARKDOWN_UNAVAILABLE,
                "Markdown projection is available after document processing completes.",
            )

    def ensure_playable(self) -> None:
        """Only a recording has a source that can be played."""

        if self.source_kind != "audio":
            raise SourceDocumentUnavailable(
                AUDIO_SOURCE_UNAVAILABLE, "Only audio documents have a playable source."
            )


@dataclass(frozen=True, slots=True)
class DocumentChunk:
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
    extraction_method: PdfExtractionMethodValue
    content_profile: ContentProfileValue
    created_at: str
    locator_kind: str = "page"
    start_ms: int | None = None
    end_ms: int | None = None
    source_revision: int = 1
    translated_text: str | None = None
    translation_source_revision: int | None = None

    @property
    def translation_stale(self) -> bool:
        """An audio transcript chunk edited since its translation was made."""

        return self.locator_kind == "time" and self.translation_source_revision != self.source_revision


def edited_transcript_text(text: str) -> str:
    """The text a transcript chunk is edited to: trimmed, and never empty."""

    normalized = text.strip()
    if not normalized:
        raise ValueError("Japanese transcript text must not be empty.")
    return normalized

@dataclass(frozen=True, slots=True)
class MarkdownProjection:
    """A ready PDF with the chunks its Markdown is rendered from; never without chunks."""

    document: SourceDocument
    chunks: tuple[DocumentChunk, ...]

    def __post_init__(self) -> None:
        self.document.ensure_markdown_exportable()
        if not self.chunks:
            raise SourceDocumentUnavailable(
                MARKDOWN_UNAVAILABLE,
                "Markdown projection requires at least one persisted document chunk.",
            )
