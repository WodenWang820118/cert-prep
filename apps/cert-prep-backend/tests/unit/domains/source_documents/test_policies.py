
from cert_prep_backend.source_library.domain import (
    DOCUMENT_STATUS_VALUES,
    EXTRACTION_METHOD_VALUES,
)


def test_document_status_values_preserve_serialized_order() -> None:
    assert DOCUMENT_STATUS_VALUES == (
        "processing",
        "cancel_requested",
        "canceled",
        "ready",
        "no_text_detected",
        "extraction_failed",
        "transcription_failed",
    )


def test_extraction_method_values_preserve_serialized_order() -> None:
    assert EXTRACTION_METHOD_VALUES == (
        "none",
        "text_recognition",
        "transcription",
        "text_layer",
    )
