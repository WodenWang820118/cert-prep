from __future__ import annotations

from concurrent.futures import (
    FIRST_COMPLETED,
    Future,
    ThreadPoolExecutor,
    wait,
)
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from io import BytesIO
from time import perf_counter
from typing import Protocol

import pypdfium2 as pdfium
from pypdf import PdfReader

from exam_prep_backend.domains.source_documents.models import (
    ExtractedPage,
    PdfExtractionResult,
)
from exam_prep_backend.domains.exam_content import classify_exam_text, line_metadata
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
    parse_wall_duration_ms: int = 0
    render_duration_ms: int = 0
    ocr_engine_duration_ms: int = 0
    ocr_worker_count: int = 0
    first_chunk_ms: int = 0


@dataclass(frozen=True, slots=True)
class _OcrPageOutcome:
    page_number: int
    page: ExtractedPage | None = None
    ocr_device: str | None = None
    ocr_fallback_reason: str | None = None
    ocr_duration_ms: int = 0
    render_duration_ms: int = 0
    provider_unavailable: bool = False
    failed: bool = False
    error: str | None = None


class _OcrSubmissionQueue:
    def __init__(
        self,
        pdf_bytes: bytes,
        *,
        ocr_provider: PageOcrProvider,
        ocr_render_scale: float,
        worker_count: int,
    ) -> None:
        self._pdf_bytes = pdf_bytes
        self._ocr_provider = ocr_provider
        self._ocr_render_scale = ocr_render_scale
        self._executor = ThreadPoolExecutor(max_workers=max(1, worker_count))
        self._futures: dict[Future[_OcrPageOutcome], int] = {}

    def submit(self, page_number: int) -> None:
        future = self._executor.submit(
            _extract_ocr_page,
            self._pdf_bytes,
            page_number=page_number,
            ocr_provider=self._ocr_provider,
            ocr_render_scale=self._ocr_render_scale,
        )
        self._futures[future] = page_number

    def completed(self) -> Iterator[_OcrPageOutcome]:
        done = [future for future in self._futures if future.done()]
        yield from self._consume(done)

    def drain(self) -> Iterator[_OcrPageOutcome]:
        while self._futures:
            done, _ = wait(self._futures, return_when=FIRST_COMPLETED)
            yield from self._consume(done)

    def close(self) -> None:
        self._executor.shutdown(wait=True, cancel_futures=True)

    def _consume(self, futures: Iterable[Future[_OcrPageOutcome]]) -> Iterator[_OcrPageOutcome]:
        for future in futures:
            page_number = self._futures.pop(future)
            yield _ocr_outcome_from_future(future, page_number)


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

    extract_started_at = perf_counter()
    try:
        reader = PdfReader(BytesIO(pdf_bytes))
    except Exception as exc:
        raise InvalidPdfError("Uploaded file is not a readable PDF.") from exc

    if len(reader.pages) > max_pages:
        raise InvalidPdfError(f"PDF has {len(reader.pages)} pages; the limit is {max_pages}.")

    total_text_chars = 0
    processed_page_count = 0
    extracted_pages: list[ExtractedPage] = []
    render_duration_ms = 0
    first_chunk_ms: int | None = None
    ocr_failed = False
    ocr_device: str | None = None
    ocr_fallback_reasons: list[str] = []
    provider_unavailable_errors: list[str] = []
    ocr_duration_ms = 0
    ocr_worker_count = 0
    ocr_queue: _OcrSubmissionQueue | None = None

    def process_ocr_outcome(outcome: _OcrPageOutcome) -> None:
        nonlocal first_chunk_ms
        nonlocal ocr_device, ocr_duration_ms, ocr_failed
        nonlocal processed_page_count, render_duration_ms, total_text_chars

        page_number = outcome.page_number
        render_duration_ms += outcome.render_duration_ms
        if outcome.provider_unavailable:
            error = outcome.error or "OCR provider unavailable."
            if error not in provider_unavailable_errors:
                provider_unavailable_errors.append(error)
            if error not in ocr_fallback_reasons:
                ocr_fallback_reasons.append(error)
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
                parse_wall_duration_ms=_elapsed_ms(extract_started_at),
                render_duration_ms=render_duration_ms,
                ocr_engine_duration_ms=ocr_duration_ms,
                ocr_worker_count=ocr_worker_count,
                first_chunk_ms=first_chunk_ms or 0,
            )
            return

        if outcome.failed:
            ocr_failed = True
            if (
                outcome.error
                and outcome.error.startswith("Could not render page ")
                and outcome.error not in ocr_fallback_reasons
            ):
                ocr_fallback_reasons.append(outcome.error)
            processed_page_count += 1
            _notify_progress(
                on_page_processed,
                page_number=page_number,
                processed_page_count=processed_page_count,
                page=None,
                ocr_device=ocr_device,
                ocr_fallback_reason="; ".join(ocr_fallback_reasons) or None,
                ocr_duration_ms=ocr_duration_ms,
                parse_wall_duration_ms=_elapsed_ms(extract_started_at),
                render_duration_ms=render_duration_ms,
                ocr_engine_duration_ms=ocr_duration_ms,
                ocr_worker_count=ocr_worker_count,
                first_chunk_ms=first_chunk_ms or 0,
            )
            return

        ocr_device = outcome.ocr_device or ocr_device
        ocr_duration_ms += outcome.ocr_duration_ms
        if (
            outcome.ocr_fallback_reason
            and outcome.ocr_fallback_reason not in ocr_fallback_reasons
        ):
            ocr_fallback_reasons.append(outcome.ocr_fallback_reason)
        processed_page_count += 1
        if outcome.page is None:
            _notify_progress(
                on_page_processed,
                page_number=page_number,
                processed_page_count=processed_page_count,
                page=None,
                ocr_device=ocr_device,
                ocr_fallback_reason="; ".join(ocr_fallback_reasons) or None,
                ocr_duration_ms=ocr_duration_ms,
                parse_wall_duration_ms=_elapsed_ms(extract_started_at),
                render_duration_ms=render_duration_ms,
                ocr_engine_duration_ms=ocr_duration_ms,
                ocr_worker_count=ocr_worker_count,
                first_chunk_ms=first_chunk_ms or 0,
            )
            return

        if len(outcome.page.text) > max_page_text_chars:
            raise InvalidPdfError(
                f"Page {page_number} has too much OCR text; "
                f"the limit is {max_page_text_chars} characters."
            )
        total_text_chars += len(outcome.page.text)
        if total_text_chars > max_total_text_chars:
            raise InvalidPdfError(
                f"PDF has too much extracted text; "
                f"the limit is {max_total_text_chars} characters."
            )
        extracted_pages.append(outcome.page)
        first_chunk_ms = _mark_first_chunk(first_chunk_ms, extract_started_at)
        _notify_progress(
            on_page_processed,
            page_number=page_number,
            processed_page_count=processed_page_count,
            page=outcome.page,
            ocr_device=ocr_device,
            ocr_fallback_reason="; ".join(ocr_fallback_reasons) or None,
            ocr_duration_ms=ocr_duration_ms,
            parse_wall_duration_ms=_elapsed_ms(extract_started_at),
            render_duration_ms=render_duration_ms,
            ocr_engine_duration_ms=ocr_duration_ms,
            ocr_worker_count=ocr_worker_count,
            first_chunk_ms=first_chunk_ms or 0,
        )

    def submit_ocr_page(page_number: int) -> None:
        nonlocal ocr_queue, ocr_worker_count
        if ocr_provider is None:
            return
        if ocr_queue is None:
            ocr_worker_count = _ocr_worker_count(ocr_provider)
            ocr_queue = _OcrSubmissionQueue(
                pdf_bytes,
                ocr_provider=ocr_provider,
                ocr_render_scale=ocr_render_scale,
                worker_count=ocr_worker_count,
            )
        ocr_queue.submit(page_number)

    def flush_completed_ocr_pages() -> None:
        if ocr_queue is None:
            return
        for outcome in ocr_queue.completed():
            process_ocr_outcome(outcome)

    try:
        for page_number, page in enumerate(reader.pages, start=1):
            try:
                raw_text = page.extract_text() or ""
                text = _normalize_text(raw_text)
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
                extracted_page = _extracted_page(
                    page_number=page_number,
                    raw_text=raw_text,
                    text=text,
                    extraction_method="embedded",
                )
                extracted_pages.append(extracted_page)
                first_chunk_ms = _mark_first_chunk(first_chunk_ms, extract_started_at)
                _notify_progress(
                    on_page_processed,
                    page_number=page_number,
                    processed_page_count=processed_page_count,
                    page=extracted_page,
                    ocr_device=ocr_device,
                    ocr_fallback_reason="; ".join(ocr_fallback_reasons) or None,
                    ocr_duration_ms=ocr_duration_ms,
                    parse_wall_duration_ms=_elapsed_ms(extract_started_at),
                    render_duration_ms=render_duration_ms,
                    ocr_engine_duration_ms=ocr_duration_ms,
                    ocr_worker_count=ocr_worker_count,
                    first_chunk_ms=first_chunk_ms or 0,
                )
            else:
                submit_ocr_page(page_number)
            flush_completed_ocr_pages()

        if ocr_queue is not None:
            for outcome in ocr_queue.drain():
                process_ocr_outcome(outcome)
    finally:
        if ocr_queue is not None:
            ocr_queue.close()

    if provider_unavailable_errors and not extracted_pages:
        raise ProviderUnavailableError("; ".join(provider_unavailable_errors))

    extracted_pages.sort(key=lambda page: page.page_number)
    methods = {page.extraction_method for page in extracted_pages}
    parse_wall_duration_ms = _elapsed_ms(extract_started_at)
    if not extracted_pages:
        return PdfExtractionResult(
            page_count=len(reader.pages),
            pages=(),
            status="ocr_failed" if ocr_failed else "no_text_detected",
            extraction_method="ocr_failed" if ocr_failed else "none",
            ocr_device=ocr_device,
            ocr_fallback_reason="; ".join(ocr_fallback_reasons) or None,
            ocr_duration_ms=ocr_duration_ms,
            processed_page_count=processed_page_count,
            parse_wall_duration_ms=parse_wall_duration_ms,
            render_duration_ms=render_duration_ms,
            ocr_engine_duration_ms=ocr_duration_ms,
            ocr_worker_count=ocr_worker_count,
            first_chunk_ms=first_chunk_ms or 0,
        )

    return PdfExtractionResult(
        page_count=len(reader.pages),
        pages=tuple(extracted_pages),
        status="ready",
        extraction_method=methods.pop() if len(methods) == 1 else "mixed",
        ocr_device=ocr_device,
        ocr_fallback_reason="; ".join(ocr_fallback_reasons) or None,
        ocr_duration_ms=ocr_duration_ms,
        processed_page_count=processed_page_count,
        parse_wall_duration_ms=parse_wall_duration_ms,
        render_duration_ms=render_duration_ms,
        ocr_engine_duration_ms=ocr_duration_ms,
        ocr_worker_count=ocr_worker_count,
        first_chunk_ms=first_chunk_ms or 0,
    )


def _ocr_outcome_from_future(
    future: Future[_OcrPageOutcome],
    page_number: int,
) -> _OcrPageOutcome:
    try:
        return future.result()
    except InvalidPdfError as exc:
        return _OcrPageOutcome(
            page_number=page_number,
            failed=True,
            error=str(exc),
        )
    except ProviderUnavailableError as exc:
        return _OcrPageOutcome(
            page_number=page_number,
            provider_unavailable=True,
            error=str(exc),
        )
    except Exception as exc:
        return _OcrPageOutcome(
            page_number=page_number,
            failed=True,
            error=str(exc),
        )


def _extract_ocr_page(
    pdf_bytes: bytes,
    *,
    page_number: int,
    ocr_provider: PageOcrProvider,
    ocr_render_scale: float,
) -> _OcrPageOutcome:
    render_started_at = perf_counter()
    image_png = render_pdf_page_png(
        pdf_bytes,
        page_index=page_number - 1,
        scale=ocr_render_scale,
    )
    render_duration_ms = _elapsed_ms(render_started_at)
    ocr_result = ocr_provider.extract_page_text(image_png, page_number)
    raw_text = ocr_result.text
    text = _normalize_text(raw_text)
    return _OcrPageOutcome(
        page_number=page_number,
        page=(
            _extracted_page(
                page_number=page_number,
                raw_text=raw_text,
                text=text,
                extraction_method=ocr_result.extraction_method,
            )
            if text
            else None
        ),
        ocr_device=ocr_result.device,
        ocr_fallback_reason=ocr_result.fallback_reason,
        ocr_duration_ms=ocr_result.duration_ms,
        render_duration_ms=render_duration_ms,
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


def _extracted_page(
    *,
    page_number: int,
    raw_text: str,
    text: str,
    extraction_method: str,
) -> ExtractedPage:
    lines = line_metadata(raw_text)
    classification = classify_exam_text(raw_text or text)
    return ExtractedPage(
        page_number=page_number,
        text=text,
        source_excerpt=text[:500],
        extraction_method=extraction_method,
        raw_text=raw_text,
        line_start=lines.line_start,
        line_end=lines.line_end,
        line_count=lines.line_count,
        content_profile=classification.content_profile,
    )


def _notify_progress(
    callback: Callable[[PdfExtractionProgress], None] | None,
    *,
    page_number: int,
    processed_page_count: int,
    page: ExtractedPage | None,
    ocr_device: str | None,
    ocr_fallback_reason: str | None,
    ocr_duration_ms: int,
    parse_wall_duration_ms: int = 0,
    render_duration_ms: int = 0,
    ocr_engine_duration_ms: int = 0,
    ocr_worker_count: int = 0,
    first_chunk_ms: int = 0,
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
            parse_wall_duration_ms=parse_wall_duration_ms,
            render_duration_ms=render_duration_ms,
            ocr_engine_duration_ms=ocr_engine_duration_ms,
            ocr_worker_count=ocr_worker_count,
            first_chunk_ms=first_chunk_ms,
        )
    )


def _ocr_worker_count(ocr_provider: PageOcrProvider) -> int:
    try:
        return max(1, int(getattr(ocr_provider, "page_workers", 1)))
    except (TypeError, ValueError):
        return 1


def _elapsed_ms(started_at: float) -> int:
    return max(0, round((perf_counter() - started_at) * 1000))


def _mark_first_chunk(current: int | None, extract_started_at: float) -> int:
    if current is not None:
        return current
    return max(1, _elapsed_ms(extract_started_at))
