"""Shared source-document processing contracts."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Final, TypeAlias


class SourceDocumentStatus(StrEnum):
    """Persisted lifecycle states for one uploaded source document."""

    PROCESSING = "processing"
    CANCEL_REQUESTED = "cancel_requested"
    CANCELED = "canceled"
    READY = "ready"
    EXAM_FAILED = "exam_failed"
    NO_TEXT_DETECTED = "no_text_detected"
    OCR_FAILED = "ocr_failed"
    TRANSCRIPTION_FAILED = "transcription_failed"


SourceDocumentStatusValue: TypeAlias = SourceDocumentStatus | str
DOCUMENT_STATUS_VALUES: Final[tuple[str, ...]] = tuple(
    status.value for status in SourceDocumentStatus
)


class DocumentOperationStatus(StrEnum):
    """Lifecycle states for cancellable source-document processing work."""

    QUEUED = "queued"
    RUNNING = "running"
    CANCEL_REQUESTED = "cancel_requested"
    CANCELED = "canceled"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class DocumentOperationPhase(StrEnum):
    """Observable phases paired with document operation status values."""

    UPLOADING = "uploading"
    PROCESSING = "processing"
    TRANSCRIBING = "transcribing"
    TRANSLATING = "translating"
    CANCELING = "canceling"
    COMMITTING = "committing"
    CANCELED = "canceled"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class DocumentOperationRead:
    """Public snapshot of one source-document processing operation."""

    id: str
    project_id: str
    document_id: str | None
    status: DocumentOperationStatus
    phase: DocumentOperationPhase
    cancellable: bool
    error: str | None
    created_at: str
    updated_at: str


__all__ = [
    "DOCUMENT_STATUS_VALUES",
    "DocumentOperationPhase",
    "DocumentOperationRead",
    "DocumentOperationStatus",
    "SourceDocumentStatus",
    "SourceDocumentStatusValue",
]
