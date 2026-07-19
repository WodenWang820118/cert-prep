"""Shared speech transcription contracts."""

from __future__ import annotations

from dataclasses import dataclass
from collections.abc import Callable
from typing import Protocol


MAX_AUDIO_DURATION_MS = 90 * 60 * 1000


@dataclass(frozen=True, slots=True)
class TranscriptSegment:
    start_ms: int
    end_ms: int
    text: str


@dataclass(frozen=True, slots=True)
class TranscriptionResult:
    duration_ms: int
    segments: tuple[TranscriptSegment, ...]
    configured_model: str
    effective_model: str
    device: str
    warning: str | None = None


class TranscriptionCanceledError(RuntimeError):
    """Raised when transcription stops at a cooperative provider checkpoint."""


TranscriptionSegmentCallback = Callable[[TranscriptSegment], None]
TranscriptionCancelCheck = Callable[[], bool]
TranscriptionResetCallback = Callable[[], None]


class TranscriptionProvider(Protocol):
    def transcribe(
        self,
        source_path: str,
        *,
        on_segment: TranscriptionSegmentCallback | None = None,
        should_cancel: TranscriptionCancelCheck | None = None,
        on_segments_reset: TranscriptionResetCallback | None = None,
    ) -> TranscriptionResult: ...


__all__ = [
    "MAX_AUDIO_DURATION_MS",
    "TranscriptSegment",
    "TranscriptionCanceledError",
    "TranscriptionCancelCheck",
    "TranscriptionProvider",
    "TranscriptionResetCallback",
    "TranscriptionResult",
    "TranscriptionSegmentCallback",
]
