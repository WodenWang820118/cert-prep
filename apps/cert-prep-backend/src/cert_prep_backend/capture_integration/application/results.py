"""Small results of the capture review use cases. Runtime SDK models stay opaque objects."""

from __future__ import annotations

from dataclasses import dataclass

from cert_prep_backend.capture_integration.domain.review_session import CaptureReviewSession
from cert_prep_backend.source_library.domain.document import SourceDocument


@dataclass(frozen=True, slots=True)
class CaptureUploadClaim:
    """Whether this request acquired the operation id."""

    acquired: bool
    operation_id: str


@dataclass(frozen=True, slots=True)
class StartedCaptureReview:
    """The session and document a newly accepted upload projects in its 202 response."""

    session: CaptureReviewSession
    document: SourceDocument
    content_length: int
    canonical_suffix: str


@dataclass(frozen=True, slots=True)
class StructuringFailureNotice:
    """What the runtime returned when the host reported a structuring failure."""

    terminal_sequence: int
    runtime_operation: object


@dataclass(frozen=True, slots=True)
class RuntimeCancellation:
    """What the runtime returned when the host canceled its operation."""

    terminal_sequence: int | None
    runtime_operation: object
