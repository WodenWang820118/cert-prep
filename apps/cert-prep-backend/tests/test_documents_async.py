import asyncio
from pathlib import Path
from queue import Empty, Queue
from threading import Event, Lock, Thread
import time

from fastapi.testclient import TestClient
import pytest

from conftest import minimal_image, minimal_pdf
from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.source_documents import repository as source_documents_repository
from cert_prep_backend.domains.source_documents.document_worker_pool import (
    DocumentWorkerPool,
    DocumentWorkItem,
)
from cert_prep_backend.routers import documents as documents_router
from cert_prep_backend.domains.source_documents.ocr import OCRPageResult
from cert_prep_backend.domains.source_documents.ocr_provider_pool import (
    DocumentOCRProviderPool,
)
from document_test_helpers import _create_project, _wait_for_document_status
from document_test_llm_fakes import MockExamProvider
from document_test_ocr_fakes import (
    BlockingOcrProvider,
    MockPaddleOcrProvider,
    PreparingOcrProvider,
)


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


def test_async_upload_returns_fresh_document_when_worker_finishes_during_submit(
    tmp_path: Path,
    auth_headers,
    monkeypatch,
) -> None:
    _run_document_submissions_inline(monkeypatch)
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token="test-token"),
        llm_provider=MockExamProvider(),
        ocr_provider=MockPaddleOcrProvider(),
        document_processing_async_jobs=True,
    )

    with TestClient(app) as client:
        project_id = _create_project(client, auth_headers)
        response = client.post(
            f"/projects/{project_id}/documents",
            headers=auth_headers,
            files={"file": ("inline.pdf", minimal_pdf(""), "application/pdf")},
        )

        assert response.status_code == 201
        document = response.json()
        assert document["status"] == "ready"
        assert document["processed_page_count"] == 1
        assert document["chunks_count"] == 1


def test_async_retry_returns_fresh_operation_when_worker_finishes_during_submit(
    tmp_path: Path,
    auth_headers,
    monkeypatch,
) -> None:
    class FailOnceOcrProvider(MockPaddleOcrProvider):
        def __init__(self) -> None:
            super().__init__()
            self.calls = 0

        def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("first OCR attempt failed")
            return super().extract_page_text(image_png, page_number)

    _run_document_submissions_inline(monkeypatch)
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token="test-token"),
        llm_provider=MockExamProvider(),
        ocr_provider=FailOnceOcrProvider(),
        document_processing_async_jobs=False,
    )

    with TestClient(app) as client:
        project_id = _create_project(client, auth_headers)
        uploaded = client.post(
            f"/projects/{project_id}/documents",
            headers=auth_headers,
            files={"file": ("retry-inline.pdf", minimal_pdf(""), "application/pdf")},
        )
        assert uploaded.status_code == 201
        document = uploaded.json()
        assert document["status"] == "ocr_failed"

        app.state.document_processing_async_jobs = True
        retried = client.post(
            f"/projects/{project_id}/documents/{document['id']}/retry",
            headers=auth_headers,
        )

        assert retried.status_code == 202
        operation = retried.json()
        assert operation["status"] == "succeeded"
        assert operation["phase"] == "completed"


def test_async_static_image_upload_returns_processing_then_page_one_progress(
    tmp_path: Path,
    auth_headers,
) -> None:
    ocr_provider = BlockingOcrProvider()
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
        files={"file": ("async.png", minimal_image("PNG"), "image/png")},
    )

    assert response.status_code == 201
    document = response.json()
    assert document["page_count"] == 1
    assert document["status"] == "processing"
    assert document["processed_page_count"] == 0
    assert document["chunks_count"] == 0
    assert ocr_provider.started.wait(timeout=2)

    ocr_provider.release.set()
    ready = _wait_for_document_status(
        client,
        auth_headers,
        project_id,
        document["id"],
        "ready",
    )
    assert ready["processed_page_count"] == 1
    assert ready["chunks_count"] == 1


def test_async_upload_prepares_document_ocr_before_starting_processing(
    tmp_path: Path,
    auth_headers,
    monkeypatch,
) -> None:
    ocr_provider = PreparingOcrProvider()
    submit_observations: list[list[str]] = []
    original_submit = documents_router._submit_document_processing  # noqa: SLF001

    def recording_submit(**kwargs):
        submit_observations.append(list(ocr_provider.calls))
        return original_submit(**kwargs)

    monkeypatch.setattr(documents_router, "_submit_document_processing", recording_submit)
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token="test-token"),
        ocr_provider=ocr_provider,
        document_processing_async_jobs=True,
    )
    with TestClient(app) as client:
        project_id = _create_project(client, auth_headers)

        response = client.post(
            f"/projects/{project_id}/documents",
            headers=auth_headers,
            files={"file": ("async.pdf", minimal_pdf(""), "application/pdf")},
        )

        assert response.status_code == 201
        document = response.json()
        assert document["status"] == "processing"
        assert submit_observations == [["prepare"]]
        _wait_for_document_status(
            client,
            auth_headers,
            project_id,
            document["id"],
            "ready",
        )
        assert ocr_provider.calls == ["prepare", "extract:1"]


def test_document_ocr_provider_pool_limits_async_documents_to_configured_parallelism(
    tmp_path: Path,
    auth_headers,
) -> None:
    providers: list[ReusableBlockingOcrProvider] = []

    def provider_factory() -> ReusableBlockingOcrProvider:
        provider = ReusableBlockingOcrProvider()
        providers.append(provider)
        return provider

    app = create_app(
        settings=Settings(
            data_dir=tmp_path,
            api_token="test-token",
            document_ocr_parallelism=2,
        ),
        document_ocr_provider_factory=provider_factory,
        document_processing_async_jobs=True,
    )
    with TestClient(app) as client:
        project_id = _create_project(client, auth_headers)

        documents = []
        for filename in ["first.pdf", "second.pdf", "third.pdf"]:
            response = client.post(
                f"/projects/{project_id}/documents",
                headers=auth_headers,
                files={"file": (filename, minimal_pdf(""), "application/pdf")},
            )
            assert response.status_code == 201
            documents.append(response.json())

        assert _wait_for_provider_count(providers, 2)
        assert _wait_for_started_count(providers, 2)
        assert len(providers) == 2
        _wait_for_worker_pool_counts(
            app.state.document_ocr_worker_pool,
            running=2,
            queued=1,
        )
        snapshot = app.state.document_ocr_worker_pool.snapshot()
        assert snapshot.max_workers == 2
        assert snapshot.worker_count == 2

        first_release = _next_release_event(providers)
        first_release.set()
        assert _wait_for_started_count(providers, 3)
        assert len(providers) == 2

        for _ in range(2):
            _next_release_event(providers).set()
        for document in documents:
            _wait_for_document_status(
                client,
                auth_headers,
                project_id,
                document["id"],
                "ready",
            )


def test_queued_pdf_can_be_canceled_immediately_without_starting_ocr(
    tmp_path: Path,
    auth_headers,
) -> None:
    ocr_provider = BlockingOcrProvider()
    app = create_app(
        settings=Settings(
            data_dir=tmp_path,
            api_token="test-token",
            document_ocr_parallelism=1,
        ),
        ocr_provider=ocr_provider,
        document_processing_async_jobs=True,
    )

    with TestClient(app) as client:
        project_id = _create_project(client, auth_headers)
        first = client.post(
            f"/projects/{project_id}/documents",
            headers={**auth_headers, "X-Cert-Prep-Operation-Id": "pdf-queue-first"},
            files={"file": ("first.pdf", minimal_pdf(""), "application/pdf")},
        ).json()
        assert ocr_provider.started.wait(timeout=2)
        second = client.post(
            f"/projects/{project_id}/documents",
            headers={**auth_headers, "X-Cert-Prep-Operation-Id": "pdf-queue-second"},
            files={"file": ("second.pdf", minimal_pdf(""), "application/pdf")},
        ).json()
        _wait_for_worker_pool_counts(
            app.state.document_ocr_worker_pool,
            running=1,
            queued=1,
        )

        canceled = client.delete(
            f"/projects/{project_id}/document-operations/pdf-queue-second",
            headers=auth_headers,
        )

        assert canceled.status_code == 202
        assert canceled.json()["status"] == "canceled"
        _wait_for_worker_pool_counts(
            app.state.document_ocr_worker_pool,
            running=1,
            queued=0,
        )
        assert ocr_provider.ocr_page_numbers == []
        second_document = client.get(
            f"/projects/{project_id}/documents/{second['id']}",
            headers=auth_headers,
        ).json()
        assert second_document["status"] == "canceled"

        ocr_provider.release.set()
        _wait_for_document_status(
            client,
            auth_headers,
            project_id,
            first["id"],
            "ready",
        )
        assert ocr_provider.ocr_page_numbers == [1]


def test_lifespan_shutdown_cancels_active_and_queued_pdf_without_provider_deadlock(
    tmp_path: Path,
    auth_headers,
) -> None:
    ocr_provider = BlockingOcrProvider()
    app = create_app(
        settings=Settings(
            data_dir=tmp_path,
            api_token="test-token",
            document_ocr_parallelism=1,
        ),
        ocr_provider=ocr_provider,
        document_processing_async_jobs=True,
    )

    started_at = time.monotonic()
    with TestClient(app) as client:
        project_id = _create_project(client, auth_headers)
        active = client.post(
            f"/projects/{project_id}/documents",
            headers={**auth_headers, "X-Cert-Prep-Operation-Id": "pdf-close-active"},
            files={"file": ("active.pdf", minimal_pdf(""), "application/pdf")},
        ).json()
        assert ocr_provider.started.wait(timeout=2)
        queued = client.post(
            f"/projects/{project_id}/documents",
            headers={**auth_headers, "X-Cert-Prep-Operation-Id": "pdf-close-queued"},
            files={"file": ("queued.pdf", minimal_pdf(""), "application/pdf")},
        ).json()
        _wait_for_worker_pool_counts(
            app.state.document_ocr_worker_pool,
            running=1,
            queued=1,
        )
        started_at = time.monotonic()

    assert time.monotonic() - started_at < 3.5
    assert source_documents_repository.get_document(
        app.state.database,
        project_id,
        active["id"],
    )["status"] == "canceled"
    assert source_documents_repository.get_document(
        app.state.database,
        project_id,
        queued["id"],
    )["status"] == "canceled"
    shutdown_snapshot = app.state.document_ocr_worker_pool.snapshot()
    assert shutdown_snapshot.closed is True
    assert shutdown_snapshot.worker_count == 1
    assert shutdown_snapshot.queued_count == 0
    assert shutdown_snapshot.running_count == 1
    assert shutdown_snapshot.alive_worker_count == 1

    ocr_provider.release.set()
    _wait_for_worker_pool_counts(
        app.state.document_ocr_worker_pool,
        running=0,
        queued=0,
    )
    deadline = time.monotonic() + 2
    while (
        app.state.document_ocr_worker_pool.snapshot().worker_count > 0
        and time.monotonic() < deadline
    ):
        time.sleep(0.01)
    completed_shutdown = app.state.document_ocr_worker_pool.snapshot()
    assert completed_shutdown.worker_count == 0
    assert completed_shutdown.alive_worker_count == 0


def test_document_ocr_provider_pool_reuses_prepared_slot_before_cold_parallel_slot() -> None:
    providers: list[ReusableBlockingOcrProvider] = []

    def provider_factory() -> ReusableBlockingOcrProvider:
        provider = ReusableBlockingOcrProvider()
        providers.append(provider)
        return provider

    pool = DocumentOCRProviderPool(
        max_parallel_documents=2,
        provider_factory=provider_factory,
        prepare_on_acquire=True,
        close_providers_on_shutdown=True,
    )

    pool.prepare()

    assert len(providers) == 1
    assert providers[0].prepare_count == 1
    with pool.acquire() as prepared_provider:
        assert prepared_provider is providers[0]
        assert len(providers) == 1
        assert providers[0].prepare_count == 1

        with pool.acquire() as parallel_provider:
            assert len(providers) == 2
            assert parallel_provider is providers[1]
            assert [provider.prepare_count for provider in providers] == [1, 1]

    pool.close()
    assert [provider.close_count for provider in providers] == [1, 1]


def test_document_ocr_provider_pool_release_does_not_close_provider() -> None:
    provider = CloseRaisingOcrProvider()
    pool = DocumentOCRProviderPool(
        max_parallel_documents=1,
        provider_factory=lambda: provider,
        prepare_on_acquire=True,
        close_providers_on_shutdown=True,
    )

    with pool.acquire():
        pass

    assert provider.close_count == 0
    pool.close()
    assert provider.close_count == 1


def test_document_ocr_provider_pool_returns_slot_when_prepare_cleanup_fails() -> None:
    providers = [
        PrepareAndCloseFailingOcrProvider(),
        CloseRaisingOcrProvider(),
    ]
    pool = DocumentOCRProviderPool(
        max_parallel_documents=1,
        provider_factory=lambda: providers.pop(0),
        prepare_on_acquire=True,
        close_providers_on_shutdown=True,
    )

    with pytest.raises(RuntimeError, match="prepare failed"):
        pool.acquire()

    with pool.acquire():
        pass


def test_document_ocr_prepare_helper_runs_off_event_loop() -> None:
    started = Event()
    release = Event()

    class SlowPreparePool:
        def prepare(self) -> None:
            started.set()
            release.wait(timeout=0.5)

    async def run_prepare() -> None:
        task = asyncio.create_task(
            documents_router._prepare_document_ocr_provider_pool(  # noqa: SLF001
                SlowPreparePool()
            )
        )
        deadline = time.monotonic() + 2
        while not started.is_set() and time.monotonic() < deadline:
            await asyncio.sleep(0.01)

        assert started.is_set()
        await asyncio.sleep(0)
        assert not task.done()
        release.set()
        await task

    asyncio.run(run_prepare())


def test_document_ocr_provider_pool_close_waits_for_active_lease() -> None:
    provider = CloseRaisingOcrProvider()
    pool = DocumentOCRProviderPool(
        max_parallel_documents=1,
        provider_factory=lambda: provider,
        prepare_on_acquire=True,
        close_providers_on_shutdown=True,
    )
    lease = pool.acquire()
    lease.__enter__()
    close_done = Event()
    close_thread = Thread(
        target=lambda: (pool.close(), close_done.set()),
        daemon=True,
    )

    close_thread.start()
    time.sleep(0.05)

    assert not close_done.is_set()
    assert provider.close_count == 0

    lease.__exit__(None, None, None)
    assert close_done.wait(timeout=2)
    assert provider.close_count == 1

    with pytest.raises(RuntimeError, match="closed"):
        pool.acquire()


class ReusableBlockingOcrProvider(MockPaddleOcrProvider):
    def __init__(self) -> None:
        super().__init__()
        self._lock = Lock()
        self.started_count = 0
        self.release_events: Queue[Event] = Queue()
        self.close_count = 0
        self.prepare_count = 0

    def prepare_for_document_ocr(self) -> None:
        self.prepare_count += 1

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        release = Event()
        with self._lock:
            self.started_count += 1
            self.release_events.put(release)
        assert release.wait(timeout=5)
        return super().extract_page_text(image_png, page_number)

    def close(self) -> None:
        self.close_count += 1


class CloseRaisingOcrProvider(MockPaddleOcrProvider):
    def __init__(self) -> None:
        super().__init__()
        self.prepare_count = 0
        self.close_count = 0

    def prepare_for_document_ocr(self) -> None:
        self.prepare_count += 1

    def close(self) -> None:
        self.close_count += 1
        raise RuntimeError("close failed")


class PrepareAndCloseFailingOcrProvider(CloseRaisingOcrProvider):
    def prepare_for_document_ocr(self) -> None:
        self.prepare_count += 1
        raise RuntimeError("prepare failed")

    def close(self) -> None:
        self.close_count += 1
        raise RuntimeError("close failed")


class _InlineSubmitPool:
    def submit(self, item: DocumentWorkItem) -> None:
        item.run()

    def cancel(self, _operation_id: str) -> bool:
        return False

    def is_closed(self) -> bool:
        return False


def _run_document_submissions_inline(monkeypatch) -> None:
    original_submit = documents_router._submit_document_processing  # noqa: SLF001
    inline_pool = _InlineSubmitPool()

    def submit_inline(**kwargs):
        kwargs["worker_pool"] = inline_pool
        return original_submit(**kwargs)

    monkeypatch.setattr(documents_router, "_submit_document_processing", submit_inline)


def _wait_for_provider_count(
    providers: list[ReusableBlockingOcrProvider],
    expected_count: int,
) -> bool:
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if len(providers) >= expected_count:
            return True
        time.sleep(0.01)
    return len(providers) >= expected_count


def _wait_for_worker_pool_counts(
    pool: DocumentWorkerPool,
    *,
    running: int,
    queued: int,
    timeout: float = 2,
) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        snapshot = pool.snapshot()
        if snapshot.running_count == running and snapshot.queued_count == queued:
            return
        time.sleep(0.01)
    snapshot = pool.snapshot()
    raise AssertionError(
        f"Expected running={running}, queued={queued}; "
        f"actual running={snapshot.running_count}, queued={snapshot.queued_count}."
    )


def _wait_for_started_count(
    providers: list[ReusableBlockingOcrProvider],
    expected_count: int,
) -> bool:
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if sum(provider.started_count for provider in providers) >= expected_count:
            return True
        time.sleep(0.01)
    return sum(provider.started_count for provider in providers) >= expected_count


def _next_release_event(providers: list[ReusableBlockingOcrProvider]) -> Event:
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        for provider in providers:
            try:
                return provider.release_events.get_nowait()
            except Empty:
                pass
        time.sleep(0.01)
    raise AssertionError("Timed out waiting for a blocked OCR extraction.")
