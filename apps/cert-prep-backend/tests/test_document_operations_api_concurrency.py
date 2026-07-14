from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier

from fastapi.testclient import TestClient

from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.source_documents import operations
from cert_prep_backend.routers import documents as documents_router
from conftest import minimal_pdf
from document_test_helpers import _create_project
from document_test_ocr_fakes import BlockingOcrProvider, MockPaddleOcrProvider
from test_document_operations_api import OPERATION_HEADER, _wait_for_operation


BARRIER_TIMEOUT_SECONDS = 5
FUTURE_TIMEOUT_SECONDS = 10


def test_concurrent_uploads_with_same_operation_id_create_one_document(
    tmp_path: Path,
    auth_headers,
    monkeypatch,
) -> None:
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token="test-token"),
        ocr_provider=MockPaddleOcrProvider(),
        document_processing_async_jobs=False,
    )
    setup_client = TestClient(app)
    project_id = _create_project(setup_client, auth_headers)
    barrier = Barrier(2)
    original_claim = operations.claim_operation

    def synchronized_claim(*args, **kwargs):
        barrier.wait(timeout=BARRIER_TIMEOUT_SECONDS)
        return original_claim(*args, **kwargs)

    monkeypatch.setattr(operations, "claim_operation", synchronized_claim)

    def upload(filename: str, text: str):
        client = TestClient(app)
        return client.post(
            f"/projects/{project_id}/documents",
            headers={**auth_headers, OPERATION_HEADER: "shared-upload"},
            files={"file": (filename, minimal_pdf(text), "application/pdf")},
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(upload, filename, text)
            for filename, text in (
                ("first.pdf", "first source"),
                ("second.pdf", "second source"),
            )
        ]
        responses = [
            future.result(timeout=FUTURE_TIMEOUT_SECONDS) for future in futures
        ]

    assert sorted(response.status_code for response in responses) == [201, 409]
    conflict = next(response for response in responses if response.status_code == 409)
    assert conflict.json()["code"] == "operation_conflict"
    with app.state.database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM document_operations").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 1


def test_concurrent_upload_and_delete_share_header_without_duplicate_work(
    tmp_path: Path,
    auth_headers,
    monkeypatch,
) -> None:
    ocr_provider = BlockingOcrProvider()
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token="test-token"),
        ocr_provider=ocr_provider,
        document_processing_async_jobs=True,
    )
    setup_client = TestClient(app)
    project_id = _create_project(setup_client, auth_headers)
    barrier = Barrier(2)
    original_claim = operations.claim_operation
    original_cancel = operations.cancel_operation

    def synchronized_claim(*args, **kwargs):
        barrier.wait(timeout=BARRIER_TIMEOUT_SECONDS)
        return original_claim(*args, **kwargs)

    def synchronized_cancel(*args, **kwargs):
        barrier.wait(timeout=BARRIER_TIMEOUT_SECONDS)
        return original_cancel(*args, **kwargs)

    monkeypatch.setattr(operations, "claim_operation", synchronized_claim)
    monkeypatch.setattr(operations, "cancel_operation", synchronized_cancel)

    def upload():
        return TestClient(app).post(
            f"/projects/{project_id}/documents",
            headers={**auth_headers, OPERATION_HEADER: "upload-delete-race"},
            files={"file": ("scan.pdf", minimal_pdf(""), "application/pdf")},
        )

    def cancel():
        return TestClient(app).delete(
            f"/projects/{project_id}/document-operations/upload-delete-race",
            headers=auth_headers,
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        upload_future = executor.submit(upload)
        cancel_future = executor.submit(cancel)
        uploaded = upload_future.result(timeout=FUTURE_TIMEOUT_SECONDS)
        canceled = cancel_future.result(timeout=FUTURE_TIMEOUT_SECONDS)

    assert canceled.status_code == 202
    assert uploaded.status_code in {201, 409}
    if uploaded.status_code == 409:
        assert uploaded.json()["code"] == "operation_canceled"
    else:
        assert canceled.json()["status"] == "cancel_requested"

    ocr_provider.release.set()
    terminal = _wait_for_operation(
        setup_client,
        auth_headers,
        project_id,
        "upload-delete-race",
        "canceled",
    )
    documents = setup_client.get(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
    ).json()["items"]

    if uploaded.status_code == 409:
        assert terminal["document_id"] is None
        assert documents == []
    else:
        assert terminal["document_id"] == uploaded.json()["id"]
        assert len(documents) == 1
        assert documents[0]["status"] == "canceled"
        assert documents[0]["chunks_count"] == 0


def test_public_cancel_vs_publish_has_only_atomic_terminal_outcomes(
    tmp_path: Path,
    auth_headers,
    monkeypatch,
) -> None:
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token="test-token"),
        ocr_provider=MockPaddleOcrProvider(),
        document_processing_async_jobs=True,
    )
    client = TestClient(app)
    project_id = _create_project(client, auth_headers)
    barrier = Barrier(2)
    original_publish = operations.publish_success
    original_cancel = operations.cancel_operation

    def synchronized_publish(*args, **kwargs):
        barrier.wait(timeout=BARRIER_TIMEOUT_SECONDS)
        return original_publish(*args, **kwargs)

    def synchronized_cancel(*args, **kwargs):
        barrier.wait(timeout=BARRIER_TIMEOUT_SECONDS)
        return original_cancel(*args, **kwargs)

    monkeypatch.setattr(operations, "publish_success", synchronized_publish)
    monkeypatch.setattr(operations, "cancel_operation", synchronized_cancel)

    uploaded = client.post(
        f"/projects/{project_id}/documents",
        headers={**auth_headers, OPERATION_HEADER: "publish-cancel-race"},
        files={
            "file": (
                "source.pdf",
                minimal_pdf("Atomic publication source."),
                "application/pdf",
            )
        },
    )
    assert uploaded.status_code == 201
    canceled = client.delete(
        f"/projects/{project_id}/document-operations/publish-cancel-race",
        headers=auth_headers,
    )
    assert canceled.status_code == 202
    assert canceled.json()["status"] in {"cancel_requested", "succeeded"}

    expected_terminal = (
        "canceled"
        if canceled.json()["status"] == "cancel_requested"
        else "succeeded"
    )
    terminal = _wait_for_operation(
        client,
        auth_headers,
        project_id,
        "publish-cancel-race",
        expected_terminal,
    )
    document = client.get(
        f"/projects/{project_id}/documents/{uploaded.json()['id']}",
        headers=auth_headers,
    ).json()

    if expected_terminal == "succeeded":
        assert terminal["phase"] == "completed"
        assert document["status"] == "ready"
        assert document["chunks_count"] == 1
    else:
        assert terminal["phase"] == "canceled"
        assert document["status"] == "canceled"
        assert document["chunks_count"] == 0


def test_concurrent_retry_has_one_public_owner_and_one_worker(
    tmp_path: Path,
    auth_headers,
    monkeypatch,
) -> None:
    ocr_provider = BlockingOcrProvider()
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token="test-token"),
        ocr_provider=ocr_provider,
        document_processing_async_jobs=True,
    )
    client = TestClient(app)
    project_id = _create_project(client, auth_headers)
    uploaded = client.post(
        f"/projects/{project_id}/documents",
        headers={**auth_headers, OPERATION_HEADER: "seed-upload"},
        files={"file": ("scan.pdf", minimal_pdf(""), "application/pdf")},
    )
    document_id = uploaded.json()["id"]
    assert ocr_provider.started.wait(timeout=2)
    client.delete(
        f"/projects/{project_id}/document-operations/seed-upload",
        headers=auth_headers,
    )
    ocr_provider.release.set()
    _wait_for_operation(
        client,
        auth_headers,
        project_id,
        "seed-upload",
        "canceled",
    )
    ocr_provider.started.clear()
    ocr_provider.release.clear()

    barrier = Barrier(2)
    original_retry = operations.start_retry_operation

    def synchronized_retry(*args, **kwargs):
        barrier.wait(timeout=BARRIER_TIMEOUT_SECONDS)
        return original_retry(*args, **kwargs)

    monkeypatch.setattr(operations, "start_retry_operation", synchronized_retry)

    def retry(operation_id: str):
        retry_client = TestClient(app)
        return retry_client.post(
            f"/projects/{project_id}/documents/{document_id}/retry",
            headers={**auth_headers, OPERATION_HEADER: operation_id},
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(retry, operation_id)
            for operation_id in ("retry-one", "retry-two")
        ]
        responses = [
            future.result(timeout=FUTURE_TIMEOUT_SECONDS) for future in futures
        ]

    assert sorted(response.status_code for response in responses) == [202, 409]
    conflict = next(response for response in responses if response.status_code == 409)
    assert conflict.json()["code"] == "document_retry_conflict"
    assert ocr_provider.started.wait(timeout=2)
    with app.state.database.connect() as connection:
        assert connection.execute(
            """
            SELECT COUNT(*)
            FROM document_operations
            WHERE document_id = ? AND status IN ('queued', 'running', 'cancel_requested')
            """,
            (document_id,),
        ).fetchone()[0] == 1

    winner = next(response.json()["id"] for response in responses if response.status_code == 202)
    ocr_provider.release.set()
    _wait_for_operation(client, auth_headers, project_id, winner, "succeeded")


def test_worker_start_failure_terminalizes_operation(
    tmp_path: Path,
    auth_headers,
    monkeypatch,
) -> None:
    class FailingThread:
        def __init__(self, **_kwargs) -> None:
            pass

        def start(self) -> None:
            raise RuntimeError("thread start failed")

    monkeypatch.setattr(documents_router, "Thread", FailingThread)
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token="test-token"),
        ocr_provider=MockPaddleOcrProvider(),
        document_processing_async_jobs=True,
    )
    client = TestClient(app, raise_server_exceptions=False)
    project_id = _create_project(client, auth_headers)

    response = client.post(
        f"/projects/{project_id}/documents",
        headers={**auth_headers, OPERATION_HEADER: "worker-start-failure"},
        files={"file": ("source.pdf", minimal_pdf("study"), "application/pdf")},
    )

    assert response.status_code == 500
    operation = client.get(
        f"/projects/{project_id}/document-operations/worker-start-failure",
        headers=auth_headers,
    ).json()
    assert operation["status"] == "failed"
    assert operation["phase"] == "failed"
    assert operation["cancellable"] is False
    assert operation["error"] == "Document processing worker could not start."
