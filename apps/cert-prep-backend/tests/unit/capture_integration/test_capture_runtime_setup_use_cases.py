"""Runtime setup use cases forward the port. The adapter owns the error translation."""

from __future__ import annotations

from uuid import UUID

import pytest

from cert_prep_backend.capture_integration.application import use_cases
from cert_prep_backend.capture_integration.application.errors import CaptureRuntimeSetupRejected
from cert_prep_backend.capture_integration.infrastructure.client import (
    CaptureRuntimeCompatibilityError,
    CaptureRuntimeError,
    CaptureRuntimeProtocolError,
)
from cert_prep_backend.capture_integration.infrastructure.runtime_setup import (
    ClientCaptureRuntimeSetup,
)

KEY = UUID("867232ea-8e28-4fed-a79e-9fcaa4d25899")
PROVENANCE_UNAVAILABLE = "Installed Capture Runtime provenance is unavailable."


class FakeSetup:
    def __init__(self, error: BaseException | None = None) -> None:
        self.error = error
        self.calls: list[tuple[object, ...]] = []

    def handshake(self) -> object:
        self.calls.append(("handshake",))
        return self._value()

    def provenance(self) -> object:
        self.calls.append(("provenance",))
        return self._value()

    def requirements(self) -> object:
        self.calls.append(("requirements",))
        return self._value()

    def start_installation(self, requirement_id: str, *, idempotency_key: UUID) -> object:
        self.calls.append(("start_installation", requirement_id, idempotency_key))
        return self._value()

    def installations(self) -> object:
        self.calls.append(("installations",))
        return self._value()

    def installation(self, installation_id: str) -> object:
        self.calls.append(("installation", installation_id))
        return self._value()

    def cancel_installation(self, installation_id: str) -> object:
        self.calls.append(("cancel_installation", installation_id))
        return self._value()

    def _value(self) -> object:
        if self.error is not None:
            raise self.error
        return "body"


def test_runtime_setup_use_cases_return_the_port_result() -> None:
    setup = FakeSetup()

    assert use_cases.view_runtime_ready(setup) == "body"
    assert use_cases.view_runtime_provenance(setup) == "body"
    assert use_cases.list_runtime_requirements(setup) == "body"
    started = use_cases.start_runtime_installation(
        setup, requirement_id="windowsml-ocr", idempotency_key=KEY
    )
    assert started == "body"
    assert use_cases.list_runtime_installations(setup) == "body"
    assert use_cases.view_runtime_installation(setup, installation_id="job") == "body"
    assert use_cases.cancel_runtime_installation(setup, installation_id="job") == "body"
    assert setup.calls == [
        ("handshake",),
        ("provenance",),
        ("requirements",),
        ("start_installation", "windowsml-ocr", KEY),
        ("installations",),
        ("installation", "job"),
        ("cancel_installation", "job"),
    ]


def test_a_setup_rejection_propagates_from_the_use_case() -> None:
    rejected = CaptureRuntimeSetupRejected(
        status_code=409,
        code="conflict",
        message="nope",
        details={"reason": "busy"},
    )

    with pytest.raises(CaptureRuntimeSetupRejected) as caught:
        use_cases.view_runtime_ready(FakeSetup(rejected))

    assert caught.value is rejected


class _Client:
    def __init__(self, error: BaseException | None = None, value: object = "ready") -> None:
        self.error = error
        self.value = value
        self.calls: list[tuple[object, ...]] = []

    def handshake(self) -> object:
        self.calls.append(("handshake",))
        if self.error is not None:
            raise self.error
        return self.value

    def get_requirements(self) -> object:
        self.calls.append(("get_requirements",))
        if self.error is not None:
            raise self.error
        return self.value

    def get_installation(self, installation_id: str) -> object:
        self.calls.append(("get_installation", installation_id))
        if self.error is not None:
            raise self.error
        return self.value


def _rejected(error: BaseException, method: str) -> CaptureRuntimeSetupRejected:
    client = _Client(error)
    setup = ClientCaptureRuntimeSetup(client)
    with pytest.raises(CaptureRuntimeSetupRejected) as caught:
        getattr(setup, method)()
    assert caught.value.__cause__ is error
    return caught.value


def test_setup_adapter_translates_runtime_and_provenance_errors() -> None:
    # Compatibility and protocol errors subclass CaptureRuntimeError, so the old
    # router copied their status, code, message, and details. It did not use the
    # 502 names for them.
    remote = CaptureRuntimeError(
        status_code=409,
        code="conflict",
        message="nope",
        details={"reason": "busy"},
    )
    rejected = _rejected(remote, "requirements")
    assert rejected.status_code == 409
    assert rejected.code == "conflict"
    assert rejected.setup_message == remote.runtime_message
    assert rejected.details == {"reason": "busy"}

    compatible = CaptureRuntimeCompatibilityError("old runtime")
    assert isinstance(compatible, CaptureRuntimeError)
    rejected = _rejected(compatible, "handshake")
    assert rejected.status_code == compatible.status_code
    assert rejected.code == "incompatible_runtime"
    assert rejected.setup_message == compatible.runtime_message
    assert rejected.details is None
    assert rejected.code != "capture_runtime_incompatible"

    protocol = CaptureRuntimeProtocolError("bad body")
    assert isinstance(protocol, CaptureRuntimeError)
    rejected = _rejected(protocol, "handshake")
    assert rejected.status_code == protocol.status_code
    assert rejected.code == "protocol_error"
    assert rejected.setup_message == protocol.runtime_message
    assert rejected.code != "capture_runtime_protocol_error"

    client = _Client(remote)
    with pytest.raises(CaptureRuntimeSetupRejected) as caught:
        ClientCaptureRuntimeSetup(client).installation("job")
    assert caught.value.code == "conflict"
    assert client.calls == [("get_installation", "job")]

    missing = _Client(RuntimeError("boom"))
    with pytest.raises(CaptureRuntimeSetupRejected) as caught:
        ClientCaptureRuntimeSetup(missing).provenance()
    assert caught.value.status_code == 503
    assert caught.value.code == "capture_runtime_provenance_unavailable"
    assert caught.value.setup_message == PROVENANCE_UNAVAILABLE
    assert caught.value.details is None
    assert isinstance(caught.value.__cause__, RuntimeError)
    assert not isinstance(caught.value.__cause__, CaptureRuntimeError)

    with pytest.raises(ValueError, match="bad"):
        ClientCaptureRuntimeSetup(_Client(ValueError("bad"))).handshake()
