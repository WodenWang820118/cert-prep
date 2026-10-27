"""The DocumentOperation aggregate: one cancellable import or processing run of a document."""

from __future__ import annotations

from dataclasses import dataclass

from cert_prep_backend.source_library.domain.statuses import (
    DocumentOperationPhase,
    DocumentOperationStatus,
)


@dataclass(frozen=True, slots=True)
class DocumentOperation:
    """An upload, extraction, transcription or retry of one document, with whether it can
    still be canceled."""

    id: str
    project_id: str
    document_id: str | None
    status: DocumentOperationStatus
    phase: DocumentOperationPhase
    cancellable: bool
    error: str | None
    created_at: str
    updated_at: str
