from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

from fastapi.testclient import TestClient

from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.capture_workbench.contracts import (
    RuntimeInstallationStatus,
    RuntimeInstallationV1,
    RuntimeInstallationsV1,
    RuntimeRequirementStatus,
    RuntimeRequirementV1,
    RuntimeRequirementsV1,
)


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


def test_capture_runtime_setup_requires_configured_backend_client(
    client: TestClient,
    auth_headers: dict[str, str],
) -> None:
    response = client.get("/capture-runtime/requirements", headers=auth_headers)

    assert response.status_code == 503
    assert response.json()["code"] == "capture_runtime_unavailable"


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
