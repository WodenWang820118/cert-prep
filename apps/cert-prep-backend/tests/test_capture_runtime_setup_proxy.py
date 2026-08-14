from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

from fastapi.testclient import TestClient

from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import Settings
from capture_contracts import (
    CAPTURE_RUNTIME_VERSION,
    CaptureSourceKind,
    RuntimeCapabilitiesV1,
    RuntimeArtifactDescriptorV1,
    RuntimeInstallationStatus,
    RuntimeInstallationV1,
    RuntimeInstallationsV1,
    RuntimeRequirementStatus,
    RuntimeRequirementV1,
    RuntimeRequirementsV1,
    StructuringMode,
)
from cert_prep_backend.domains.capture_workbench.host_models import RuntimeReadyV1


TOKEN = "cert-browser-token"
INSTALLATION_ID = UUID("ed506d66-d0e5-41e4-84d2-1ef85bf09b9f")
REQUEST_ID = UUID("867232ea-8e28-4fed-a79e-9fcaa4d25899")
NOW = datetime(2026, 7, 20, 6, 0, tzinfo=UTC)


class RecordingSetupClient:
    def __init__(self) -> None:
        self.idempotency_keys: list[UUID] = []
        self.cancelled: list[str] = []
        self.installation = RuntimeInstallationV1(
            installation_id=str(INSTALLATION_ID),
            requirement_id="windowsml-ocr",
            status=RuntimeInstallationStatus.RUNNING,
            progress=0.5,
            created_at=NOW,
            updated_at=NOW,
        )

    def handshake(self) -> RuntimeReadyV1:
        return RuntimeReadyV1(
            ready=True,
            service="capture-runtime",
            api_version="1.0",
            runtime_version=CAPTURE_RUNTIME_VERSION,
            capture_document_schema_version="1",
            capabilities=RuntimeCapabilitiesV1(
                capture_kinds=list(CaptureSourceKind),
                structuring_modes=[StructuringMode.HOST],
                supports_cancellation=True,
                supports_raw_diagnostics=True,
                max_upload_bytes=50_000_000,
            ),
            message="ready",
        )

    def get_requirements(self) -> RuntimeRequirementsV1:
        return RuntimeRequirementsV1(
            items=[
                RuntimeRequirementV1(
                    requirement_id="windowsml-ocr",
                    kind="ocr",
                    display_name="WindowsML OCR",
                    status=RuntimeRequirementStatus.INSTALLABLE,
                    required_for=["pdf", "image"],
                    install_strategy="checksum-pinned-bundle",
                    artifact=RuntimeArtifactDescriptorV1(
                        artifact_url="https://github.com/example/capture-windowsml.zip",
                        artifact_file_name="capture-windowsml-ocr-windows-x64.zip",
                        bytes=138_837_175,
                        sha256="a88c9a3097771d07bd1d940db6acdcbb5336e7c6c85406f5c22655ed6930704a",
                    ),
                ),
                RuntimeRequirementV1(
                    requirement_id="whisper-primary",
                    kind="speech-to-text",
                    display_name="Whisper",
                    status=RuntimeRequirementStatus.READY,
                    required_for=["audio"],
                    install_strategy="managed-model-download",
                ),
            ]
        )

    def start_installation(
        self,
        requirement_id: str,
        *,
        idempotency_key: UUID,
    ) -> RuntimeInstallationV1:
        assert requirement_id == "windowsml-ocr"
        self.idempotency_keys.append(idempotency_key)
        return self.installation

    def list_installations(self) -> RuntimeInstallationsV1:
        return RuntimeInstallationsV1(items=[self.installation])

    def get_installation(self, installation_id: str) -> RuntimeInstallationV1:
        assert installation_id == str(INSTALLATION_ID)
        return self.installation

    def cancel_installation(self, installation_id: str) -> RuntimeInstallationV1:
        self.cancelled.append(installation_id)
        return self.installation.model_copy(
            update={
                "status": RuntimeInstallationStatus.CANCELLED,
                "progress": 1,
                "completed_at": NOW,
            }
        )


class CoreOnlySetupClient(RecordingSetupClient):
    """Published v0.3.8 requirement response; no local model is available."""

    def get_requirements(self) -> RuntimeRequirementsV1:
        detail = "No downloadable model is published for this runtime release."
        return RuntimeRequirementsV1(
            items=[
                RuntimeRequirementV1(
                    requirement_id="windowsml-ocr",
                    kind="ocr",
                    display_name="WindowsML OCR",
                    status=RuntimeRequirementStatus.UNAVAILABLE,
                    required_for=["pdf", "image"],
                    install_strategy="unavailable",
                    detail=detail,
                ),
                RuntimeRequirementV1(
                    requirement_id="whisper-primary",
                    kind="speech-to-text",
                    display_name="Whisper",
                    status=RuntimeRequirementStatus.UNAVAILABLE,
                    required_for=["audio"],
                    install_strategy="unavailable",
                    detail=detail,
                ),
            ]
        )


def test_capture_runtime_setup_requires_configured_backend_client(
    tmp_path: Path,
    auth_headers: dict[str, str],
) -> None:
    settings = Settings(data_dir=tmp_path, api_token=TOKEN, llm_provider="fake")
    with TestClient(create_app(settings=settings, document_processing_async_jobs=False)) as client:
        response = client.get(
            "/capture-runtime/requirements",
            headers={"Authorization": f"Bearer {TOKEN}"},
        )

    assert response.status_code == 503
    assert response.json()["code"] == "capture_runtime_unavailable"


def test_capture_runtime_ready_proxy_requires_auth_and_keeps_sidecar_token_backend_only(
    tmp_path: Path,
) -> None:
    setup_client = RecordingSetupClient()
    settings = Settings(data_dir=tmp_path, api_token=TOKEN, llm_provider="fake")
    with TestClient(
        create_app(
            settings=settings,
            capture_runtime_client=setup_client,  # type: ignore[arg-type]
            document_processing_async_jobs=False,
        )
    ) as client:
        assert client.get("/capture-runtime/ready").status_code == 401
        response = client.get(
            "/capture-runtime/ready",
            headers={"Authorization": f"Bearer {TOKEN}"},
        )

    assert response.status_code == 200
    assert response.json()["runtimeVersion"] == CAPTURE_RUNTIME_VERSION
    assert response.json()["capabilities"]["structuringModes"] == ["host"]


def test_capture_runtime_setup_proxy_keeps_sidecar_token_backend_only(
    tmp_path: Path,
) -> None:
    setup_client = RecordingSetupClient()
    settings = Settings(data_dir=tmp_path, api_token=TOKEN, llm_provider="fake")
    with TestClient(
        create_app(
            settings=settings,
            capture_runtime_client=setup_client,  # type: ignore[arg-type]
            document_processing_async_jobs=False,
        )
    ) as client:
        assert client.get("/capture-runtime/requirements").status_code == 401
        headers = {"Authorization": f"Bearer {TOKEN}"}

        requirements = client.get(
            "/capture-runtime/requirements", headers=headers
        ).json()["items"]
        assert [item["requirementId"] for item in requirements] == [
            "windowsml-ocr",
            "whisper-primary",
        ]
        assert requirements[0]["artifact"]["artifactFileName"] == (
            "capture-windowsml-ocr-windows-x64.zip"
        )

        started = client.post(
            "/capture-runtime/installations",
            headers={**headers, "X-Idempotency-Key": str(REQUEST_ID)},
            json={"requirementId": "windowsml-ocr", "consent": True},
        )
        assert started.status_code == 202
        assert started.json()["installationId"] == str(INSTALLATION_ID)
        assert setup_client.idempotency_keys == [REQUEST_ID]

        listed = client.get(
            "/capture-runtime/installations", headers=headers
        ).json()["items"]
        assert len(listed) == 1
        assert client.get(
            f"/capture-runtime/installations/{INSTALLATION_ID}", headers=headers
        ).status_code == 200

        cancelled = client.post(
            f"/capture-runtime/installations/{INSTALLATION_ID}/cancel",
            headers=headers,
        )
        assert cancelled.json()["status"] == "cancelled"
        assert setup_client.cancelled == [str(INSTALLATION_ID)]


def test_capture_runtime_setup_proxy_preserves_core_only_unavailable_requirements(
    tmp_path: Path,
) -> None:
    settings = Settings(data_dir=tmp_path, api_token=TOKEN, llm_provider="fake")
    with TestClient(
        create_app(
            settings=settings,
            capture_runtime_client=CoreOnlySetupClient(),  # type: ignore[arg-type]
            document_processing_async_jobs=False,
        )
    ) as client:
        response = client.get(
            "/capture-runtime/requirements",
            headers={"Authorization": f"Bearer {TOKEN}"},
        )

    assert response.status_code == 200
    assert [
        (item["requirementId"], item["status"], item["detail"])
        for item in response.json()["items"]
    ] == [
        (
            "windowsml-ocr",
            "unavailable",
            "No downloadable model is published for this runtime release.",
        ),
        (
            "whisper-primary",
            "unavailable",
            "No downloadable model is published for this runtime release.",
        ),
    ]
