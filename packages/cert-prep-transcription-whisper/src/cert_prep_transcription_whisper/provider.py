from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

from cert_prep_contracts.transcription import TranscriptSegment, TranscriptionResult
from cert_prep_contracts.transcription import (
    MAX_AUDIO_DURATION_MS,
    TranscriptionCanceledError,
    TranscriptionCancelCheck,
    TranscriptionResetCallback,
    TranscriptionSegmentCallback,
)
from cert_prep_transcription_whisper.runtime import (
    FALLBACK_MODEL,
    PRIMARY_MODEL,
    WhisperModelRuntime,
)


SUPPORTED_SUFFIXES = frozenset({".mp3", ".wav", ".m4a"})


def _is_resource_failure(exc: BaseException) -> bool:
    message = str(exc).lower()
    return any(token in message for token in ("out of memory", "cuda", "cudnn", "cublas"))


def _bounded_segments(
    raw_segments: Any,
    *,
    duration_ms: int,
    on_segment: TranscriptionSegmentCallback | None = None,
    should_cancel: TranscriptionCancelCheck | None = None,
) -> tuple[TranscriptSegment, ...]:
    segments: list[TranscriptSegment] = []
    for segment in raw_segments:
        _raise_if_canceled(should_cancel)
        text = segment.text.strip()
        if not text:
            continue

        start_ms = max(0, round(segment.start * 1000))
        end_ms = min(duration_ms, max(0, round(segment.end * 1000)))
        if start_ms >= end_ms:
            continue

        bounded = TranscriptSegment(
            start_ms=start_ms,
            end_ms=end_ms,
            text=text,
        )
        segments.append(bounded)
        if on_segment is not None:
            on_segment(bounded)
        _raise_if_canceled(should_cancel)
    return tuple(segments)


def _raise_if_canceled(should_cancel: TranscriptionCancelCheck | None) -> None:
    if should_cancel is not None and should_cancel():
        raise TranscriptionCanceledError("Audio transcription was canceled.")


class WhisperTranscriptionProvider:
    """Lazy faster-whisper adapter with one explicit GPU-to-CPU fallback."""

    def __init__(
        self,
        *,
        prefer_gpu: bool = True,
        model_factory: Callable[..., Any] | None = None,
        model_runtime: WhisperModelRuntime | None = None,
    ) -> None:
        self._prefer_gpu = prefer_gpu
        self._model_factory = model_factory
        self.model_runtime = model_runtime or WhisperModelRuntime()

    def transcribe(
        self,
        source_path: str,
        *,
        on_segment: TranscriptionSegmentCallback | None = None,
        should_cancel: TranscriptionCancelCheck | None = None,
        on_segments_reset: TranscriptionResetCallback | None = None,
    ) -> TranscriptionResult:
        path = Path(source_path)
        if path.suffix.lower() not in SUPPORTED_SUFFIXES:
            raise ValueError("Only MP3, WAV, and M4A audio files are supported.")
        if not path.is_file():
            raise ValueError("Audio source file is unavailable.")

        _raise_if_canceled(should_cancel)
        if self._prefer_gpu:
            try:
                return self._run(
                    path,
                    PRIMARY_MODEL,
                    "cuda",
                    "float16",
                    on_segment=on_segment,
                    should_cancel=should_cancel,
                )
            except TranscriptionCanceledError:
                raise
            except Exception as exc:
                if not _is_resource_failure(exc):
                    raise
                if on_segments_reset is not None:
                    on_segments_reset()
                _raise_if_canceled(should_cancel)
                return self._run(
                    path,
                    FALLBACK_MODEL,
                    "cpu",
                    "int8",
                    warning=f"Whisper GPU fallback: {exc}",
                    on_segment=on_segment,
                    should_cancel=should_cancel,
                )
        return self._run(
            path,
            FALLBACK_MODEL,
            "cpu",
            "int8",
            on_segment=on_segment,
            should_cancel=should_cancel,
        )

    def _run(
        self,
        path: Path,
        model_name: str,
        device: str,
        compute_type: str,
        *,
        warning: str | None = None,
        on_segment: TranscriptionSegmentCallback | None = None,
        should_cancel: TranscriptionCancelCheck | None = None,
    ) -> TranscriptionResult:
        _raise_if_canceled(should_cancel)
        factory = self._model_factory
        if factory is None:
            from faster_whisper import WhisperModel

            factory = WhisperModel
            model_source = str(self.model_runtime.model_path(model_name))
        else:
            model_source = model_name
        model = factory(model_source, device=device, compute_type=compute_type)
        raw_segments, info = model.transcribe(
            str(path),
            language="ja",
            beam_size=5,
            vad_filter=True,
            word_timestamps=False,
        )
        duration_ms = max(0, round(float(info.duration) * 1000))
        if duration_ms > MAX_AUDIO_DURATION_MS:
            raise ValueError("Audio duration exceeds the 90 minute limit.")
        segments = _bounded_segments(
            raw_segments,
            duration_ms=duration_ms,
            on_segment=on_segment,
            should_cancel=should_cancel,
        )
        _raise_if_canceled(should_cancel)
        return TranscriptionResult(
            duration_ms=duration_ms,
            segments=segments,
            configured_model=PRIMARY_MODEL,
            effective_model=model_name,
            device=device,
            warning=warning,
        )
