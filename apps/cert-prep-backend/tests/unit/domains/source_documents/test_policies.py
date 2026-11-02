
from cert_prep_backend.source_library.domain import (
    DOCUMENT_STATUS_VALUES,
    PDF_EXTRACTION_METHOD_VALUES,
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
        "transcription_failed",
    )


def test_pdf_extraction_method_values_preserve_serialized_order() -> None:
    assert PDF_EXTRACTION_METHOD_VALUES == (
        "embedded",
        "mixed",
        "none",
        "ocr_failed",
        "windowsml_ocr",
    )
