from __future__ import annotations

from fastapi.testclient import TestClient

from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import Settings
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
