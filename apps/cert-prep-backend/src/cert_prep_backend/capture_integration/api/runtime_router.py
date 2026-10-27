"""Authenticated host proxy for Capture Runtime setup operations.

The browser authenticates only to Cert Prep. The process-scoped Capture Runtime
token remains inside the backend client and is never serialized to the WebView.
"""

from __future__ import annotations

from typing import Annotated, Literal, NoReturn
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Request, status
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from capture_runtime_client import (
    CaptureRequirementId,
    RuntimeInstallation,
    RuntimeInstallations,
    RuntimeRequirements,
)
from cert_prep_backend.api.errors import api_error
from cert_prep_backend.capture_integration.application import use_cases as capture_reviews
from cert_prep_backend.capture_integration.application.errors import CaptureRuntimeSetupRejected
from cert_prep_backend.capture_integration.application.ports import CaptureRuntimeSetup
from cert_prep_backend.capture_integration.infrastructure.host_models import RuntimeReady


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


def get_capture_runtime_setup(request: Request) -> CaptureRuntimeSetup:
    setup: CaptureRuntimeSetup | None = request.app.state.capture_runtime_setup
    if setup is None:
        raise api_error(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            code="capture_runtime_unavailable",
            message="Capture Runtime is not configured for this process.",
        )
    return setup


@router.get("/ready", response_model=RuntimeReady)
def capture_runtime_ready(
    setup: CaptureRuntimeSetup = Depends(get_capture_runtime_setup),
) -> RuntimeReady:
    """Expose sidecar readiness without serializing its process credential."""

    try:
        return capture_reviews.view_runtime_ready(setup)
    except CaptureRuntimeSetupRejected as error:
        _raise_setup_rejected(error)


@router.get("/provenance")
def capture_runtime_provenance(
    setup: CaptureRuntimeSetup = Depends(get_capture_runtime_setup),
) -> dict[str, object]:
    """Return candidate-bound build metadata and a live runtime handshake.

    This endpoint is intentionally authenticated by the router dependency and
    exposes hashes/counts only.  The backend build embeds the Python wheel and
    staged native tuple; the live handshake proves the running sidecar reports
    the same OCR contract and worker executable before source import.
    """

    try:
        return capture_reviews.view_runtime_provenance(setup)
    except CaptureRuntimeSetupRejected as error:
        _raise_setup_rejected(error)


@router.get("/requirements", response_model=RuntimeRequirements)
def capture_runtime_requirements(
    setup: CaptureRuntimeSetup = Depends(get_capture_runtime_setup),
) -> RuntimeRequirements:
    try:
        return capture_reviews.list_runtime_requirements(setup)
    except CaptureRuntimeSetupRejected as error:
        _raise_setup_rejected(error)


@router.post(
    "/installations",
    response_model=RuntimeInstallation,
    status_code=status.HTTP_202_ACCEPTED,
)
def start_capture_runtime_installation(
    payload: StartRuntimeInstallationRequest,
    idempotency_key: Annotated[UUID, Header(alias="X-Idempotency-Key")],
    setup: CaptureRuntimeSetup = Depends(get_capture_runtime_setup),
) -> RuntimeInstallation:
    try:
        return capture_reviews.start_runtime_installation(
            setup,
            requirement_id=payload.requirement_id,
            idempotency_key=idempotency_key,
        )
    except CaptureRuntimeSetupRejected as error:
        _raise_setup_rejected(error)


@router.get("/installations", response_model=RuntimeInstallations)
def capture_runtime_installations(
    setup: CaptureRuntimeSetup = Depends(get_capture_runtime_setup),
) -> RuntimeInstallations:
    try:
        return capture_reviews.list_runtime_installations(setup)
    except CaptureRuntimeSetupRejected as error:
        _raise_setup_rejected(error)


@router.get("/installations/{installation_id}", response_model=RuntimeInstallation)
def capture_runtime_installation(
    installation_id: UUID,
    setup: CaptureRuntimeSetup = Depends(get_capture_runtime_setup),
) -> RuntimeInstallation:
    try:
        return capture_reviews.view_runtime_installation(
            setup, installation_id=str(installation_id)
        )
    except CaptureRuntimeSetupRejected as error:
        _raise_setup_rejected(error)


@router.post(
    "/installations/{installation_id}/cancel",
    response_model=RuntimeInstallation,
)
def cancel_capture_runtime_installation(
    installation_id: UUID,
    setup: CaptureRuntimeSetup = Depends(get_capture_runtime_setup),
) -> RuntimeInstallation:
    try:
        return capture_reviews.cancel_runtime_installation(
            setup, installation_id=str(installation_id)
        )
    except CaptureRuntimeSetupRejected as error:
        _raise_setup_rejected(error)


def _raise_setup_rejected(error: CaptureRuntimeSetupRejected) -> NoReturn:
    raise api_error(
        status_code=error.status_code,
        code=error.code,
        message=error.setup_message,
        details=error.details,
    ) from error


__all__ = ["router"]
