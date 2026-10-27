"""Failures of a capture review that the router maps to today's HTTP responses.

These are not BackendError subclasses: a broad handler for that base must not turn one of
them into a different status.
"""

from __future__ import annotations


class CaptureAudioRejected(Exception):
    """The upload is audio, which capture review does not accept."""


class CaptureExtractionCanceled(Exception):
    """Extraction stopped because the operation was canceled."""


class CaptureRequirementUnavailable(Exception):
    """A source dependency was not ready, so no runtime operation was admitted."""

    def __init__(self, message: str) -> None:
        super().__init__(message)


class CaptureExtractionFailed(Exception):
    """Extraction failed. A runtime job supplies its code and terminal sequence."""

    def __init__(self, code: str | None, terminal_sequence: int | None) -> None:
        super().__init__("Capture Runtime extraction failed.")
        self.code = code
        self.terminal_sequence = terminal_sequence


class CaptureRuntimeCallFailed(Exception):
    """A runtime call failed for a reason the host does not treat as already gone."""


class CaptureReviewConflict(Exception):
    """The review cannot accept this confirmation. The router answers 409."""


class CaptureReviewInputRejected(Exception):
    """A review edit does not match the raw capture. The router answers 422."""


class CaptureCommitNotQueued(Exception):
    """The commit worker could not be queued. The router answers 503."""


class CaptureGatewayRejection(Exception):
    """The runtime did not confirm a report, cancel, or delete. The router answers 502."""


class CaptureOcrNotReady(Exception):
    """OCR evidence is not stable yet. The router answers 409."""


class CaptureOcrClosed(Exception):
    """The review is closed, so OCR evidence is no longer served. The router answers 410."""


class CaptureOcrUnavailable(Exception):
    """OCR evidence cannot be shown. The router answers 502."""


class CaptureOcrTransport(Exception):
    """The OCR read could not reach Capture Runtime. The router answers 503."""


class CaptureOcrMissing(Exception):
    """No capture exists for this OCR read. The router answers 404."""


class CaptureResultProtocolError(Exception):
    """The runtime result violated the v2 contract. The router answers 502."""


class CaptureResultUnavailable(Exception):
    """The runtime result could not be read. The router answers 502."""


class CaptureResultMissing(Exception):
    """The runtime result is already gone. The stored projection is used instead."""


class CaptureEventStreamFailed(Exception):
    """The runtime event iterator failed. A 404 before any event can fall through."""

    def __init__(self, status_code: int) -> None:
        super().__init__("Capture event stream failed.")
        self.status_code = status_code


class CaptureSourceMissing(Exception):
    """A completed capture's document has lost its source record. It is not answered as 404."""
