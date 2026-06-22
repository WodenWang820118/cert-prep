from __future__ import annotations

from enum import StrEnum
from typing import Final, TypeAlias


class SourceDocumentStatus(StrEnum):
    PROCESSING = "processing"
    READY = "ready"
    EXAM_FAILED = "exam_failed"
    NO_TEXT_DETECTED = "no_text_detected"
    OCR_FAILED = "ocr_failed"


SourceDocumentStatusValue: TypeAlias = SourceDocumentStatus | str
DOCUMENT_STATUS_VALUES: Final[tuple[str, ...]] = tuple(status.value for status in SourceDocumentStatus)


class PdfExtractionMethod(StrEnum):
    EMBEDDED = "embedded"
    MIXED = "mixed"
    NONE = "none"
    OCR_FAILED = "ocr_failed"
    PADDLE_OCR_CPU = "paddle_ocr_cpu"
    PADDLE_OCR_CPU_FALLBACK = "paddle_ocr_cpu_fallback"
    PADDLE_OCR_GPU = "paddle_ocr_gpu"
    PADDLE_OCR_GPU_FALLBACK = "paddle_ocr_gpu_fallback"
    DIRECTML_OCR = "directml_ocr"
    FAKE_OCR = "fake_ocr"


PDF_EXTRACTION_METHOD_VALUES: Final[tuple[str, ...]] = tuple(
    method.value for method in PdfExtractionMethod
)
PdfExtractionMethodValue: TypeAlias = PdfExtractionMethod | str
