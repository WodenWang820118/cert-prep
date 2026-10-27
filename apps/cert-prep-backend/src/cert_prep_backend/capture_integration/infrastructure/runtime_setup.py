"""Capture Runtime setup calls the runtime router needs, without SDK types leaving here."""

from __future__ import annotations

from collections.abc import Callable
from typing import NoReturn
from uuid import UUID

from cert_prep_backend.capture_integration.application.errors import CaptureRuntimeSetupRejected
from cert_prep_backend.capture_integration.infrastructure.client import (
    CaptureRuntimeClient,
    CaptureRuntimeCompatibilityError,
    CaptureRuntimeError,
    CaptureRuntimeProtocolError,
)
from cert_prep_backend.capture_integration.infrastructure.runtime_provenance import (
    capture_runtime_attestation,
)

_INCOMPATIBLE_SETUP = "Capture Runtime returned an incompatible setup response."
_PROVENANCE_UNAVAILABLE = "Installed Capture Runtime provenance is unavailable."


class ClientCaptureRuntimeSetup:
    """The process Capture Runtime client as the setup port."""

    def __init__(self, client: CaptureRuntimeClient) -> None:
        self._client = client

    def handshake(self) -> object:
        return _call(self._client.handshake)

    def provenance(self) -> object:
        try:
            return capture_runtime_attestation(self._client)
        except (
            CaptureRuntimeCompatibilityError,
            CaptureRuntimeError,
            CaptureRuntimeProtocolError,
        ) as error:
            _reject_runtime_error(error)
        except RuntimeError as error:
            raise CaptureRuntimeSetupRejected(
                status_code=503,
                code="capture_runtime_provenance_unavailable",
                message=_PROVENANCE_UNAVAILABLE,
            ) from error

    def requirements(self) -> object:
        return _call(self._client.get_requirements)

    def start_installation(self, requirement_id: str, *, idempotency_key: UUID) -> object:
        return _call(
            lambda: self._client.start_installation(
                requirement_id,
                idempotency_key=idempotency_key,
            )
        )

    def installations(self) -> object:
        return _call(self._client.list_installations)

    def installation(self, installation_id: str) -> object:
        # get_installation clears the discovery cache when the status is terminal.
        return _call(lambda: self._client.get_installation(installation_id))

    def cancel_installation(self, installation_id: str) -> object:
        return _call(lambda: self._client.cancel_installation(installation_id))


def _call(operation: Callable[[], object]) -> object:
    try:
        return operation()
    except (
        CaptureRuntimeCompatibilityError,
        CaptureRuntimeError,
        CaptureRuntimeProtocolError,
    ) as error:
        _reject_runtime_error(error)


def _reject_runtime_error(
    error: CaptureRuntimeCompatibilityError
    | CaptureRuntimeError
    | CaptureRuntimeProtocolError,
) -> NoReturn:
    # Compatibility and protocol errors subclass CaptureRuntimeError, so this
    # branch is the one that runs for them. The later branches keep the old
    # order for an error that is not a CaptureRuntimeError.
    if isinstance(error, CaptureRuntimeError):
        raise CaptureRuntimeSetupRejected(
            status_code=error.status_code,
            code=error.code,
            message=error.runtime_message,
            details=error.details,
        ) from error
    if isinstance(error, CaptureRuntimeCompatibilityError):
        code = "capture_runtime_incompatible"
    else:
        code = "capture_runtime_protocol_error"
    raise CaptureRuntimeSetupRejected(
        status_code=502,
        code=code,
        message=_INCOMPATIBLE_SETUP,
    ) from error
