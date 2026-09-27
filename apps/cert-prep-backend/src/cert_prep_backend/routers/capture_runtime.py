"""Authenticated host proxy for Capture Runtime setup operations.

The browser authenticates only to Cert Prep. The process-scoped Capture Runtime
token remains inside the backend client and is never serialized to the WebView.
"""

from __future__ import annotations

from typing import Annotated, Literal, NoReturn
from uuid import UUID

from fastapi import APIRouter, Depends, Header, status
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from cert_prep_backend.api.dependencies import get_capture_runtime_client
from cert_prep_backend.api.errors import api_error
from cert_prep_backend.domains.capture_workbench.client import (
    CaptureRuntimeClient,
    CaptureRuntimeCompatibilityError,
    CaptureRuntimeError,
    CaptureRuntimeProtocolError,
)
from capture_runtime_client import (
    CaptureRequirementId,
    RuntimeInstallation,
    RuntimeInstallations,
    RuntimeRequirements,
)
from cert_prep_backend.domains.capture_workbench.host_models import RuntimeReady
from cert_prep_backend.domains.capture_workbench.runtime_provenance import (
    capture_runtime_attestation,
)


router = APIRouter(prefix="/capture-runtime", tags=["capture-runtime"])


class StartRuntimeInstallationRequest(BaseModel):
    """Host API request; generated wire models remain private to the SDK."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )

    requirement_id: CaptureRequirementId
    consent: Literal[True]


@router.get("/ready", response_model=RuntimeReady)
def capture_runtime_ready(
    client: CaptureRuntimeClient = Depends(get_capture_runtime_client),
) -> RuntimeReady:
    """Expose sidecar readiness without serializing its process credential."""

    try:
        return client.handshake()
    except (
        CaptureRuntimeCompatibilityError,
        CaptureRuntimeError,
        CaptureRuntimeProtocolError,
    ) as error:
        _raise_runtime_error(error)


@router.get("/provenance")
def capture_runtime_provenance(
    client: CaptureRuntimeClient = Depends(get_capture_runtime_client),
) -> dict[str, object]:
    """Return candidate-bound build metadata and a live runtime handshake.

    This endpoint is intentionally authenticated by the router dependency and
    exposes hashes/counts only.  The backend build embeds the Python wheel and
    staged native tuple; the live handshake proves the running sidecar reports
    the same OCR contract and worker executable before source import.
    """

    try:
        return capture_runtime_attestation(client)
    except (
        CaptureRuntimeCompatibilityError,
        CaptureRuntimeError,
        CaptureRuntimeProtocolError,
    ) as error:
        _raise_runtime_error(error)
    except RuntimeError as error:
        raise api_error(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            code="capture_runtime_provenance_unavailable",
            message="Installed Capture Runtime provenance is unavailable.",
        ) from error


@router.get("/requirements", response_model=RuntimeRequirements)
def capture_runtime_requirements(
    client: CaptureRuntimeClient = Depends(get_capture_runtime_client),
) -> RuntimeRequirements:
    try:
        return client.get_requirements()
    except (
        CaptureRuntimeCompatibilityError,
        CaptureRuntimeError,
        CaptureRuntimeProtocolError,
    ) as error:
        _raise_runtime_error(error)


@router.post(
    "/installations",
    response_model=RuntimeInstallation,
    status_code=status.HTTP_202_ACCEPTED,
)
def start_capture_runtime_installation(
    payload: StartRuntimeInstallationRequest,
    idempotency_key: Annotated[UUID, Header(alias="X-Idempotency-Key")],
    client: CaptureRuntimeClient = Depends(get_capture_runtime_client),
) -> RuntimeInstallation:
    try:
        return client.start_installation(
            payload.requirement_id,
            idempotency_key=idempotency_key,
        )
    except (
        CaptureRuntimeCompatibilityError,
        CaptureRuntimeError,
        CaptureRuntimeProtocolError,
    ) as error:
        _raise_runtime_error(error)


@router.get("/installations", response_model=RuntimeInstallations)
def capture_runtime_installations(
    client: CaptureRuntimeClient = Depends(get_capture_runtime_client),
) -> RuntimeInstallations:
    try:
        return client.list_installations()
    except (
        CaptureRuntimeCompatibilityError,
        CaptureRuntimeError,
        CaptureRuntimeProtocolError,
    ) as error:
        _raise_runtime_error(error)


@router.get("/installations/{installation_id}", response_model=RuntimeInstallation)
def capture_runtime_installation(
    installation_id: UUID,
    client: CaptureRuntimeClient = Depends(get_capture_runtime_client),
) -> RuntimeInstallation:
    try:
        return client.get_installation(str(installation_id))
    except (
        CaptureRuntimeCompatibilityError,
        CaptureRuntimeError,
        CaptureRuntimeProtocolError,
    ) as error:
        _raise_runtime_error(error)


@router.post(
    "/installations/{installation_id}/cancel",
    response_model=RuntimeInstallation,
)
def cancel_capture_runtime_installation(
    installation_id: UUID,
    client: CaptureRuntimeClient = Depends(get_capture_runtime_client),
) -> RuntimeInstallation:
    try:
        return client.cancel_installation(str(installation_id))
    except (
        CaptureRuntimeCompatibilityError,
        CaptureRuntimeError,
        CaptureRuntimeProtocolError,
    ) as error:
        _raise_runtime_error(error)


def _raise_runtime_error(
    error: CaptureRuntimeCompatibilityError
    | CaptureRuntimeError
    | CaptureRuntimeProtocolError,
) -> NoReturn:
    if isinstance(error, CaptureRuntimeError):
        raise api_error(
            status_code=error.status_code,
            code=error.code,
            message=error.runtime_message,
            details=error.details,
        ) from error
    if isinstance(error, CaptureRuntimeCompatibilityError):
        code = "capture_runtime_incompatible"
    else:
        code = "capture_runtime_protocol_error"
    raise api_error(
        status_code=status.HTTP_502_BAD_GATEWAY,
        code=code,
        message="Capture Runtime returned an incompatible setup response.",
    ) from error


__all__ = ["router"]
