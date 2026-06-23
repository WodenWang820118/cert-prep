from __future__ import annotations

from collections.abc import Sequence

from .models import ExtractedPage, PdfExtraction, SourceDocument
from .statuses import PdfExtractionMethod, PdfExtractionMethodValue, SourceDocumentStatus


class PdfExtractionPolicy:
    """Derives persisted PDF extraction status and method summaries."""

    def status_for_pages(
        self,
        pages: Sequence[ExtractedPage],
        *,
        ocr_failed: bool,
    ) -> SourceDocumentStatus:
        if pages:
            return SourceDocumentStatus.READY
        if ocr_failed:
            return SourceDocumentStatus.OCR_FAILED
        return SourceDocumentStatus.NO_TEXT_DETECTED

    def method_for_pages(
        self,
        pages: Sequence[ExtractedPage],
        *,
        ocr_failed: bool,
    ) -> PdfExtractionMethodValue:
        if not pages:
            return PdfExtractionMethod.OCR_FAILED if ocr_failed else PdfExtractionMethod.NONE

        methods = {page.extraction_method for page in pages}
        if len(methods) == 1:
            return next(iter(methods))
        return PdfExtractionMethod.MIXED


class SourceDocumentLifecyclePolicy:
    """Answers source-document workflow questions without persistence side effects."""

    def can_generate_exam_items(self, document: SourceDocument | PdfExtraction) -> bool:
        return (
            document.status == SourceDocumentStatus.READY
            and document.has_text
            and document.processed_page_count > 0
        )

    def status_after_exam_generation(self, generated_count: int) -> SourceDocumentStatus:
        if generated_count > 0:
            return SourceDocumentStatus.READY
        return SourceDocumentStatus.EXAM_FAILED
