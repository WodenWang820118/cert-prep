"""Shared source processing contracts."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Final, TypeAlias


class SourceKind(StrEnum):
    """What an imported source is: a page source (PDF or image) or a recording."""

    PDF = "pdf"
    IMAGE = "image"
    RECORDING = "recording"


class SourceStatus(StrEnum):
    """Persisted lifecycle states for one uploaded source."""

    PROCESSING = "processing"
    CANCEL_REQUESTED = "cancel_requested"
    CANCELED = "canceled"
    READY = "ready"
    NO_TEXT_DETECTED = "no_text_detected"
    EXTRACTION_FAILED = "extraction_failed"
    TRANSCRIPTION_FAILED = "transcription_failed"


SourceStatusValue: TypeAlias = SourceStatus | str
SOURCE_STATUS_VALUES: Final[tuple[str, ...]] = tuple(
    status.value for status in SourceStatus
)


class SourceOperationStatus(StrEnum):
    """Lifecycle states for cancellable source processing work."""

    QUEUED = "queued"
    RUNNING = "running"
    CANCEL_REQUESTED = "cancel_requested"
    CANCELED = "canceled"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class SourceOperationPhase(StrEnum):
    """Observable phases paired with source operation status values."""

    UPLOADING = "uploading"
    PROCESSING = "processing"
    AWAITING_REVIEW = "awaiting_review"
    TRANSCRIBING = "transcribing"
    TRANSLATING = "translating"
    CANCELING = "canceling"
    COMMITTING = "committing"
    CANCELED = "canceled"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class SourceOperationRead:
    """Public snapshot of one source processing operation."""

    id: str
    project_id: str
    source_id: str | None
    status: SourceOperationStatus
    phase: SourceOperationPhase
    cancellable: bool
    error: str | None
    created_at: str
    updated_at: str


__all__ = [
    "SOURCE_STATUS_VALUES",
    "SourceOperationPhase",
    "SourceOperationRead",
    "SourceOperationStatus",
    "SourceStatus",
    "SourceStatusValue",
    "SourceKind",
]
