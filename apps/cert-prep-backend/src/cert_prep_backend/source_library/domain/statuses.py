from __future__ import annotations

from enum import StrEnum
from typing import Final, TypeAlias

from cert_prep_contracts.documents import (
    DOCUMENT_STATUS_VALUES as DOCUMENT_STATUS_VALUES,
    DocumentOperationPhase as DocumentOperationPhase,
    DocumentOperationStatus as DocumentOperationStatus,
    SourceDocumentStatus as SourceDocumentStatus,
    SourceDocumentStatusValue as SourceDocumentStatusValue,
)


class ExtractionMethod(StrEnum):
    NONE = "none"
    TEXT_RECOGNITION = "text_recognition"
    TRANSCRIPTION = "transcription"
    TEXT_LAYER = "text_layer"


EXTRACTION_METHOD_VALUES: Final[tuple[str, ...]] = tuple(
    method.value for method in ExtractionMethod
)
ExtractionMethodValue: TypeAlias = ExtractionMethod | str
