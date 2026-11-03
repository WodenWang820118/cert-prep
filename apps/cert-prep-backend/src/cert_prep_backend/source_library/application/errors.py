"""Errors the Source Library use cases raise besides the platform's shared ones."""

from __future__ import annotations

from cert_prep_backend.platform.errors import BackendError, ValidationError


class SourceTooLarge(ValidationError):
    """An upload went over its size limit while it was read."""


class SourceTextNotDetected(BackendError):
    """Extraction ran but found no text; the document keeps the no_text_detected status."""


class SourceExtractionFailed(BackendError):
    """Extraction ran and failed; the operation records the extractor's message."""


__all__ = ["SourceExtractionFailed", "SourceTextNotDetected", "SourceTooLarge"]
