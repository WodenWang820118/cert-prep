from cert_prep_backend.domains.source_documents import (
    DOCUMENT_STATUS_VALUES,
    PDF_EXTRACTION_METHOD_VALUES,
    ExtractedPage,
    PdfExtraction,
    PdfExtractionMethod,
    PdfExtractionPolicy,
    SourceDocumentLifecyclePolicy,
    SourceDocumentStatus,
)


def test_document_status_values_preserve_serialized_order() -> None:
    assert DOCUMENT_STATUS_VALUES == (
        "processing",
        "cancel_requested",
        "canceled",
        "ready",
        "exam_failed",
        "no_text_detected",
        "ocr_failed",
    )


def test_pdf_extraction_method_values_preserve_serialized_order() -> None:
    assert PDF_EXTRACTION_METHOD_VALUES == (
        "embedded",
        "mixed",
        "none",
        "ocr_failed",
        "paddle_ocr_cpu",
        "paddle_ocr_cpu_fallback",
        "paddle_ocr_gpu",
        "paddle_ocr_gpu_fallback",
        "windowsml_ocr",
        "fake_ocr",
    )


def test_pdf_extraction_policy_derives_current_statuses_and_method_summaries() -> None:
    policy = PdfExtractionPolicy()
    embedded_page = ExtractedPage(
        page_number=1,
        text="Embedded text",
        source_excerpt="Embedded text",
        extraction_method=PdfExtractionMethod.EMBEDDED,
    )
    ocr_page = ExtractedPage(
        page_number=2,
        text="OCR text",
        source_excerpt="OCR text",
        extraction_method=PdfExtractionMethod.PADDLE_OCR_GPU,
    )

    assert policy.status_for_pages([embedded_page], ocr_failed=False) == SourceDocumentStatus.READY
    assert policy.status_for_pages([], ocr_failed=False) == SourceDocumentStatus.NO_TEXT_DETECTED
    assert policy.status_for_pages([], ocr_failed=True) == SourceDocumentStatus.OCR_FAILED
    assert policy.method_for_pages([embedded_page], ocr_failed=False) == PdfExtractionMethod.EMBEDDED
    assert policy.method_for_pages([embedded_page, ocr_page], ocr_failed=False) == (
        PdfExtractionMethod.MIXED
    )
    assert policy.method_for_pages([], ocr_failed=False) == PdfExtractionMethod.NONE
    assert policy.method_for_pages([], ocr_failed=True) == PdfExtractionMethod.OCR_FAILED


def test_source_document_lifecycle_policy_requires_ready_text_before_exam_generation() -> None:
    policy = SourceDocumentLifecyclePolicy()
    ready_extraction = PdfExtraction(
        page_count=1,
        pages=(
            ExtractedPage(
                page_number=1,
                text="Extracted text",
                source_excerpt="Extracted text",
                extraction_method=PdfExtractionMethod.EMBEDDED,
            ),
        ),
        status=SourceDocumentStatus.READY,
        extraction_method=PdfExtractionMethod.EMBEDDED,
        ocr_device=None,
        ocr_fallback_reason=None,
        ocr_duration_ms=0,
        processed_page_count=1,
    )
    empty_extraction = PdfExtraction(
        page_count=1,
        pages=(),
        status=SourceDocumentStatus.NO_TEXT_DETECTED,
        extraction_method=PdfExtractionMethod.NONE,
        ocr_device=None,
        ocr_fallback_reason=None,
        ocr_duration_ms=0,
        processed_page_count=0,
    )

    assert policy.can_generate_exam_items(ready_extraction) is True
    assert policy.can_generate_exam_items(empty_extraction) is False
    assert policy.status_after_exam_generation(1) == SourceDocumentStatus.READY
    assert policy.status_after_exam_generation(0) == SourceDocumentStatus.EXAM_FAILED
