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
    thread_observations: list[tuple[str, list[str]]] = []

    class RecordingThread:
        def __init__(self, *, target, args, name: str, daemon: bool) -> None:
            self.target = target
            self.args = args
            self.name = name
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


def test_document_ocr_provider_pool_limits_async_documents_to_configured_parallelism(
    tmp_path: Path,
    auth_headers,
) -> None:
    providers: list[ReusableBlockingOcrProvider] = []

    def provider_factory() -> ReusableBlockingOcrProvider:
        provider = ReusableBlockingOcrProvider()
        providers.append(provider)
        return provider

    client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                document_ocr_parallelism=2,
            ),
            document_ocr_provider_factory=provider_factory,
            document_processing_async_jobs=True,
        )
    )
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

    first_release = _next_release_event(providers)
    first_release.set()
    assert _wait_for_started_count(providers, 3)
    assert len(providers) == 2

    for _ in range(2):
        _next_release_event(providers).set()
    for document in documents:
        _wait_for_document_status(client, auth_headers, project_id, document["id"], "ready")


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
