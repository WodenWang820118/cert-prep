"""Shared value types for persisted Capture Runtime audio segments."""

from __future__ import annotations

from dataclasses import dataclass


MAX_AUDIO_DURATION_MS = 90 * 60 * 1000


@dataclass(frozen=True, slots=True)
class TranscriptSegment:
    start_ms: int
    end_ms: int
    text: str


__all__ = [
    "MAX_AUDIO_DURATION_MS",
    "TranscriptSegment",
]
