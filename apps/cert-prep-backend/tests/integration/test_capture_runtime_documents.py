from __future__ import annotations

from capture_runtime_client import CaptureTransportError
from fastapi.testclient import TestClient
import pytest

from cert_prep_backend.bootstrap.app import create_app
from cert_prep_backend.capture_integration.infrastructure.client import CaptureRuntimeClient
from cert_prep_backend.platform.config import Settings
from conftest import minimal_pdf


def test_document_upload_fails_closed_without_capture_runtime(tmp_path, auth_headers) -> None:
    app = create_app(Settings(data_dir=tmp_path, api_token="test-token", llm_provider="fake"))
    with TestClient(app) as client:
        project = client.post("/projects", headers=auth_headers, json={"name": "Capture only"})
        assert project.status_code == 201
        response = client.post(
            f"/projects/{project.json()['id']}/documents",
            headers=auth_headers,
            files={"file": ("source.pdf", minimal_pdf("source"), "application/pdf")},
        )
    assert response.status_code == 503
    assert response.json()["code"] == "capture_runtime_unavailable"


def test_document_upload_reports_unreachable_capture_runtime(
    tmp_path, auth_headers, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    def unreachable(_client: CaptureRuntimeClient) -> None:
        raise CaptureTransportError("Synthetic connection failure.")

    caplog.set_level("WARNING")
    monkeypatch.setattr(CaptureRuntimeClient, "handshake", unreachable)
    settings = Settings(data_dir=tmp_path, api_token="test-token", llm_provider="fake")
    operation_id = "unreachable-runtime"
    with CaptureRuntimeClient(
        base_url="http://127.0.0.1:8766", bearer_token="test-runtime-token"
    ) as runtime:
        app = create_app(
            settings, capture_runtime_client=runtime, document_processing_async_jobs=False
        )
        with TestClient(app) as client:
            project_id = client.post(
                "/projects", headers=auth_headers, json={"name": "Capture only"}
            ).json()["id"]
            response = client.post(
                f"/projects/{project_id}/documents",
                headers={**auth_headers, "X-Cert-Prep-Operation-Id": operation_id},
                files={"file": ("source.pdf", minimal_pdf("source"), "application/pdf")},
            )
            operation = client.get(
                f"/projects/{project_id}/document-operations/{operation_id}",
                headers=auth_headers,
            ).json()
    assert response.status_code == 503
    assert response.json()["code"] == "capture_runtime_unavailable"
    # The stored text is Cert's own generic sentence, the same one an unreachable runtime
    # left before the outage had its own error type; it is not the requirement message.
    assert operation["status"] == "failed"
    assert operation["error"] == "Document processing failed."
    # An outage is expected: it is logged as a warning, never as an error with a traceback.
    assert [record for record in caplog.records if record.levelname == "ERROR"] == []
    assert any(
        record.getMessage() == "Capture Runtime is unavailable for document processing"
        for record in caplog.records
    )
