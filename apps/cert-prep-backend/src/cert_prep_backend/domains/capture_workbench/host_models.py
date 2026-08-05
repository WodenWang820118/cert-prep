"""Host boundary adapters for intentionally broad runtime handshakes."""

from typing import Literal

from capture_contracts import (
    NonEmptyString,
    RuntimeCapabilitiesV1,
    RuntimeReadyV1 as GeneratedRuntimeReadyV1,
)


class RuntimeReadyV1(GeneratedRuntimeReadyV1):
    """Accept arbitrary semantic versions so compatibility errors stay actionable."""

    service: Literal["capture-runtime"]
    api_version: NonEmptyString
    runtime_version: NonEmptyString
    capture_document_schema_version: NonEmptyString


__all__ = ["RuntimeCapabilitiesV1", "RuntimeReadyV1"]
