from __future__ import annotations

from exam_prep_backend.domains.source_documents.chunks import (
    get_chunk,
    get_chunk_by_page,
    get_source_chunks,
    list_chunks,
)
from exam_prep_backend.domains.source_documents.documents import (
    create_document,
    create_processing_document,
    get_document,
    list_documents,
    update_exam_state,
)
from exam_prep_backend.domains.source_documents.progress import (
    complete_document_extraction,
    fail_document_extraction,
    record_extraction_progress,
    recover_processing_documents,
)
from exam_prep_backend.domains.source_documents.records import ensure_document_exists

__all__ = [
    "complete_document_extraction",
    "create_document",
    "create_processing_document",
    "ensure_document_exists",
    "fail_document_extraction",
    "get_chunk",
    "get_chunk_by_page",
    "get_document",
    "get_source_chunks",
    "list_chunks",
    "list_documents",
    "record_extraction_progress",
    "recover_processing_documents",
    "update_exam_state",
]
