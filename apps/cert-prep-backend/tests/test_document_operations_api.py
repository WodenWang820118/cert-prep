from __future__ import annotations

from pathlib import Path
import time

from fastapi.testclient import TestClient

from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import Settings
from cert_prep_backend.core.exceptions import ProviderUnavailableError
from cert_prep_backend.domains.source_documents import operations as document_operations
from conftest import minimal_pdf
from document_test_helpers import _create_project
from document_test_ocr_fakes import BlockingOcrProvider, MockPaddleOcrProvider


OPERATION_HEADER = "X-Cert-Prep-Operation-Id"


def test_upload_operation_is_public_and_reaches_atomic_success(
    tmp_path: Path,
    auth_headers,
) -> None:
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            ocr_provider=MockPaddleOcrProvider(),
            document_processing_async_jobs=False,
        )
    )
    project_id = _create_project(client, auth_headers)

    uploaded = client.post(
        f"/projects/{project_id}/documents",
        headers={**auth_headers, OPERATION_HEADER: "upload-operation-1"},
        files={
            "file": (
                "source.pdf",
                minimal_pdf("Embedded study material."),
                "application/pdf",
            )
        },
    )

    assert uploaded.status_code == 201
    operation = client.get(
        f"/projects/{project_id}/document-operations/upload-operation-1",
        headers=auth_headers,
    )
    assert operation.status_code == 200
    assert operation.json() == {
        "id": "upload-operation-1",
        "project_id": project_id,
        "document_id": uploaded.json()["id"],
        "status": "succeeded",
        "phase": "completed",
        "cancellable": False,
        "error": None,
        "created_at": operation.json()["created_at"],
        "updated_at": operation.json()["updated_at"],
    }


def test_delete_before_upload_creates_idempotent_cancel_tombstone(
    tmp_path: Path,
    auth_headers,
) -> None:
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            document_processing_async_jobs=False,
        )
    )
    project_id = _create_project(client, auth_headers)
    path = f"/projects/{project_id}/document-operations/cancel-before-post"

    first = client.delete(path, headers=auth_headers)
    second = client.delete(path, headers=auth_headers)

    assert first.status_code == 202
    assert second.status_code == 202
    assert second.json() == first.json()
    assert first.json()["status"] == "canceled"
    assert first.json()["document_id"] is None

    upload = client.post(
        f"/projects/{project_id}/documents",
        headers={**auth_headers, OPERATION_HEADER: "cancel-before-post"},
        files={"file": ("source.pdf", minimal_pdf("study"), "application/pdf")},
    )

    assert upload.status_code == 409
    assert upload.json()["code"] == "operation_canceled"
    documents = client.get(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
    )
    assert documents.json()["items"] == []


def test_operation_header_validation_has_no_persisted_side_effects(
    tmp_path: Path,
    auth_headers,
) -> None:
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token="test-token"),
        document_processing_async_jobs=False,
    )
    client = TestClient(app)
    project_id = _create_project(client, auth_headers)

    for invalid_id in ("", "bad/id", " leading-space", "x" * 129):
        response = client.post(
            f"/projects/{project_id}/documents",
            headers={**auth_headers, OPERATION_HEADER: invalid_id},
            files={"file": ("source.pdf", minimal_pdf("study"), "application/pdf")},
        )
        assert response.status_code == 422
        assert response.json()["code"] == "validation_error"

    with app.state.database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM document_operations").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 0


def test_running_document_cancel_acknowledges_then_retry_reuses_source_pdf(
    tmp_path: Path,
    auth_headers,
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
        headers={**auth_headers, OPERATION_HEADER: "cancel-running"},
        files={"file": ("scan.pdf", minimal_pdf(""), "application/pdf")},
    )
    assert uploaded.status_code == 201
    document_id = uploaded.json()["id"]
    assert ocr_provider.started.wait(timeout=2)

    requested = client.delete(
        f"/projects/{project_id}/documents/{document_id}/processing",
        headers=auth_headers,
    )
    assert requested.status_code == 202
    assert requested.json()["status"] == "cancel_requested"
    assert requested.json()["phase"] == "canceling"
    assert requested.json()["cancellable"] is False

    ocr_provider.release.set()
    canceled = _wait_for_operation(
        client,
        auth_headers,
        project_id,
        "cancel-running",
        "canceled",
    )
    assert canceled["document_id"] == document_id
    canceled_document = client.get(
        f"/projects/{project_id}/documents/{document_id}",
        headers=auth_headers,
    ).json()
    assert canceled_document["status"] == "canceled"
    assert canceled_document["processed_page_count"] == 0
    assert canceled_document["chunks_count"] == 0

    with app.state.database.connect() as connection:
        storage_path = Path(
            connection.execute(
                "SELECT storage_path FROM documents WHERE id = ?",
                (document_id,),
            ).fetchone()[0]
        )
    assert storage_path.is_file()

    retried = client.post(
        f"/projects/{project_id}/documents/{document_id}/retry",
        headers={**auth_headers, OPERATION_HEADER: "retry-canceled"},
    )
    assert retried.status_code == 202
    assert retried.json()["status"] == "running"
    succeeded = _wait_for_operation(
        client,
        auth_headers,
        project_id,
        "retry-canceled",
        "succeeded",
    )
    assert succeeded["document_id"] == document_id
    ready = client.get(
        f"/projects/{project_id}/documents/{document_id}",
        headers=auth_headers,
    ).json()
    assert ready["status"] == "ready"
    assert ready["chunks_count"] == 1


def test_canceled_worker_acknowledges_once_without_failure_finalizer(
    tmp_path: Path,
    auth_headers,
    monkeypatch,
) -> None:
    ocr_provider = BlockingOcrProvider()
    acknowledged: list[str] = []
    failed: list[str] = []
    original_acknowledge = document_operations.acknowledge_cancellation
    original_finish_failed = document_operations.finish_failed

    def recording_acknowledge(*args, **kwargs):
        acknowledged.append(str(kwargs["operation_id"]))
        return original_acknowledge(*args, **kwargs)

    def recording_finish_failed(*args, **kwargs):
        failed.append(str(kwargs["operation_id"]))
        return original_finish_failed(*args, **kwargs)

    monkeypatch.setattr(
        document_operations,
        "acknowledge_cancellation",
        recording_acknowledge,
    )
    monkeypatch.setattr(document_operations, "finish_failed", recording_finish_failed)
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token="test-token"),
        ocr_provider=ocr_provider,
        document_processing_async_jobs=True,
    )
    with TestClient(app) as client:
        project_id = _create_project(client, auth_headers)

        uploaded = client.post(
            f"/projects/{project_id}/documents",
            headers={**auth_headers, OPERATION_HEADER: "ack-worker"},
            files={"file": ("scan.pdf", minimal_pdf(""), "application/pdf")},
        )
        assert uploaded.status_code == 201
        assert ocr_provider.started.wait(timeout=2)

        requested = client.delete(
            f"/projects/{project_id}/document-operations/ack-worker",
            headers=auth_headers,
        )
        assert requested.status_code == 202
        assert requested.json()["status"] == "cancel_requested"
        ocr_provider.release.set()

        terminal = _wait_for_operation(
            client,
            auth_headers,
            project_id,
            "ack-worker",
            "canceled",
        )
        deadline = time.monotonic() + 2
        while (
            app.state.document_ocr_worker_pool.snapshot().running_count > 0
            and time.monotonic() < deadline
        ):
            time.sleep(0.01)

        assert terminal["document_id"] == uploaded.json()["id"]
        assert acknowledged == ["ack-worker"]
        assert failed == []
        assert app.state.document_ocr_worker_pool.snapshot().running_count == 0

    assert app.state.document_ocr_worker_pool.snapshot().alive_worker_count == 0


def test_retry_missing_source_fails_before_mutating_document(
    tmp_path: Path,
    auth_headers,
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
        headers={**auth_headers, OPERATION_HEADER: "source-missing-upload"},
        files={"file": ("scan.pdf", minimal_pdf(""), "application/pdf")},
    )
    document_id = uploaded.json()["id"]
    assert ocr_provider.started.wait(timeout=2)
    client.delete(
        f"/projects/{project_id}/document-operations/source-missing-upload",
        headers=auth_headers,
    )
    ocr_provider.release.set()
    _wait_for_operation(
        client,
        auth_headers,
        project_id,
        "source-missing-upload",
        "canceled",
    )

    before = _document_work_snapshot(app, project_id, document_id)
    Path(before["document"]["storage_path"]).unlink()

    response = client.post(
        f"/projects/{project_id}/documents/{document_id}/retry",
        headers={**auth_headers, OPERATION_HEADER: "missing-source-retry"},
    )

    assert response.status_code == 409
    assert response.json()["code"] == "document_source_missing"
    assert _document_work_snapshot(app, project_id, document_id) == before


def test_retry_ocr_prepare_failure_has_no_persisted_mutation(
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
    document_id = _create_canceled_document(
        client,
        auth_headers,
        project_id,
        ocr_provider,
        operation_id="prepare-seed",
    )
    before = _document_work_snapshot(app, project_id, document_id)

    def fail_prepare() -> None:
        raise ProviderUnavailableError("OCR runtime is unavailable for retry.")

    monkeypatch.setattr(app.state.document_ocr_provider_pool, "prepare", fail_prepare)
    response = client.post(
        f"/projects/{project_id}/documents/{document_id}/retry",
        headers={**auth_headers, OPERATION_HEADER: "prepare-retry"},
    )

    assert response.status_code == 503
    assert response.json()["code"] == "paddle_runtime_missing"
    assert _document_work_snapshot(app, project_id, document_id) == before


def test_retry_tampered_source_hash_has_no_persisted_mutation(
    tmp_path: Path,
    auth_headers,
) -> None:
    ocr_provider = BlockingOcrProvider()
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token="test-token"),
        ocr_provider=ocr_provider,
        document_processing_async_jobs=True,
    )
    client = TestClient(app)
    project_id = _create_project(client, auth_headers)
    document_id = _create_canceled_document(
        client,
        auth_headers,
        project_id,
        ocr_provider,
        operation_id="tamper-seed",
    )
    before = _document_work_snapshot(app, project_id, document_id)
    Path(before["document"]["storage_path"]).write_bytes(b"tampered source")

    response = client.post(
        f"/projects/{project_id}/documents/{document_id}/retry",
        headers={**auth_headers, OPERATION_HEADER: "tamper-retry"},
    )

    assert response.status_code == 409
    assert response.json()["code"] == "document_source_missing"
    assert _document_work_snapshot(app, project_id, document_id) == before


def test_retry_invalid_document_status_has_no_persisted_mutation(
    tmp_path: Path,
    auth_headers,
) -> None:
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token="test-token"),
        ocr_provider=MockPaddleOcrProvider(),
        document_processing_async_jobs=False,
    )
    client = TestClient(app)
    project_id = _create_project(client, auth_headers)
    uploaded = client.post(
        f"/projects/{project_id}/documents",
        headers={**auth_headers, OPERATION_HEADER: "ready-seed"},
        files={
            "file": (
                "ready.pdf",
                minimal_pdf("Already processed source."),
                "application/pdf",
            )
        },
    )
    assert uploaded.status_code == 201
    document_id = uploaded.json()["id"]
    assert uploaded.json()["status"] == "ready"
    before = _document_work_snapshot(app, project_id, document_id)

    response = client.post(
        f"/projects/{project_id}/documents/{document_id}/retry",
        headers={**auth_headers, OPERATION_HEADER: "ready-retry"},
    )

    assert response.status_code == 409
    assert response.json()["code"] == "document_retry_not_allowed"
    assert _document_work_snapshot(app, project_id, document_id) == before


def test_document_operation_auth_isolation_and_cors_contract(
    tmp_path: Path,
    auth_headers,
) -> None:
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            document_processing_async_jobs=False,
        )
    )
    owner_project = _create_project(client, auth_headers)
    other_project = _create_project(client, auth_headers)
    uploaded = client.post(
        f"/projects/{owner_project}/documents",
        headers={**auth_headers, OPERATION_HEADER: "isolated-operation"},
        files={"file": ("source.pdf", minimal_pdf("study"), "application/pdf")},
    )
    document_id = uploaded.json()["id"]
    owner_before = _document_work_snapshot(app=client.app, project_id=owner_project, document_id=document_id)
    operation_path = (
        f"/projects/{owner_project}/document-operations/isolated-operation"
    )

    assert client.get(operation_path).status_code == 401
    assert client.get(
        f"/projects/{other_project}/document-operations/isolated-operation",
        headers=auth_headers,
    ).status_code == 404
    cross_project_cancel = client.delete(
        f"/projects/{other_project}/document-operations/isolated-operation",
        headers=auth_headers,
    )
    assert cross_project_cancel.status_code == 409
    assert cross_project_cancel.json()["code"] == "operation_conflict"
    assert client.delete(
        f"/projects/{other_project}/documents/{document_id}/processing",
        headers=auth_headers,
    ).status_code == 404

    preflight = client.options(
        f"/projects/{owner_project}/documents",
        headers={
            "Origin": "http://localhost:4200",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": OPERATION_HEADER,
        },
    )
    assert preflight.status_code == 200
    assert OPERATION_HEADER.lower() in preflight.headers[
        "access-control-allow-headers"
    ].lower()
    assert (
        _document_work_snapshot(
            app=client.app,
            project_id=owner_project,
            document_id=document_id,
        )
        == owner_before
    )


def _create_canceled_document(
    client: TestClient,
    auth_headers,
    project_id: str,
    ocr_provider: BlockingOcrProvider,
    *,
    operation_id: str,
) -> str:
    uploaded = client.post(
        f"/projects/{project_id}/documents",
        headers={**auth_headers, OPERATION_HEADER: operation_id},
        files={"file": ("scan.pdf", minimal_pdf(""), "application/pdf")},
    )
    assert uploaded.status_code == 201
    document_id = str(uploaded.json()["id"])
    assert ocr_provider.started.wait(timeout=2)
    canceled = client.delete(
        f"/projects/{project_id}/document-operations/{operation_id}",
        headers=auth_headers,
    )
    assert canceled.status_code == 202
    assert canceled.json()["status"] == "cancel_requested"
    ocr_provider.release.set()
    _wait_for_operation(
        client,
        auth_headers,
        project_id,
        operation_id,
        "canceled",
    )
    return document_id


def _document_work_snapshot(app, project_id: str, document_id: str) -> dict:
    def rows(connection, table: str) -> list[dict]:
        return [
            dict(row)
            for row in connection.execute(
                f"SELECT * FROM {table} WHERE project_id = ? AND document_id = ? ORDER BY id",
                (project_id, document_id),
            ).fetchall()
        ]

    with app.state.database.connect() as connection:
        document = connection.execute(
            "SELECT * FROM documents WHERE project_id = ? AND id = ?",
            (project_id, document_id),
        ).fetchone()
        assert document is not None
        return {
            "document": dict(document),
            "chunks": rows(connection, "document_chunks"),
            "draft_jobs": rows(connection, "draft_generation_jobs"),
            "question_drafts": rows(connection, "question_drafts"),
            "operations": [
                dict(row)
                for row in connection.execute(
                    "SELECT * FROM document_operations WHERE project_id = ? ORDER BY id",
                    (project_id,),
                ).fetchall()
            ],
        }


def _wait_for_operation(
    client: TestClient,
    auth_headers,
    project_id: str,
    operation_id: str,
    expected_status: str,
) -> dict:
    deadline = time.monotonic() + 5
    latest: dict | None = None
    while time.monotonic() < deadline:
        response = client.get(
            f"/projects/{project_id}/document-operations/{operation_id}",
            headers=auth_headers,
        )
        assert response.status_code == 200
        latest = response.json()
        if latest["status"] == expected_status:
            return latest
        time.sleep(0.02)
    raise AssertionError(
        f"Operation {operation_id} did not reach {expected_status}: {latest}"
    )
