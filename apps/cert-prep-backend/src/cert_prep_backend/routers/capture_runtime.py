"""Authenticated host proxy for Capture Runtime setup operations.

The browser authenticates only to Cert Prep. The process-scoped Capture Runtime
token remains inside the backend client and is never serialized to the WebView.
"""

from __future__ import annotations

from typing import Annotated, NoReturn
from uuid import UUID

from fastapi import APIRouter, Depends, Header, status

from cert_prep_backend.api.dependencies import get_capture_runtime_client
from cert_prep_backend.api.errors import api_error
from cert_prep_backend.domains.capture_workbench.client import (
    CaptureRuntimeClient,
    CaptureRuntimeCompatibilityError,
    CaptureRuntimeError,
    CaptureRuntimeProtocolError,
)
from cert_prep_backend.domains.capture_workbench.contracts import (
    RuntimeInstallationV1,
    RuntimeInstallationsV1,
    RuntimeRequirementsV1,
    StartRuntimeInstallationV1,
)


router = APIRouter(prefix="/capture-runtime", tags=["capture-runtime"])


@router.get("/requirements", response_model=RuntimeRequirementsV1)
def capture_runtime_requirements(
    client: CaptureRuntimeClient = Depends(get_capture_runtime_client),
) -> RuntimeRequirementsV1:
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
    response_model=RuntimeInstallationV1,
    status_code=status.HTTP_202_ACCEPTED,
)
def start_capture_runtime_installation(
    payload: StartRuntimeInstallationV1,
    idempotency_key: Annotated[UUID, Header(alias="X-Idempotency-Key")],
    client: CaptureRuntimeClient = Depends(get_capture_runtime_client),
) -> RuntimeInstallationV1:
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


@router.get("/installations", response_model=RuntimeInstallationsV1)
def capture_runtime_installations(
    client: CaptureRuntimeClient = Depends(get_capture_runtime_client),
) -> RuntimeInstallationsV1:
    try:
        return client.list_installations()
    except (
        CaptureRuntimeCompatibilityError,
        CaptureRuntimeError,
        CaptureRuntimeProtocolError,
    ) as error:
        _raise_runtime_error(error)


@router.get("/installations/{installation_id}", response_model=RuntimeInstallationV1)
def capture_runtime_installation(
    installation_id: UUID,
    client: CaptureRuntimeClient = Depends(get_capture_runtime_client),
) -> RuntimeInstallationV1:
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
    response_model=RuntimeInstallationV1,
)
def cancel_capture_runtime_installation(
    installation_id: UUID,
    client: CaptureRuntimeClient = Depends(get_capture_runtime_client),
) -> RuntimeInstallationV1:
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
