from __future__ import annotations

from enum import StrEnum
from typing import Final, TypeAlias

from cert_prep_contracts.documents import (
    DOCUMENT_STATUS_VALUES as DOCUMENT_STATUS_VALUES,
    SourceDocumentStatus as SourceDocumentStatus,
    SourceDocumentStatusValue as SourceDocumentStatusValue,
)


class PdfExtractionMethod(StrEnum):
    EMBEDDED = "embedded"
    MIXED = "mixed"
    NONE = "none"
    OCR_FAILED = "ocr_failed"
    WINDOWSML_OCR = "windowsml_ocr"


PDF_EXTRACTION_METHOD_VALUES: Final[tuple[str, ...]] = tuple(
    method.value for method in PdfExtractionMethod
)
PdfExtractionMethodValue: TypeAlias = PdfExtractionMethod | str
