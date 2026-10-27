"""A stale discovery cache is dropped before a PDF or image capture is rejected."""

from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from capture_runtime_client import (
    CAPTURE_RUNTIME_VERSION,
    CaptureSourceKind,
    RuntimeInstallation,
    RuntimeInstallationStatus,
)
from cert_prep_backend.capture_integration.infrastructure.client import (
    CaptureRuntimeCompatibilityError,
)
from cert_prep_backend.capture_integration.infrastructure.coordinator import (
    CertPrepCaptureCoordinator,
)
from cert_prep_backend.capture_integration.infrastructure.host_models import RuntimeReady


_TOKEN = "capture-sidecar-process-token-that-stays-in-backend"
_NOW = datetime(2026, 8, 13, 4, 0, tzinfo=UTC)


def _ready(*, gpu: bool) -> RuntimeReady:
    payload: dict[str, object] = {
        "ready": True,
        "service": "capture-runtime",
        "apiVersion": "2.0",
        "runtimeVersion": CAPTURE_RUNTIME_VERSION,
        "captureDocumentSchemaVersion": "2",
        "capabilities": {"captureKinds": ["pdf", "image", "audio"]},
    }
    if gpu:
        payload["ocrCompute"] = {
            "apiVersion": "2.0",
            "schemaVersion": "1",
            "service": "capture-runtime",
            "runtimeVersion": CAPTURE_RUNTIME_VERSION,
            "contractSetVersion": "2",
            "contractSha256": "a" * 64,
            "mode": "gpu-dml",
            "adapterClass": "dedicated",
            "reasonCode": None,
            "userNoticeRequired": False,
            "noticeCode": None,
        }
    return RuntimeReady.model_validate(payload)


def _installation(status: RuntimeInstallationStatus) -> RuntimeInstallation:
    return RuntimeInstallation(
        installation_id="installation-1",
        requirement_id="windowsml-ocr",
        status=status,
        progress=1,
        created_at=_NOW,
        updated_at=_NOW,
    )


def _client_with_installations(monkeypatch: pytest.MonkeyPatch, installations: list[object]):
    import cert_prep_backend.capture_integration.infrastructure.client as client_module

    class FakeSdk:
        def __init__(self, **_kwargs: object) -> None:
            self._discovery: SimpleNamespace | None = None
            self.discover_calls = 0

        def discover(self) -> SimpleNamespace:
            if self._discovery is None:
                self.discover_calls += 1
                self._discovery = SimpleNamespace(ready=_ready(gpu=self.discover_calls > 1))
            return self._discovery

        def list_installations(self) -> list[object]:
            return installations

    monkeypatch.setattr(client_module, "SdkCaptureRuntimeClient", FakeSdk)
    return client_module.CaptureRuntimeClient(
        base_url="http://127.0.0.1:43123",
        bearer_token=_TOKEN,
    )


@pytest.mark.parametrize(
    "status",
    [
        RuntimeInstallationStatus.COMPLETED,
        RuntimeInstallationStatus.FAILED,
        RuntimeInstallationStatus.CANCELLED,
        RuntimeInstallationStatus.MANUAL_ACTION_REQUIRED,
    ],
)
def test_listing_a_terminal_installation_drops_the_discovery_cache(
    monkeypatch: pytest.MonkeyPatch,
    status: RuntimeInstallationStatus,
) -> None:
    client = _client_with_installations(monkeypatch, [_installation(status)])

    assert client.handshake().ocr_compute is None
    listed = client.list_installations()
    refreshed = client.handshake()

    assert listed.items[0].status == status
    assert refreshed.ocr_compute is not None
    assert refreshed.ocr_compute.mode == "gpu-dml"
    assert client._sdk.discover_calls == 2


def test_listing_a_running_installation_keeps_the_discovery_cache(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _client_with_installations(
        monkeypatch,
        [_installation(RuntimeInstallationStatus.RUNNING)],
    )

    assert client.handshake().ocr_compute is None
    client.list_installations()
    assert client.handshake().ocr_compute is None
    assert client._sdk.discover_calls == 1


class _PreflightCleared(Exception):
    """Sentinel raised once the OCR preflight has been admitted."""


class _RefreshingClient:
    def __init__(self, readies: list[object]) -> None:
        self._readies = list(readies)
        self.handshakes = 0
        self.invalidations = 0
        self.requirement_reads = 0

    def handshake(self) -> object:
        self.handshakes += 1
        if not self._readies:
            raise AssertionError("handshake was called with no readiness left")
        if len(self._readies) == 1:
            return self._readies[0]
        return self._readies.pop(0)

    def invalidate_discovery_cache(self) -> None:
        self.invalidations += 1

    def get_requirements(self) -> object:
        self.requirement_reads += 1
        raise _PreflightCleared


def _begin(client: _RefreshingClient, kind: CaptureSourceKind) -> None:
    coordinator = CertPrepCaptureCoordinator(client=client, structurer=SimpleNamespace())
    coordinator.begin_capture(
        operation_id="capture-1",
        file_name="sample.pdf" if kind is not CaptureSourceKind.AUDIO else "sample.wav",
        content=b"source bytes",
        media_type="application/pdf" if kind is not CaptureSourceKind.AUDIO else "audio/wav",
        source_kind=kind,
        target_language=None,
        should_cancel=lambda: False,
    )


@pytest.mark.parametrize("kind", [CaptureSourceKind.PDF, CaptureSourceKind.IMAGE])
def test_a_missing_ocr_preflight_is_read_again_before_it_is_rejected(
    kind: CaptureSourceKind,
) -> None:
    client = _RefreshingClient([_ready(gpu=False), _ready(gpu=False)])

    with pytest.raises(
        CaptureRuntimeCompatibilityError,
        match="Capture Runtime did not return the required OCR compute preflight\\.$",
    ):
        _begin(client, kind)

    assert client.handshakes == 2
    assert client.invalidations == 1
    assert client.requirement_reads == 0


@pytest.mark.parametrize("kind", [CaptureSourceKind.PDF, CaptureSourceKind.IMAGE])
def test_a_refreshed_ocr_preflight_is_accepted(kind: CaptureSourceKind) -> None:
    client = _RefreshingClient([_ready(gpu=False), _ready(gpu=True)])

    with pytest.raises(_PreflightCleared):
        _begin(client, kind)

    assert client.handshakes == 2
    assert client.invalidations == 1
    assert client.requirement_reads == 1


@pytest.mark.parametrize("kind", [CaptureSourceKind.PDF, CaptureSourceKind.IMAGE])
def test_an_invalid_ocr_preflight_is_rejected_without_another_handshake(
    kind: CaptureSourceKind,
) -> None:
    invalid = _ready(gpu=True).model_copy(
        update={
            "ocr_compute": SimpleNamespace(
                mode="gpu-dml",
                adapter_class="dedicated",
                reason_code="no_compatible_gpu",
                user_notice_required=True,
                notice_code="ocr_cpu_fallback",
            )
        }
    )
    client = _RefreshingClient([invalid, _ready(gpu=True)])

    with pytest.raises(CaptureRuntimeCompatibilityError, match="invalid GPU-DML"):
        _begin(client, kind)

    assert client.handshakes == 1
    assert client.invalidations == 0
    assert client.requirement_reads == 0


def test_audio_capture_does_not_refresh_a_missing_ocr_preflight() -> None:
    client = _RefreshingClient([_ready(gpu=False), _ready(gpu=True)])

    with pytest.raises(_PreflightCleared):
        _begin(client, CaptureSourceKind.AUDIO)

    assert client.handshakes == 1
    assert client.invalidations == 0
    assert client.requirement_reads == 1
