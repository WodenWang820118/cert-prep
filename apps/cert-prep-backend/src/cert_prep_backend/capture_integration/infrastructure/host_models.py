"""Host-owned DTOs layered over the published Capture Runtime v2 SDK."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from capture_runtime_client import CAPTURE_RUNTIME_VERSION

from cert_prep_backend.capture_integration.application.review_envelope import (
    CaptureReview,
    CaptureReviewEdit,
)

try:
    # Prefer the public SDK DTO, then the generated contracts model; use the
    # host-owned shape below when neither SDK export is available.
    from capture_runtime_client import OcrComputePreflightV2
except ImportError:
    try:
        # Some candidate builds retain the generated model behind the
        # public contracts module until the next SDK packaging cut.
        from capture_runtime_client.private.generated_models import OcrComputePreflightV2
    except ImportError:
        OcrComputePreflightV2 = None  # type: ignore[assignment,misc]


class _HostModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


if OcrComputePreflightV2 is None:

    class OcrComputePreflightV2(_HostModel):
        """Compatibility shape for the generated OCR preflight DTO."""

        api_version: Literal["2.0"] = "2.0"
        schema_version: Literal["1"] = "1"
        service: Literal["capture-runtime"] = "capture-runtime"
        runtime_version: str = CAPTURE_RUNTIME_VERSION
        contract_set_version: Literal["2"] = "2"
        contract_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
        worker_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
        mode: Literal["gpu-dml", "cpu-fallback"]
        adapter_class: Literal["dedicated", "integrated", "unknown"]
        reason_code: Literal[
            "no_compatible_gpu", "dml_provider_unavailable"
        ] | None = None
        user_notice_required: bool
        notice_code: Literal["ocr_cpu_fallback"] | None = None

        @model_validator(mode="after")
        def _validate_decision(self) -> "OcrComputePreflightV2":
            if self.mode == "gpu-dml":
                if (
                    self.reason_code is not None
                    or self.user_notice_required
                    or self.notice_code is not None
                ):
                    raise ValueError(
                        "gpu-dml cannot carry a fallback reason or notice"
                    )
            elif (
                self.reason_code is None
                or not self.user_notice_required
                or self.notice_code != "ocr_cpu_fallback"
            ):
                raise ValueError("cpu-fallback requires a reason and user notice")
            return self

class RuntimeReady(_HostModel):
    """Host readiness DTO with required identity fields and OCR preflight."""

    ready: bool
    service: Literal["capture-runtime"]
    api_version: Literal["2.0"]
    runtime_version: str
    capture_document_schema_version: Literal["2"]
    capture_document_schema_sha256: str | None = Field(
        default=None, pattern=r"^[0-9a-f]{64}$"
    )
    schema_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    contract_set_version: Literal["2"] = "2"
    capabilities: dict[str, Any] = Field(default_factory=dict)
    message: str | None = None
    ocr_compute: OcrComputePreflightV2 | None = None


__all__ = [
    "CaptureReview",
    "CaptureReviewEdit",
    "OcrComputePreflightV2",
    "RuntimeReady",
]
