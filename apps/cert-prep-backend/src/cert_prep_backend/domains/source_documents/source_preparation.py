from __future__ import annotations

import warnings
from collections.abc import Callable
from dataclasses import dataclass
from io import BytesIO
from time import perf_counter
from typing import Literal

from PIL import Image, ImageOps, UnidentifiedImageError

from cert_prep_backend.api.errors import (
    InvalidSourceError,
    ProviderUnavailableError,
)
from cert_prep_backend.domains.exam_content import classify_exam_text, line_metadata
from cert_prep_backend.domains.source_documents.models import (
    ExtractedPage,
    PdfExtractionResult,
)
from cert_prep_backend.domains.source_documents.pdf_extraction import (
    PageOcrProvider,
    PdfExtractionProgress,
    extract_pdf_pages,
    inspect_pdf_page_count,
)


SourceKind = Literal["pdf", "image"]
SUPPORTED_IMAGE_FORMATS = {
    "JPEG": ".jpg",
    "PNG": ".png",
    "WEBP": ".webp",
}


@dataclass(frozen=True, slots=True)
class PreparedSource:
    raw_bytes: bytes
    kind: SourceKind
    canonical_suffix: str
    page_count: int
    ocr_image_png: bytes | None = None


def prepare_source(
    content: bytes,
    *,
    max_pdf_pages: int,
    max_image_pixels: int,
) -> PreparedSource:
    """Identify and fully validate a PDF or supported static image by content."""

    if not content:
        raise InvalidSourceError("Source file is empty.")
    if _has_supported_image_signature(content):
        return _prepare_image(content, max_image_pixels=max_image_pixels)
    if _has_pdf_header(content):
        return PreparedSource(
            raw_bytes=content,
            kind="pdf",
            canonical_suffix=".pdf",
            page_count=inspect_pdf_page_count(content, max_pages=max_pdf_pages),
        )
    return _prepare_image(content, max_image_pixels=max_image_pixels)


def extract_prepared_source(
    source: PreparedSource,
    *,
    max_pdf_pages: int,
    max_page_text_chars: int,
    max_total_text_chars: int,
    ocr_provider: PageOcrProvider,
    ocr_render_scale: float,
    on_page_processed: Callable[[PdfExtractionProgress], None] | None = None,
) -> PdfExtractionResult:
    if source.kind == "pdf":
        return extract_pdf_pages(
            source.raw_bytes,
            max_pages=max_pdf_pages,
            max_page_text_chars=max_page_text_chars,
            max_total_text_chars=max_total_text_chars,
            ocr_provider=ocr_provider,
            ocr_render_scale=ocr_render_scale,
            on_page_processed=on_page_processed,
        )
    return _extract_image_page(
        source,
        max_page_text_chars=max_page_text_chars,
        max_total_text_chars=max_total_text_chars,
        ocr_provider=ocr_provider,
        on_page_processed=on_page_processed,
    )


def _prepare_image(content: bytes, *, max_image_pixels: int) -> PreparedSource:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(content)) as image:
                image_format = (image.format or "").upper()
                canonical_suffix = SUPPORTED_IMAGE_FORMATS.get(image_format)
                if canonical_suffix is None:
                    raise InvalidSourceError(
                        "Only PDF, PNG, JPEG, and WebP source files are supported."
                    )
                width, height = image.size
                if width <= 0 or height <= 0:
                    raise InvalidSourceError("Source image dimensions must be positive.")
                pixel_count = width * height
                if pixel_count > max_image_pixels:
                    raise InvalidSourceError(
                        f"Source image has {pixel_count} pixels; "
                        f"the limit is {max_image_pixels}."
                    )
                if getattr(image, "n_frames", 1) != 1 or bool(
                    getattr(image, "is_animated", False)
                ):
                    raise InvalidSourceError("Animated or multi-frame images are not supported.")
                image.seek(0)
                image.load()
                normalized_png = _normalize_image_png(image)
    except InvalidSourceError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise InvalidSourceError("Source image exceeds the safe decoding limit.") from exc
    except (OSError, UnidentifiedImageError, ValueError) as exc:
        raise InvalidSourceError(
            "Uploaded file is not a readable PDF, PNG, JPEG, or WebP source."
        ) from exc

    return PreparedSource(
        raw_bytes=content,
        kind="image",
        canonical_suffix=canonical_suffix,
        page_count=1,
        ocr_image_png=normalized_png,
    )


def _normalize_image_png(image: Image.Image) -> bytes:
    oriented = ImageOps.exif_transpose(image)
    if "A" in oriented.getbands() or "transparency" in oriented.info:
        rgba = oriented.convert("RGBA")
        normalized = Image.new("RGB", rgba.size, "white")
        normalized.paste(rgba, mask=rgba.getchannel("A"))
    else:
        normalized = oriented.convert("RGB")
    output = BytesIO()
    normalized.save(output, format="PNG")
    return output.getvalue()


def _extract_image_page(
    source: PreparedSource,
    *,
    max_page_text_chars: int,
    max_total_text_chars: int,
    ocr_provider: PageOcrProvider,
    on_page_processed: Callable[[PdfExtractionProgress], None] | None,
) -> PdfExtractionResult:
    image_png = source.ocr_image_png
    if image_png is None:
        raise InvalidSourceError("Prepared image content is unavailable.")

    started_at = perf_counter()
    worker_count = _ocr_worker_count(ocr_provider)
    try:
        ocr_result = ocr_provider.extract_page_text(image_png, 1)
    except ProviderUnavailableError as exc:
        _notify_image_progress(
            on_page_processed,
            page=None,
            ocr_device=None,
            ocr_fallback_reason=str(exc),
            ocr_duration_ms=0,
            parse_wall_duration_ms=_elapsed_ms(started_at),
            ocr_worker_count=worker_count,
            first_chunk_ms=0,
        )
        raise
    except Exception:
        parse_wall_duration_ms = _elapsed_ms(started_at)
        _notify_image_progress(
            on_page_processed,
            page=None,
            ocr_device=None,
            ocr_fallback_reason=None,
            ocr_duration_ms=0,
            parse_wall_duration_ms=parse_wall_duration_ms,
            ocr_worker_count=worker_count,
            first_chunk_ms=0,
        )
        return PdfExtractionResult(
            page_count=1,
            pages=(),
            status="ocr_failed",
            extraction_method="ocr_failed",
            ocr_device=None,
            ocr_fallback_reason=None,
            ocr_duration_ms=0,
            processed_page_count=1,
            parse_wall_duration_ms=parse_wall_duration_ms,
            render_duration_ms=0,
            ocr_engine_duration_ms=0,
            ocr_worker_count=worker_count,
            first_chunk_ms=0,
        )

    raw_text = ocr_result.text
    text = " ".join(raw_text.split())
    if len(text) > max_page_text_chars:
        raise InvalidSourceError(
            f"Page 1 has too much OCR text; the limit is {max_page_text_chars} characters."
        )
    if len(text) > max_total_text_chars:
        raise InvalidSourceError(
            "Source file has too much extracted text; "
            f"the limit is {max_total_text_chars} characters."
        )

    parse_wall_duration_ms = _elapsed_ms(started_at)
    if not text:
        _notify_image_progress(
            on_page_processed,
            page=None,
            ocr_device=ocr_result.device,
            ocr_fallback_reason=ocr_result.fallback_reason,
            ocr_duration_ms=ocr_result.duration_ms,
            parse_wall_duration_ms=parse_wall_duration_ms,
            ocr_worker_count=worker_count,
            first_chunk_ms=0,
        )
        return PdfExtractionResult(
            page_count=1,
            pages=(),
            status="no_text_detected",
            extraction_method="none",
            ocr_device=ocr_result.device,
            ocr_fallback_reason=ocr_result.fallback_reason,
            ocr_duration_ms=ocr_result.duration_ms,
            processed_page_count=1,
            parse_wall_duration_ms=parse_wall_duration_ms,
            render_duration_ms=0,
            ocr_engine_duration_ms=ocr_result.duration_ms,
            ocr_worker_count=worker_count,
            first_chunk_ms=0,
        )

    page = _image_extracted_page(
        raw_text=raw_text,
        text=text,
        extraction_method=ocr_result.extraction_method,
    )
    first_chunk_ms = max(1, parse_wall_duration_ms)
    _notify_image_progress(
        on_page_processed,
        page=page,
        ocr_device=ocr_result.device,
        ocr_fallback_reason=ocr_result.fallback_reason,
        ocr_duration_ms=ocr_result.duration_ms,
        parse_wall_duration_ms=parse_wall_duration_ms,
        ocr_worker_count=worker_count,
        first_chunk_ms=first_chunk_ms,
    )
    return PdfExtractionResult(
        page_count=1,
        pages=(page,),
        status="ready",
        extraction_method=ocr_result.extraction_method,
        ocr_device=ocr_result.device,
        ocr_fallback_reason=ocr_result.fallback_reason,
        ocr_duration_ms=ocr_result.duration_ms,
        processed_page_count=1,
        parse_wall_duration_ms=parse_wall_duration_ms,
        render_duration_ms=0,
        ocr_engine_duration_ms=ocr_result.duration_ms,
        ocr_worker_count=worker_count,
        first_chunk_ms=first_chunk_ms,
    )


def _image_extracted_page(
    *,
    raw_text: str,
    text: str,
    extraction_method: str,
) -> ExtractedPage:
    lines = line_metadata(raw_text)
    classification = classify_exam_text(raw_text or text)
    return ExtractedPage(
        page_number=1,
        text=text,
        source_excerpt=text[:500],
        extraction_method=extraction_method,
        raw_text=raw_text,
        line_start=lines.line_start,
        line_end=lines.line_end,
        line_count=lines.line_count,
        content_profile=classification.content_profile,
    )


def _notify_image_progress(
    callback: Callable[[PdfExtractionProgress], None] | None,
    *,
    page: ExtractedPage | None,
    ocr_device: str | None,
    ocr_fallback_reason: str | None,
    ocr_duration_ms: int,
    parse_wall_duration_ms: int,
    ocr_worker_count: int,
    first_chunk_ms: int,
) -> None:
    if callback is None:
        return
    callback(
        PdfExtractionProgress(
            page_number=1,
            processed_page_count=1,
            page=page,
            ocr_device=ocr_device,
            ocr_fallback_reason=ocr_fallback_reason,
            ocr_duration_ms=ocr_duration_ms,
            parse_wall_duration_ms=parse_wall_duration_ms,
            render_duration_ms=0,
            ocr_engine_duration_ms=ocr_duration_ms,
            ocr_worker_count=ocr_worker_count,
            first_chunk_ms=first_chunk_ms,
        )
    )


def _has_pdf_header(content: bytes) -> bool:
    return b"%PDF-" in content[:1024]


def _has_supported_image_signature(content: bytes) -> bool:
    return (
        content.startswith(b"\x89PNG\r\n\x1a\n")
        or content.startswith(b"\xff\xd8\xff")
        or (content.startswith(b"RIFF") and content[8:12] == b"WEBP")
    )


def _ocr_worker_count(ocr_provider: PageOcrProvider) -> int:
    try:
        return max(1, int(getattr(ocr_provider, "page_workers", 1)))
    except (TypeError, ValueError):
        return 1


def _elapsed_ms(started_at: float) -> int:
    return max(0, round((perf_counter() - started_at) * 1000))
