"""A document operation can be read while its capture waits for the user's review."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from cert_prep_backend.api.app import create_app
from cert_prep_backend.platform.config import Settings
from conftest import AUTH_TOKEN, minimal_pdf
from document_test_helpers import _create_project
from test_capture_workbench_pipeline import (
    DeterministicCaptureRuntime,
    EchoCaptureProvider,
    _wait_for_capture_status,
)


def test_operation_of_a_capture_in_review_reads_as_awaiting_review(tmp_path: Path) -> None:
    settings = Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake")
    headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
    with TestClient(
        create_app(
            settings=settings,
            llm_provider=EchoCaptureProvider(),
            capture_runtime_client=DeterministicCaptureRuntime(),
            document_processing_async_jobs=False,
            streaming_draft_generation_async_jobs=False,
        )
    ) as client:
        project_id = _create_project(client, headers)
        created = client.post(
            f"/projects/{project_id}/capture-workbench/captures",
            headers={**headers, "X-Cert-Prep-Operation-Id": "review-operation"},
            files={"file": ("review.pdf", minimal_pdf("Review me."), "application/pdf")},
        )
        assert created.status_code == 202, created.text
        _wait_for_capture_status(
            client,
            project_id=project_id,
            capture_id=created.json()["captureId"],
            headers=headers,
            status_value="awaiting_structuring",
        )

        operation = client.get(
            f"/projects/{project_id}/document-operations/review-operation", headers=headers
        )

    assert operation.status_code == 200, operation.text
    assert operation.json()["status"] == "running"
    assert operation.json()["phase"] == "awaiting_review"
    assert operation.json()["cancellable"] is True
