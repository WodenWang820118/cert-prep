from __future__ import annotations

from enum import StrEnum
from typing import Final, TypeAlias

from cert_prep_contracts.sources import (
    SOURCE_STATUS_VALUES as SOURCE_STATUS_VALUES,
    SourceOperationPhase as SourceOperationPhase,
    SourceOperationStatus as SourceOperationStatus,
    SourceStatus as SourceStatus,
    SourceStatusValue as SourceStatusValue,
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
