"""Pinned host-side mirror of the Capture Runtime v1 wire contract.

The sidecar remains the canonical validator. These models protect the host
boundary and provide the JSON Schema supplied to a host structuring provider.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal, Self

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)
from pydantic.alias_generators import to_camel


CAPTURE_DOCUMENT_SCHEMA_VERSION = "1"
SUPPORTED_API_VERSION = "1.0"
SUPPORTED_RUNTIME_VERSION = "0.1.0"
SUPPORTED_API_MAJOR = 1
SUPPORTED_RUNTIME_MAJOR = 0

NonEmptyString = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
CaptureText = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2_000_000)
]
ProjectedText = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=8_000_000)
]
WarningText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]
Sha256Hex = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
EngineDigest = Annotated[str, StringConstraints(pattern=r"^sha256:[0-9a-f]{64}$")]


class StrictWireModel(BaseModel):
    """Reject unexpected fields and use the runtime's camelCase aliases."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        extra="forbid",
        populate_by_name=True,
        str_strip_whitespace=True,
    )


def _require_aware(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("timestamp must include a timezone")
    return value


class CaptureSourceKind(StrEnum):
    PDF = "pdf"
    IMAGE = "image"
    AUDIO = "audio"


class StructuringMode(StrEnum):
    RUNTIME = "runtime"
    HOST = "host"


class CaptureJobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class CaptureJobStage(StrEnum):
    QUEUED = "queued"
    EXTRACTING = "extracting"
    AWAITING_STRUCTURING = "awaiting_structuring"
    STRUCTURING = "structuring"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class RuntimeInstallationStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    MANUAL_ACTION_REQUIRED = "manual_action_required"


class RuntimeRequirementStatus(StrEnum):
    READY = "ready"
    MISSING = "missing"
    INSTALLABLE = "installable"
    MANUAL_ACTION_REQUIRED = "manual_action_required"
    UNAVAILABLE = "unavailable"


class PageLocatorV1(StrictWireModel):
    kind: Literal["page"] = "page"
    page: int = Field(ge=1)
    bounding_box: tuple[float, float, float, float] | None = None


class TimeLocatorV1(StrictWireModel):
    kind: Literal["time"] = "time"
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)

    @model_validator(mode="after")
    def validate_interval(self) -> Self:
        if self.end_ms <= self.start_ms:
            raise ValueError("endMs must be greater than startMs")
        return self


CaptureLocatorV1 = Annotated[PageLocatorV1 | TimeLocatorV1, Field(discriminator="kind")]


class CaptureSourceV1(StrictWireModel):
    sha256: Sha256Hex
    file_name: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255)
    ]
    media_type: NonEmptyString
    bytes: int = Field(ge=1)


class CaptureEngineV1(StrictWireModel):
    engine: NonEmptyString
    model: NonEmptyString
    digest: EngineDigest
    device: NonEmptyString | None = None


class RawCaptureSegmentV1(StrictWireModel):
    segment_id: NonEmptyString
    order: int = Field(ge=0)
    locator: CaptureLocatorV1
    text: CaptureText


def project_source_text(segments: list[RawCaptureSegmentV1]) -> str:
    return "\n".join(segment.text for segment in segments)


class RawCaptureV1(StrictWireModel):
    schema_version: Literal["1"] = CAPTURE_DOCUMENT_SCHEMA_VERSION
    diagnostic_only: Literal[True] = True
    source: CaptureSourceV1
    segments: list[RawCaptureSegmentV1] = Field(min_length=1, max_length=10_000)
    source_text: ProjectedText
    extraction_engine: CaptureEngineV1
    warnings: list[WarningText] = Field(default_factory=list, max_length=1_000)
    created_at: datetime

    _aware_created_at = field_validator("created_at")(_require_aware)

    @model_validator(mode="after")
    def validate_projection(self) -> Self:
        if [segment.order for segment in self.segments] != list(range(len(self.segments))):
            raise ValueError("raw segment order must be contiguous and match list order")
        if self.source_text != project_source_text(self.segments):
            raise ValueError("sourceText must be the exact raw segment projection")
        identifiers = [segment.segment_id for segment in self.segments]
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("raw segmentId values must be unique")
        return self


class CaptureBlockV1(StrictWireModel):
    block_id: NonEmptyString
    order: int = Field(ge=0)
    type: Literal["heading", "paragraph", "list-item", "table", "quote", "transcript"]
    source_segment_id: NonEmptyString
    locator: CaptureLocatorV1
    source_text: CaptureText
    target_text: CaptureText


class CaptureDocumentV1(StrictWireModel):
    schema_version: Literal["1"] = CAPTURE_DOCUMENT_SCHEMA_VERSION
    source: CaptureSourceV1
    raw_segments: list[RawCaptureSegmentV1] = Field(min_length=1, max_length=10_000)
    blocks: list[CaptureBlockV1] = Field(min_length=1, max_length=10_000)
    source_text: ProjectedText
    target_text: ProjectedText
    extraction_engine: CaptureEngineV1
    structuring_engine: CaptureEngineV1
    warnings: list[WarningText] = Field(default_factory=list, max_length=1_000)
    created_at: datetime
    completed_at: datetime

    _aware_created_at = field_validator("created_at")(_require_aware)
    _aware_completed_at = field_validator("completed_at")(_require_aware)

    @model_validator(mode="after")
    def validate_document(self) -> Self:
        if self.completed_at < self.created_at:
            raise ValueError("completedAt must not precede createdAt")
        if [segment.order for segment in self.raw_segments] != list(
            range(len(self.raw_segments))
        ):
            raise ValueError("raw segment order must be contiguous and match list order")
        if [block.order for block in self.blocks] != list(range(len(self.blocks))):
            raise ValueError("block order must be contiguous and match list order")
        segment_ids = [segment.segment_id for segment in self.raw_segments]
        if len(segment_ids) != len(set(segment_ids)):
            raise ValueError("raw segmentId values must be unique")
        block_ids = [block.block_id for block in self.blocks]
        if len(block_ids) != len(set(block_ids)):
            raise ValueError("blockId values must be unique")
        if len(self.blocks) != len(self.raw_segments):
            raise ValueError("blocks must cover every raw segment exactly once")
        for block, segment in zip(self.blocks, self.raw_segments, strict=True):
            if block.source_segment_id != segment.segment_id:
                raise ValueError("block sequence must follow raw segment order")
            if block.locator != segment.locator:
                raise ValueError("block locator must equal its raw source segment locator")
            if block.source_text != segment.text:
                raise ValueError("block sourceText must equal its raw source segment text")
        if self.source_text != project_source_text(self.raw_segments):
            raise ValueError("sourceText must be the exact raw segment projection")
        if self.target_text != "\n".join(block.target_text for block in self.blocks):
            raise ValueError("targetText must be the exact block target projection")
        return self


class CaptureFailureV1(StrictWireModel):
    code: Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{1,63}$")]
    message: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)
    ]
    stage: NonEmptyString | None = None
    retryable: bool = False


class CaptureJobV1(StrictWireModel):
    capture_id: str
    status: CaptureJobStatus
    stage: CaptureJobStage
    structuring_mode: StructuringMode
    progress: float = Field(ge=0, le=1)
    source: CaptureSourceV1 | None = None
    error: CaptureFailureV1 | None = None
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None

    _aware_times = field_validator("created_at", "updated_at", "completed_at")(
        lambda value: None if value is None else _require_aware(value)
    )

    @model_validator(mode="after")
    def validate_state(self) -> Self:
        terminal = {
            CaptureJobStatus.COMPLETED,
            CaptureJobStatus.FAILED,
            CaptureJobStatus.CANCELLED,
        }
        if (self.status in terminal) != (self.completed_at is not None):
            raise ValueError("terminal capture jobs must have completedAt")
        return self


class RuntimeCapabilitiesV1(StrictWireModel):
    capture_kinds: list[CaptureSourceKind]
    structuring_modes: list[StructuringMode]
    supports_cancellation: Literal[True]
    supports_raw_diagnostics: Literal[True]
    max_upload_bytes: int = Field(gt=0)


class RuntimeReadyV1(StrictWireModel):
    ready: bool
    service: Literal["capture-runtime"]
    api_version: NonEmptyString
    runtime_version: NonEmptyString
    capture_document_schema_version: NonEmptyString
    capabilities: RuntimeCapabilitiesV1
    message: str | None = None


CaptureRequirementId = Literal[
    "windowsml-ocr",
    "whisper-primary",
    "ollama-runtime",
    "capture-ollama-model",
]


class RuntimeRequirementV1(StrictWireModel):
    requirement_id: CaptureRequirementId
    kind: NonEmptyString
    display_name: NonEmptyString
    status: RuntimeRequirementStatus
    required_for: list[str]
    install_strategy: NonEmptyString
    detail: str | None = None


class RuntimeRequirementsV1(StrictWireModel):
    items: list[RuntimeRequirementV1]


class StartRuntimeInstallationV1(StrictWireModel):
    requirement_id: CaptureRequirementId
    consent: Literal[True]


class RuntimeInstallationV1(StrictWireModel):
    installation_id: str
    requirement_id: CaptureRequirementId
    status: RuntimeInstallationStatus
    progress: float = Field(ge=0, le=1)
    error: CaptureFailureV1 | None = None
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None

    _aware_times = field_validator("created_at", "updated_at", "completed_at")(
        lambda value: None if value is None else _require_aware(value)
    )


class RuntimeInstallationsV1(StrictWireModel):
    items: list[RuntimeInstallationV1]


class ErrorBodyV1(StrictWireModel):
    code: NonEmptyString
    message: NonEmptyString
    details: dict[str, object] | None = None


class ErrorEnvelopeV1(StrictWireModel):
    error: ErrorBodyV1


__all__ = [
    "CAPTURE_DOCUMENT_SCHEMA_VERSION",
    "SUPPORTED_API_VERSION",
    "SUPPORTED_RUNTIME_VERSION",
    "SUPPORTED_API_MAJOR",
    "SUPPORTED_RUNTIME_MAJOR",
    "CaptureBlockV1",
    "CaptureDocumentV1",
    "CaptureEngineV1",
    "CaptureFailureV1",
    "CaptureJobStage",
    "CaptureJobStatus",
    "CaptureLocatorV1",
    "CaptureRequirementId",
    "CaptureSourceKind",
    "CaptureSourceV1",
    "ErrorEnvelopeV1",
    "PageLocatorV1",
    "RawCaptureSegmentV1",
    "RawCaptureV1",
    "RuntimeCapabilitiesV1",
    "RuntimeInstallationStatus",
    "RuntimeInstallationV1",
    "RuntimeInstallationsV1",
    "RuntimeReadyV1",
    "RuntimeRequirementStatus",
    "RuntimeRequirementV1",
    "RuntimeRequirementsV1",
    "StartRuntimeInstallationV1",
    "StructuringMode",
    "TimeLocatorV1",
]
