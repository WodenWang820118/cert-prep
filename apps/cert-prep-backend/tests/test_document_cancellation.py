from __future__ import annotations

from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import Settings
from cert_prep_backend.routers import documents as documents_router
from conftest import minimal_image, minimal_pdf
from document_test_helpers import _create_project, _wait_for_document_status
from document_test_ocr_fakes import BlockingOcrProvider


def test_upload_cancel_tombstone_wins_before_document_id_exists(
    tmp_path: Path,
    auth_headers,
) -> None:
    operation_id = str(uuid4())
    with TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            document_processing_async_jobs=True,
        )
    ) as client:
        project_id = _create_project(client, auth_headers)

        canceled = client.delete(
            f"/projects/{project_id}/document-operations/{operation_id}",
            headers=auth_headers,
        )
        rejected = client.post(
            f"/projects/{project_id}/documents",
            headers={
                **auth_headers,
                "X-Cert-Prep-Operation-Id": operation_id,
            },
            files={"file": ("late.pdf", minimal_pdf("late"), "application/pdf")},
        )

        assert canceled.status_code == 202
        assert canceled.json()["status"] == "canceled"
        assert rejected.status_code == 409
        assert rejected.json()["code"] == "operation_canceled"
        documents = client.get(
            f"/projects/{project_id}/documents",
            headers=auth_headers,
        )
        assert documents.json()["items"] == []


def test_ocr_cancel_cleans_partial_state_and_does_not_enqueue_drafts(
    tmp_path: Path,
    auth_headers,
) -> None:
    operation_id = str(uuid4())
    ocr_provider = BlockingOcrProvider()
    with TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            ocr_provider=ocr_provider,
            document_processing_async_jobs=True,
        )
    ) as client:
        project_id = _create_project(client, auth_headers)
        uploaded = client.post(
            f"/projects/{project_id}/documents",
            headers={
                **auth_headers,
                "X-Cert-Prep-Operation-Id": operation_id,
            },
            files={"file": ("scan.pdf", minimal_pdf(""), "application/pdf")},
        )
        assert uploaded.status_code == 201
        document_id = uploaded.json()["id"]
        assert ocr_provider.started.wait(timeout=2)

        cancel = client.delete(
            f"/projects/{project_id}/document-operations/{operation_id}",
            headers=auth_headers,
        )
        assert cancel.status_code == 202
        assert cancel.json()["status"] == "cancel_requested"
        assert cancel.json()["cancellable"] is False

        ocr_provider.release.set()
        canceled_document = _wait_for_document_status(
            client,
            auth_headers,
            project_id,
            document_id,
            "canceled",
        )
        operation = client.get(
            f"/projects/{project_id}/document-operations/{operation_id}",
            headers=auth_headers,
        )
        chunks = client.get(
            f"/projects/{project_id}/documents/{document_id}/chunks",
            headers=auth_headers,
        )
        drafts = client.get(
            f"/projects/{project_id}/question-drafts",
            headers=auth_headers,
        )

        assert canceled_document["processed_page_count"] == 0
        assert canceled_document["chunks_count"] == 0
        assert operation.json()["status"] == "canceled"
        assert chunks.json()["items"] == []
        assert drafts.json()["items"] == []


@pytest.mark.parametrize(
    ("filename", "source_bytes", "content_type"),
    [
        ("retry.pdf", minimal_pdf(""), "application/pdf"),
        ("retry.png", minimal_image("PNG"), "image/png"),
    ],
)
def test_canceled_document_can_retry_from_original_source_file(
    tmp_path: Path,
    auth_headers,
    monkeypatch,
    filename: str,
    source_bytes: bytes,
    content_type: str,
) -> None:
    operation_id = str(uuid4())
    ocr_provider = BlockingOcrProvider()
    preparation_calls: list[bytes] = []
    original_prepare_source = documents_router.prepare_source

    def recording_prepare_source(content: bytes, **kwargs):
        preparation_calls.append(content)
        return original_prepare_source(content, **kwargs)

    monkeypatch.setattr(documents_router, "prepare_source", recording_prepare_source)
    with TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            ocr_provider=ocr_provider,
            document_processing_async_jobs=True,
        )
    ) as client:
        project_id = _create_project(client, auth_headers)
        uploaded = client.post(
            f"/projects/{project_id}/documents",
            headers={
                **auth_headers,
                "X-Cert-Prep-Operation-Id": operation_id,
            },
            files={"file": (filename, source_bytes, content_type)},
        )
        document_id = uploaded.json()["id"]
        assert ocr_provider.started.wait(timeout=2)
        client.delete(
            f"/projects/{project_id}/documents/{document_id}/processing",
            headers=auth_headers,
        )
        ocr_provider.release.set()
        _wait_for_document_status(
            client,
            auth_headers,
            project_id,
            document_id,
            "canceled",
        )

        retried = client.post(
            f"/projects/{project_id}/documents/{document_id}/retry",
            headers=auth_headers,
        )
        assert retried.status_code == 202
        retry_operation_id = retried.json()["id"]
        ready = _wait_for_document_status(
            client,
            auth_headers,
            project_id,
            document_id,
            "ready",
        )
        operation = client.get(
            f"/projects/{project_id}/document-operations/{retry_operation_id}",
            headers=auth_headers,
        )

        assert ready["chunks_count"] == 1
        assert operation.json()["status"] == "succeeded"
        assert preparation_calls == [source_bytes, source_bytes]
