from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from io import BytesIO
from itertools import chain
from pathlib import Path
from typing import Literal

import av
from PIL import Image, ImageOps, UnidentifiedImageError
from pypdf import PdfReader

from cert_prep_contracts.transcription import MAX_AUDIO_DURATION_MS
from cert_prep_backend.api.errors import InvalidSourceError


SourceKind = Literal["pdf", "image", "audio"]
SUPPORTED_IMAGE_FORMATS = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp"}
SUPPORTED_AUDIO_SUFFIXES = {".mp3", ".wav", ".m4a"}


@dataclass(frozen=True, slots=True)
class PreparedSource:
    raw_bytes: bytes
    kind: SourceKind
    canonical_suffix: str
    page_count: int
    duration_ms: int | None = None


@dataclass(frozen=True, slots=True)
class StoredSourceReference:
    storage_path: str
    sha256: str
    canonical_suffix: str
    filename: str
    kind: SourceKind


def prepare_source(content: bytes, *, max_pdf_pages: int, max_image_pixels: int, filename: str | None = None) -> PreparedSource:
    """Validate a source envelope before handing all extraction to Capture Runtime."""
    if not content:
        raise InvalidSourceError("Source file is empty.")
    audio_suffix = _audio_suffix(content, filename)
    if audio_suffix is not None:
        return _prepare_audio(content, canonical_suffix=audio_suffix)
    if _has_supported_image_signature(content):
        return _prepare_image(content, max_image_pixels=max_image_pixels)
    if _has_pdf_header(content):
        try:
            reader = PdfReader(BytesIO(content), strict=False)
            page_count = len(reader.pages)
        except Exception as exc:
            raise InvalidSourceError("Uploaded PDF is not readable.") from exc
        if page_count < 1:
            raise InvalidSourceError("Uploaded PDF does not contain any pages.")
        if page_count > max_pdf_pages:
            raise InvalidSourceError(f"PDF has {page_count} pages; the limit is {max_pdf_pages}.")
        return PreparedSource(content, "pdf", ".pdf", page_count)
    return _prepare_image(content, max_image_pixels=max_image_pixels)


def _prepare_image(content: bytes, *, max_image_pixels: int) -> PreparedSource:
    try:
        with Image.open(BytesIO(content)) as image:
            image_format = (image.format or "").upper()
            canonical_suffix = SUPPORTED_IMAGE_FORMATS.get(image_format)
            if canonical_suffix is None:
                raise InvalidSourceError("Only PDF, PNG, JPEG, and WebP source files are supported.")
            width, height = image.size
            if width <= 0 or height <= 0 or width * height > max_image_pixels:
                raise InvalidSourceError(f"Source image exceeds the {max_image_pixels} pixel limit.")
            if getattr(image, "n_frames", 1) != 1 or bool(getattr(image, "is_animated", False)):
                raise InvalidSourceError("Animated or multi-frame images are not supported.")
            image.seek(0)
            image.load()
    except InvalidSourceError:
        raise
    except (OSError, UnidentifiedImageError, ValueError) as exc:
        raise InvalidSourceError("Uploaded file is not a readable PDF, PNG, JPEG, or WebP source.") from exc
    return PreparedSource(content, "image", canonical_suffix, 1)


def _has_pdf_header(content: bytes) -> bool:
    return b"%PDF-" in content[:1024]


def _audio_suffix(content: bytes, filename: str | None) -> str | None:
    suffix = Path(filename or "").suffix.lower()
    if suffix not in SUPPORTED_AUDIO_SUFFIXES:
        return None
    if suffix == ".wav" and content.startswith(b"RIFF") and content[8:12] == b"WAVE":
        return suffix
    if suffix == ".m4a" and len(content) >= 12 and content[4:8] == b"ftyp":
        return suffix
    if suffix == ".mp3" and (content.startswith(b"ID3") or (len(content) >= 2 and content[0] == 0xFF and content[1] & 0xE0 == 0xE0)):
        return suffix
    raise InvalidSourceError("Uploaded audio content does not match its declared type.")


def _prepare_audio(content: bytes, *, canonical_suffix: str) -> PreparedSource:
    try:
        with av.open(BytesIO(content), mode="r") as container:
            audio_stream = next((stream for stream in container.streams if stream.type == "audio"), None)
            if audio_stream is None or not audio_stream.codec_context.name:
                raise InvalidSourceError("Uploaded audio does not contain a supported audio stream.")
            duration_ms = _declared_audio_duration_ms(container, audio_stream)
            if duration_ms is not None and duration_ms > MAX_AUDIO_DURATION_MS:
                raise InvalidSourceError("Audio duration exceeds the 90 minute limit.")
            frames = iter(container.decode(audio_stream))
            first_frame = next(frames, None)
            if first_frame is None:
                raise InvalidSourceError("Uploaded audio does not contain decodable audio.")
            duration_ms = max(duration_ms or 0, _decoded_audio_duration_ms(first_frame, frames))
    except InvalidSourceError:
        raise
    except (av.FFmpegError, OSError, RuntimeError, ValueError) as exc:
        raise InvalidSourceError("Uploaded audio is not a readable MP3, WAV, or M4A file.") from exc
    if duration_ms <= 0:
        raise InvalidSourceError("Uploaded audio does not contain decodable audio.")
    if duration_ms > MAX_AUDIO_DURATION_MS:
        raise InvalidSourceError("Audio duration exceeds the 90 minute limit.")
    return PreparedSource(content, "audio", canonical_suffix, 0, duration_ms)


def _declared_audio_duration_ms(container, audio_stream) -> int | None:
    if audio_stream.duration is not None and audio_stream.time_base is not None:
        value = round(float(audio_stream.duration * audio_stream.time_base) * 1000)
        if value > 0:
            return value
    if container.duration is not None:
        value = round(container.duration / av.time_base * 1000)
        if value > 0:
            return value
    return None


def _decoded_audio_duration_ms(first_frame, remaining_frames) -> int:
    decoded_samples_ms = 0.0
    greatest_timestamp_end_ms = 0.0
    last_timestamp_end_ms = 0.0
    untimestamped_tail_ms = 0.0
    saw_timestamp = False
    decoded_duration_ms = 0.0
    for frame in chain((first_frame,), remaining_frames):
        frame_duration_ms = _audio_frame_duration_ms(frame)
        decoded_samples_ms += frame_duration_ms
        if frame.pts is not None and frame.time_base is not None:
            timestamp_end_ms = float(frame.pts * frame.time_base) * 1000 + frame_duration_ms
            greatest_timestamp_end_ms = max(greatest_timestamp_end_ms, timestamp_end_ms)
            last_timestamp_end_ms = timestamp_end_ms
            untimestamped_tail_ms = 0.0
            saw_timestamp = True
        elif saw_timestamp:
            untimestamped_tail_ms += frame_duration_ms
        decoded_duration_ms = max(decoded_samples_ms, greatest_timestamp_end_ms, last_timestamp_end_ms + untimestamped_tail_ms)
        if decoded_duration_ms > MAX_AUDIO_DURATION_MS:
            break
    return max(0, round(decoded_duration_ms))


def _audio_frame_duration_ms(frame) -> float:
    if frame.sample_rate and frame.samples:
        return max(0.0, frame.samples / frame.sample_rate * 1000)
    return 0.0


def _has_supported_image_signature(content: bytes) -> bool:
    return content.startswith(b"\x89PNG\r\n\x1a\n") or content.startswith(b"\xff\xd8\xff") or (content.startswith(b"RIFF") and content[8:12] == b"WEBP")
