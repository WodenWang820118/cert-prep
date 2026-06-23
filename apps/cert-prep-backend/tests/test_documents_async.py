from pathlib import Path

from fastapi.testclient import TestClient

from conftest import minimal_pdf
from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import Settings
from cert_prep_backend.routers import documents as documents_router
from document_test_helpers import _create_project, _wait_for_document_status
from document_test_llm_fakes import MockExamProvider
from document_test_ocr_fakes import BlockingOcrProvider, PreparingOcrProvider


def test_async_upload_returns_processing_then_progresses(tmp_path: Path, auth_headers) -> None:
    ocr_provider = BlockingOcrProvider()
    llm_provider = MockExamProvider()
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            llm_provider=llm_provider,
            ocr_provider=ocr_provider,
            document_processing_async_jobs=True,
        )
    )
    project_id = _create_project(client, auth_headers)

    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={"file": ("async.pdf", minimal_pdf(""), "application/pdf")},
    )

    assert response.status_code == 201
    document = response.json()
    assert document["status"] == "processing"
    assert document["processed_page_count"] == 0
    assert document["chunks_count"] == 0
    assert ocr_provider.started.wait(timeout=2)

    processing = client.get(
        f"/projects/{project_id}/documents/{document['id']}",
        headers=auth_headers,
    )
    assert processing.status_code == 200
    assert processing.json()["status"] == "processing"

    ocr_provider.release.set()
    ready = _wait_for_document_status(client, auth_headers, project_id, document["id"], "ready")
    assert ready["processed_page_count"] == 1
    assert ready["chunks_count"] == 1
    assert ready["exam_item_count"] == 0


def test_async_upload_prepares_document_ocr_before_starting_processing(
    tmp_path: Path,
    auth_headers,
    monkeypatch,
) -> None:
    ocr_provider = PreparingOcrProvider()
    thread_observations: list[tuple[str, list[str]]] = []

    class RecordingThread:
        def __init__(self, *, target, args, daemon: bool) -> None:
            self.target = target
            self.args = args
            self.daemon = daemon
            thread_observations.append(("constructed", list(ocr_provider.calls)))

        def start(self) -> None:
            thread_observations.append(("started", list(ocr_provider.calls)))

    monkeypatch.setattr(documents_router, "Thread", RecordingThread)
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            ocr_provider=ocr_provider,
            document_processing_async_jobs=True,
        )
    )
    project_id = _create_project(client, auth_headers)

    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={"file": ("async.pdf", minimal_pdf(""), "application/pdf")},
    )

    assert response.status_code == 201
    assert response.json()["status"] == "processing"
    assert ocr_provider.calls == ["prepare"]
    assert thread_observations == [
        ("constructed", ["prepare"]),
        ("started", ["prepare"]),
    ]
