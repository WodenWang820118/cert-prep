from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from io import BytesIO
from typing import Protocol

import pypdfium2 as pdfium
from pypdf import PdfReader

from exam_prep_backend.domains.source_documents.models import (
    ExtractedPage,
    PdfExtractionResult,
)
from exam_prep_backend.domains.source_documents.ocr import OCRPageResult
from exam_prep_backend.errors import InvalidPdfError, ProviderUnavailableError


class PageOcrProvider(Protocol):
    """OCR capability needed by the PDF extractor for page images."""

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        pass


@dataclass(frozen=True, slots=True)
class PdfExtractionProgress:
    page_number: int
    processed_page_count: int
    page: ExtractedPage | None
    ocr_device: str | None
    ocr_fallback_reason: str | None
    ocr_duration_ms: int


def inspect_pdf_page_count(pdf_bytes: bytes, *, max_pages: int) -> int:
    try:
        reader = PdfReader(BytesIO(pdf_bytes))
    except Exception as exc:
        raise InvalidPdfError("Uploaded file is not a readable PDF.") from exc

    page_count = len(reader.pages)
    if page_count > max_pages:
        raise InvalidPdfError(f"PDF has {page_count} pages; the limit is {max_pages}.")
    return page_count


def extract_pdf_pages(
    pdf_bytes: bytes,
    *,
    max_pages: int,
    max_page_text_chars: int,
    max_total_text_chars: int,
    ocr_provider: PageOcrProvider | None = None,
    ocr_render_scale: float = 2.0,
    on_page_processed: Callable[[PdfExtractionProgress], None] | None = None,
) -> PdfExtractionResult:
    """Extract page text from a PDF, falling back to OCR for blank pages."""

    try:
        reader = PdfReader(BytesIO(pdf_bytes))
    except Exception as exc:
        raise InvalidPdfError("Uploaded file is not a readable PDF.") from exc

    if len(reader.pages) > max_pages:
        raise InvalidPdfError(f"PDF has {len(reader.pages)} pages; the limit is {max_pages}.")

    pages_needing_ocr: list[int] = []
    total_text_chars = 0
    processed_page_count = 0
    extracted_pages: list[ExtractedPage] = []
    for page_number, page in enumerate(reader.pages, start=1):
        try:
            text = _normalize_text(page.extract_text() or "")
        except Exception as exc:
            raise InvalidPdfError(f"Could not extract page {page_number}.") from exc
        if text:
            if len(text) > max_page_text_chars:
                raise InvalidPdfError(
                    f"Page {page_number} has too much extracted text; "
                    f"the limit is {max_page_text_chars} characters."
                )
            total_text_chars += len(text)
            if total_text_chars > max_total_text_chars:
                raise InvalidPdfError(
                    f"PDF has too much extracted text; "
                    f"the limit is {max_total_text_chars} characters."
                )
            processed_page_count += 1
            extracted_page = ExtractedPage(
                page_number=page_number,
                text=text,
                source_excerpt=text[:500],
                extraction_method="embedded",
            )
            extracted_pages.append(extracted_page)
            _notify_progress(
                on_page_processed,
                page_number=page_number,
                processed_page_count=processed_page_count,
                page=extracted_page,
                ocr_device=None,
                ocr_fallback_reason=None,
                ocr_duration_ms=0,
            )
        else:
            pages_needing_ocr.append(page_number)

    ocr_failed = False
    ocr_device: str | None = None
    ocr_fallback_reasons: list[str] = []
    ocr_duration_ms = 0
    if pages_needing_ocr and ocr_provider is not None:
        for page_number in pages_needing_ocr:
            try:
                image_png = render_pdf_page_png(
                    pdf_bytes,
                    page_index=page_number - 1,
                    scale=ocr_render_scale,
                )
                ocr_result = ocr_provider.extract_page_text(image_png, page_number)
                ocr_device = ocr_result.device or ocr_device
                ocr_duration_ms += ocr_result.duration_ms
                if (
                    ocr_result.fallback_reason
                    and ocr_result.fallback_reason not in ocr_fallback_reasons
                ):
                    ocr_fallback_reasons.append(ocr_result.fallback_reason)
                text = _normalize_text(ocr_result.text)
                processed_page_count += 1
                if not text:
                    _notify_progress(
                        on_page_processed,
                        page_number=page_number,
                        processed_page_count=processed_page_count,
                        page=None,
                        ocr_device=ocr_device,
                        ocr_fallback_reason="; ".join(ocr_fallback_reasons) or None,
                        ocr_duration_ms=ocr_duration_ms,
                    )
                    continue
                if len(text) > max_page_text_chars:
                    raise InvalidPdfError(
                        f"Page {page_number} has too much OCR text; "
                        f"the limit is {max_page_text_chars} characters."
                    )
                total_text_chars += len(text)
                if total_text_chars > max_total_text_chars:
                    raise InvalidPdfError(
                        f"PDF has too much extracted text; "
                        f"the limit is {max_total_text_chars} characters."
                    )
                extracted_pages.append(
                    extracted_page := ExtractedPage(
                        page_number=page_number,
                        text=text,
                        source_excerpt=text[:500],
                        extraction_method=ocr_result.extraction_method,
                    )
                )
                _notify_progress(
                    on_page_processed,
                    page_number=page_number,
                    processed_page_count=processed_page_count,
                    page=extracted_page,
                    ocr_device=ocr_device,
                    ocr_fallback_reason="; ".join(ocr_fallback_reasons) or None,
                    ocr_duration_ms=ocr_duration_ms,
                )
            except InvalidPdfError:
                raise
            except ProviderUnavailableError:
                if not extracted_pages:
                    raise
                ocr_failed = True
                processed_page_count += 1
                _notify_progress(
                    on_page_processed,
                    page_number=page_number,
                    processed_page_count=processed_page_count,
                    page=None,
                    ocr_device=ocr_device,
                    ocr_fallback_reason="; ".join(ocr_fallback_reasons) or None,
                    ocr_duration_ms=ocr_duration_ms,
                )
                continue
            except Exception:
                ocr_failed = True
                processed_page_count += 1
                _notify_progress(
                    on_page_processed,
                    page_number=page_number,
                    processed_page_count=processed_page_count,
                    page=None,
                    ocr_device=ocr_device,
                    ocr_fallback_reason="; ".join(ocr_fallback_reasons) or None,
                    ocr_duration_ms=ocr_duration_ms,
                )
                continue

    extracted_pages.sort(key=lambda page: page.page_number)
    methods = {page.extraction_method for page in extracted_pages}
    if not extracted_pages:
        return PdfExtractionResult(
            page_count=len(reader.pages),
            pages=[],
            status="ocr_failed" if ocr_failed else "no_text_detected",
            extraction_method="ocr_failed" if ocr_failed else "none",
            ocr_device=ocr_device,
            ocr_fallback_reason="; ".join(ocr_fallback_reasons) or None,
            ocr_duration_ms=ocr_duration_ms,
            processed_page_count=processed_page_count,
        )

    return PdfExtractionResult(
        page_count=len(reader.pages),
        pages=extracted_pages,
        status="ready",
        extraction_method=methods.pop() if len(methods) == 1 else "mixed",
        ocr_device=ocr_device,
        ocr_fallback_reason="; ".join(ocr_fallback_reasons) or None,
        ocr_duration_ms=ocr_duration_ms,
        processed_page_count=processed_page_count,
    )


def render_pdf_page_png(pdf_bytes: bytes, *, page_index: int, scale: float) -> bytes:
    try:
        document = pdfium.PdfDocument(BytesIO(pdf_bytes))
        bitmap = document[page_index].render(scale=scale)
        image = bitmap.to_pil()
        output = BytesIO()
        image.save(output, format="PNG")
        return output.getvalue()
    except Exception as exc:
        raise InvalidPdfError(f"Could not render page {page_index + 1} for OCR.") from exc


def _normalize_text(text: str) -> str:
    return " ".join(text.split())


def _notify_progress(
    callback: Callable[[PdfExtractionProgress], None] | None,
    *,
    page_number: int,
    processed_page_count: int,
    page: ExtractedPage | None,
    ocr_device: str | None,
    ocr_fallback_reason: str | None,
    ocr_duration_ms: int,
) -> None:
    if callback is None:
        return
    callback(
        PdfExtractionProgress(
            page_number=page_number,
            processed_page_count=processed_page_count,
            page=page,
            ocr_device=ocr_device,
            ocr_fallback_reason=ocr_fallback_reason,
            ocr_duration_ms=ocr_duration_ms,
        )
    )
