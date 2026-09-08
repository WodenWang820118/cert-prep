"""Privacy-safe projection of runtime-owned OCR evidence."""

from __future__ import annotations

import math
import re
import unicodedata
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, RootModel
from pydantic.alias_generators import to_camel


_FAILURE_CODE = re.compile(r"^[a-z][a-z0-9_]{1,63}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_MODEL_DIGEST = re.compile(r"^sha256:[a-f0-9]{64}$")
_UNICODE_WHITESPACE = re.compile(r"\s+", flags=re.UNICODE)


class OcrSummaryValidationError(ValueError):
    """The runtime evidence cannot safely back the public summary."""


class _OcrSummaryModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class CaptureOcrFailureRead(_OcrSummaryModel):
    code: str = Field(pattern=r"^[a-z][a-z0-9_]{1,63}$")
    retryable: bool


class CaptureOcrPageSummaryRead(_OcrSummaryModel):
    page: int = Field(ge=1)
    status: Literal["recognized", "empty", "failed"]
    normalized_char_count: int = Field(ge=0)
    box_count: int = Field(ge=0)
    confidence: float | None = Field(ge=0, le=1)
    failure: CaptureOcrFailureRead | None


class CaptureOcrResolvedProvenanceRead(_OcrSummaryModel):
    status: Literal["resolved"]
    runtime_version: str = Field(min_length=1, max_length=64)
    contract_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    engine: Literal["windowsml-ocr"]
    model: str = Field(min_length=1, max_length=512)
    model_digest: str = Field(pattern=r"^sha256:[a-f0-9]{64}$")
    device: str = Field(min_length=1, max_length=512)
    profile_id: str = Field(min_length=1, max_length=512)
    profile_spec_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class CaptureOcrUnavailableProvenanceRead(_OcrSummaryModel):
    status: Literal["unavailable"]
    runtime_version: str = Field(min_length=1, max_length=64)
    contract_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    profile_id: str = Field(min_length=1, max_length=512)
    profile_spec_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    reason: Literal[
        "model_unavailable",
        "worker_crashed",
        "worker_timeout",
        "protocol_failure",
    ]


CaptureOcrProvenancePayload = Annotated[
    CaptureOcrResolvedProvenanceRead | CaptureOcrUnavailableProvenanceRead,
    Field(discriminator="status"),
]


class CaptureOcrProvenanceRead(RootModel[CaptureOcrProvenancePayload]):
    """Named discriminated union for exhaustive generated-client narrowing."""

    root: CaptureOcrProvenancePayload


class CaptureOcrSummaryRead(_OcrSummaryModel):
    projection_schema_version: Literal[3]
    capture_id: str = Field(min_length=1)
    status: Literal["completed", "failed"]
    page_count: int = Field(ge=0)
    pages: list[CaptureOcrPageSummaryRead]
    provenance: CaptureOcrProvenanceRead
    failure: CaptureOcrFailureRead | None


def build_ocr_summary(
    *,
    host_capture_id: str,
    runtime_capture_id: str,
    operation: object,
    projection: object,
) -> CaptureOcrSummaryRead:
    """Validate stable runtime identity and return only allowlisted evidence."""

    if not isinstance(host_capture_id, str) or not host_capture_id:
        raise OcrSummaryValidationError("Host capture identity is invalid.")
    if not isinstance(runtime_capture_id, str) or not runtime_capture_id:
        raise OcrSummaryValidationError("Runtime capture identity is invalid.")

    operation_capture_id = _required_string(operation, "capture_id")
    projection_capture_id = _required_string(projection, "capture_id")
    if not (
        runtime_capture_id == operation_capture_id == projection_capture_id
    ):
        raise OcrSummaryValidationError("Runtime capture identity changed.")
    if _required_string(projection, "api_version") != "2.0":
        raise OcrSummaryValidationError("OCR projection API version is unsupported.")
    if _required_string(projection, "schema_version") != "3":
        raise OcrSummaryValidationError("OCR projection schema version is unsupported.")

    operation_status = _enum_string(_required_field(operation, "status"))
    projection_status = _enum_string(_required_field(projection, "status"))
    if (operation_status, projection_status) not in {
        ("awaiting_structuring", "completed"),
        ("failed", "failed"),
    }:
        raise OcrSummaryValidationError("Runtime OCR terminal evidence is inconsistent.")

    operation_source = _required_field(operation, "source")
    projection_source = _required_field(projection, "source")
    if projection_status == "completed":
        if operation_source is None or projection_source is None:
            raise OcrSummaryValidationError("Completed OCR source identity is missing.")
        _ensure_same_source(operation_source, projection_source)
    elif projection_source is not None:
        if operation_source is None:
            raise OcrSummaryValidationError("Failed OCR source identity is inconsistent.")
        _ensure_same_source(operation_source, projection_source)

    runtime_version = _required_string(projection, "runtime_version")
    contract_sha256 = _required_string(projection, "contract_sha256")
    if not _SHA256.fullmatch(contract_sha256):
        raise OcrSummaryValidationError("OCR contract identity is invalid.")

    provenance = _map_provenance(
        _required_field(projection, "provenance"),
        runtime_version=runtime_version,
        contract_sha256=contract_sha256,
    )
    pages_value = _required_field(projection, "pages")
    if not isinstance(pages_value, list):
        raise OcrSummaryValidationError("OCR pages are invalid.")
    page_count = _required_int(projection, "page_count")
    if page_count != len(pages_value):
        raise OcrSummaryValidationError("OCR page count is inconsistent.")

    pages = [
        _map_page(
            page,
            expected_page=index,
            expected_provenance=provenance,
            runtime_version=runtime_version,
            contract_sha256=contract_sha256,
        )
        for index, page in enumerate(pages_value, start=1)
    ]
    failure = _map_failure(_required_field(projection, "failure"))

    if projection_status == "completed":
        if not pages or failure is not None:
            raise OcrSummaryValidationError("Completed OCR evidence is incomplete.")
        if not isinstance(provenance.root, CaptureOcrResolvedProvenanceRead):
            raise OcrSummaryValidationError("Completed OCR provenance is unresolved.")
        if any(page.status == "failed" for page in pages):
            raise OcrSummaryValidationError("Completed OCR evidence contains a failed page.")
        if not any(page.status == "recognized" for page in pages):
            raise OcrSummaryValidationError("Completed OCR evidence has no recognized page.")
    elif failure is None:
        raise OcrSummaryValidationError("Failed OCR evidence has no typed failure.")

    return CaptureOcrSummaryRead(
        projection_schema_version=3,
        capture_id=host_capture_id,
        status=projection_status,
        page_count=page_count,
        pages=pages,
        provenance=provenance,
        failure=failure,
    )


def _map_page(
    page: object,
    *,
    expected_page: int,
    expected_provenance: CaptureOcrProvenanceRead,
    runtime_version: str,
    contract_sha256: str,
) -> CaptureOcrPageSummaryRead:
    page_number = _required_int(page, "page")
    if page_number != expected_page:
        raise OcrSummaryValidationError("OCR pages are not complete and ordered.")
    page_status = _enum_string(_required_field(page, "status"))
    if page_status not in {"recognized", "empty", "failed"}:
        raise OcrSummaryValidationError("OCR page status is unsupported.")

    text = _required_field(page, "text")
    boxes = _required_field(page, "boxes")
    confidence = _required_field(page, "confidence")
    if not isinstance(text, str) or not isinstance(boxes, list):
        raise OcrSummaryValidationError("OCR page evidence is invalid.")
    if confidence is not None and (
        not isinstance(confidence, (int, float))
        or isinstance(confidence, bool)
        or not math.isfinite(confidence)
        or not 0 <= confidence <= 1
    ):
        raise OcrSummaryValidationError("OCR page confidence is invalid.")

    page_failure = _map_failure(_required_field(page, "failure"))
    page_provenance = _map_provenance(
        _required_field(page, "provenance"),
        runtime_version=runtime_version,
        contract_sha256=contract_sha256,
    )
    if page_provenance != expected_provenance:
        raise OcrSummaryValidationError("OCR page provenance is inconsistent.")

    normalized_char_count = _normalized_code_point_count(text)
    if page_status == "recognized":
        if normalized_char_count == 0 or confidence is None or page_failure is not None:
            raise OcrSummaryValidationError("Recognized OCR page evidence is incomplete.")
    elif page_status == "empty":
        if normalized_char_count or boxes or confidence is not None or page_failure is not None:
            raise OcrSummaryValidationError("Empty OCR page evidence is inconsistent.")
    elif normalized_char_count or boxes or confidence is not None or page_failure is None:
        raise OcrSummaryValidationError("Failed OCR page evidence is inconsistent.")

    return CaptureOcrPageSummaryRead(
        page=page_number,
        status=page_status,
        normalized_char_count=normalized_char_count,
        box_count=len(boxes),
        confidence=None if confidence is None else float(confidence),
        failure=page_failure,
    )


def _map_failure(value: object) -> CaptureOcrFailureRead | None:
    if value is None:
        return None
    code = _required_string(value, "code")
    retryable = _required_field(value, "retryable")
    if not _FAILURE_CODE.fullmatch(code) or not isinstance(retryable, bool):
        raise OcrSummaryValidationError("OCR failure evidence is invalid.")
    return CaptureOcrFailureRead(code=code, retryable=retryable)


def _map_provenance(
    value: object,
    *,
    runtime_version: str,
    contract_sha256: str,
) -> CaptureOcrProvenanceRead:
    status = _enum_string(_required_field(value, "status"))
    profile_id = _required_string(value, "profile_id")
    profile_spec_sha256 = _required_string(value, "profile_spec_sha256")
    if not _SHA256.fullmatch(profile_spec_sha256):
        raise OcrSummaryValidationError("OCR profile identity is invalid.")
    if status == "resolved":
        engine = _required_string(value, "engine")
        model_digest = _required_string(value, "model_digest")
        if engine != "windowsml-ocr" or not _MODEL_DIGEST.fullmatch(model_digest):
            raise OcrSummaryValidationError("Resolved OCR provenance is invalid.")
        payload: CaptureOcrProvenancePayload = CaptureOcrResolvedProvenanceRead(
            status="resolved",
            runtime_version=runtime_version,
            contract_sha256=contract_sha256,
            engine="windowsml-ocr",
            model=_required_string(value, "model"),
            model_digest=model_digest,
            device=_required_string(value, "device"),
            profile_id=profile_id,
            profile_spec_sha256=profile_spec_sha256,
        )
    elif status == "unavailable":
        reason = _enum_string(_required_field(value, "reason"))
        if reason not in {
            "model_unavailable",
            "worker_crashed",
            "worker_timeout",
            "protocol_failure",
        }:
            raise OcrSummaryValidationError("Unavailable OCR provenance is invalid.")
        payload = CaptureOcrUnavailableProvenanceRead(
            status="unavailable",
            runtime_version=runtime_version,
            contract_sha256=contract_sha256,
            profile_id=profile_id,
            profile_spec_sha256=profile_spec_sha256,
            reason=reason,
        )
    else:
        raise OcrSummaryValidationError("OCR provenance status is unsupported.")
    return CaptureOcrProvenanceRead(root=payload)


def _ensure_same_source(operation_source: object, projection_source: object) -> None:
    fields = ("sha256", "file_name", "media_type", "bytes")
    operation_identity = tuple(_required_field(operation_source, name) for name in fields)
    projection_identity = tuple(_required_field(projection_source, name) for name in fields)
    if operation_identity != projection_identity:
        raise OcrSummaryValidationError("OCR source identity changed.")
    sha256, file_name, media_type, byte_count = operation_identity
    if (
        not isinstance(sha256, str)
        or not _SHA256.fullmatch(sha256)
        or not isinstance(file_name, str)
        or not file_name
        or not isinstance(media_type, str)
        or not media_type
        or not isinstance(byte_count, int)
        or isinstance(byte_count, bool)
        or byte_count < 1
    ):
        raise OcrSummaryValidationError("OCR source identity is invalid.")


def _normalized_code_point_count(value: str) -> int:
    normalized = unicodedata.normalize("NFKC", value)
    normalized = normalized.replace("\r\n", "\n").replace("\r", "\n")
    normalized = _UNICODE_WHITESPACE.sub(" ", normalized).strip()
    return len(normalized)


def _required_field(value: object, field: str) -> object:
    try:
        return getattr(value, field)
    except (AttributeError, TypeError) as error:
        raise OcrSummaryValidationError("OCR projection shape is invalid.") from error


def _required_string(value: object, field: str) -> str:
    field_value = _required_field(value, field)
    if not isinstance(field_value, str) or not field_value:
        raise OcrSummaryValidationError("OCR projection string field is invalid.")
    return field_value


def _required_int(value: object, field: str) -> int:
    field_value = _required_field(value, field)
    if not isinstance(field_value, int) or isinstance(field_value, bool) or field_value < 0:
        raise OcrSummaryValidationError("OCR projection integer field is invalid.")
    return field_value


def _enum_string(value: object) -> str:
    candidate = getattr(value, "value", value)
    if not isinstance(candidate, str):
        raise OcrSummaryValidationError("OCR projection enum field is invalid.")
    return candidate
