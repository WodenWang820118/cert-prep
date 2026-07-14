from pathlib import Path
from threading import Event

from fastapi.testclient import TestClient

from conftest import minimal_pdf
from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.source_documents import pdf_extraction
from cert_prep_backend.api.errors import InvalidPdfError
from document_test_helpers import (
    _create_project,
    _wait_for_document_progress,
    _wait_for_document_status,
)
from document_test_llm_fakes import MockExamProvider
from document_test_ocr_fakes import (
    BlockingFirstPageOcrProvider,
    DelayedOcrProvider,
    FailingSecondPageOcrProvider,
    MissingPaddleRuntimeProvider,
    MockPaddleOcrProvider,
    PageOneObservedOcrProvider,
    PrepareFailingPaddleRuntimeProvider,
)


def test_image_only_pdf_reports_missing_paddle_runtime(tmp_path: Path, auth_headers) -> None:
    client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                auto_generate_exam_on_upload=True,
            ),
            ocr_provider=MissingPaddleRuntimeProvider(),
            document_processing_async_jobs=False,
        )
    )
    project_id = _create_project(client, auth_headers)

    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={"file": ("scan.pdf", minimal_pdf(""), "application/pdf")},
    )

    assert response.status_code == 201
    document = response.json()
    assert document["status"] == "ocr_failed"
    assert document["ocr_fallback_reason"] == "PaddleOCR runtime is not installed."


def test_upload_prepare_failure_reports_missing_paddle_runtime(
    tmp_path: Path,
    auth_headers,
) -> None:
    client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                auto_generate_exam_on_upload=True,
            ),
            ocr_provider=PrepareFailingPaddleRuntimeProvider(),
            document_processing_async_jobs=True,
        )
    )
    project_id = _create_project(client, auth_headers)

    response = client.post(
        f"/projects/{project_id}/documents",
        headers={
            **auth_headers,
            "X-Cert-Prep-Operation-Id": "prepare-failure",
        },
        files={"file": ("scan.pdf", minimal_pdf(""), "application/pdf")},
    )

    assert response.status_code == 503
    assert response.json() == {
        "code": "paddle_runtime_missing",
        "message": "PaddleOCR runtime is not installed.",
    }

    documents = client.get(f"/projects/{project_id}/documents", headers=auth_headers)
    assert documents.status_code == 200
    assert documents.json()["items"] == []
    operation = client.get(
        f"/projects/{project_id}/document-operations/prepare-failure",
        headers=auth_headers,
    )
    assert operation.status_code == 200
    assert operation.json()["status"] == "failed"
    assert operation.json()["error"] == "OCR runtime is unavailable."
    assert list(tmp_path.rglob("*.pdf")) == []


def test_image_only_pdf_uses_ocr_and_creates_draft_mock_exam(
    tmp_path: Path, auth_headers
) -> None:
    ocr_provider = MockPaddleOcrProvider()
    llm_provider = MockExamProvider()
    client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                auto_generate_exam_on_upload=True,
            ),
            llm_provider=llm_provider,
            ocr_provider=ocr_provider,
            document_processing_async_jobs=False,
        )
    )
    project_id = _create_project(client, auth_headers)

    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={"file": ("jlpt.pdf", minimal_pdf(""), "application/pdf")},
    )

    assert response.status_code == 201
    document = response.json()
    assert document["has_text"] is True
    assert document["status"] == "ready"
    assert document["extraction_method"] == "paddle_ocr_gpu"
    assert document["ocr_device"] == "gpu:0"
    assert document["ocr_fallback_reason"] is None
    assert document["ocr_duration_ms"] == 123
    assert document["processed_page_count"] == 1
    assert document["parse_wall_duration_ms"] >= document["first_chunk_ms"] >= 1
    assert document["render_duration_ms"] >= 0
    assert document["ocr_engine_duration_ms"] == 123
    assert document["ocr_worker_count"] == 1
    assert document["chunks_count"] == 1
    assert document["exam_item_count"] == 1
    assert ocr_provider.ocr_page_numbers == [1]

    chunks = client.get(
        f"/projects/{project_id}/documents/{document['id']}/chunks",
        headers=auth_headers,
    ).json()["items"]
    assert chunks[0]["extraction_method"] == "paddle_ocr_gpu"
    assert "JLPT question 1" in chunks[0]["text"]

    drafts = client.get(f"/projects/{project_id}/question-drafts", headers=auth_headers)
    item = drafts.json()["items"][0]
    assert item["status"] == "approved"
    assert item["answer_key_source"] == "ai_inferred"
    assert item["citation_page"] == 1
    assert item["source_excerpt"] in chunks[0]["text"]


def test_image_only_pdf_ocr_continues_after_single_page_failure(
    tmp_path: Path, auth_headers
) -> None:
    ocr_provider = FailingSecondPageOcrProvider()
    llm_provider = MockExamProvider()
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            llm_provider=llm_provider,
            ocr_provider=ocr_provider,
            document_processing_async_jobs=False,
        )
    )
    project_id = _create_project(client, auth_headers)

    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={"file": ("jlpt.pdf", minimal_pdf("", "", ""), "application/pdf")},
    )

    assert response.status_code == 201
    document = response.json()
    assert document["status"] == "ready"
    assert document["extraction_method"] == "paddle_ocr_cpu_fallback"
    assert document["ocr_device"] == "cpu"
    assert document["ocr_fallback_reason"] == "gpu:0 failed: simulated GPU OCR failure"
    assert document["ocr_duration_ms"] == 246
    assert document["processed_page_count"] == 3
    assert document["chunks_count"] == 2
    assert document["exam_item_count"] == 0
    assert ocr_provider.ocr_page_numbers == [1, 2, 3]

    chunks = client.get(
        f"/projects/{project_id}/documents/{document['id']}/chunks",
        headers=auth_headers,
    ).json()["items"]
    assert [chunk["page_number"] for chunk in chunks] == [1, 3]


def test_image_only_pdf_ocr_continues_after_single_page_render_failure(
    tmp_path: Path, auth_headers, monkeypatch
) -> None:
    original_render = pdf_extraction.render_pdf_page_png

    def fail_second_page(pdf_bytes: bytes, *, page_index: int, scale: float) -> bytes:
        if page_index == 1:
            raise InvalidPdfError("Could not render page 2 for OCR.")
        return original_render(pdf_bytes, page_index=page_index, scale=scale)

    monkeypatch.setattr(pdf_extraction, "render_pdf_page_png", fail_second_page)
    ocr_provider = MockPaddleOcrProvider()
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            ocr_provider=ocr_provider,
            document_processing_async_jobs=False,
        )
    )
    project_id = _create_project(client, auth_headers)

    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={"file": ("jlpt.pdf", minimal_pdf("", "", ""), "application/pdf")},
    )

    assert response.status_code == 201
    document = response.json()
    assert document["status"] == "ready"
    assert document["extraction_method"] == "paddle_ocr_gpu"
    assert document["ocr_fallback_reason"] == "Could not render page 2 for OCR."
    assert document["processed_page_count"] == 3
    assert document["chunks_count"] == 2
    assert ocr_provider.ocr_page_numbers == [1, 3]

    chunks = client.get(
        f"/projects/{project_id}/documents/{document['id']}/chunks",
        headers=auth_headers,
    ).json()["items"]
    assert [chunk["page_number"] for chunk in chunks] == [1, 3]


def test_ocr_page_flushes_before_all_pages_finish_embedded_scan(monkeypatch) -> None:
    ocr_provider = PageOneObservedOcrProvider()
    scan_order: list[int] = []
    page_three_scan_started = Event()
    progress_snapshots: list[tuple[int, int, bool]] = []

    class BlankPage:
        def __init__(self, page_number: int) -> None:
            self.page_number = page_number

        def extract_text(self) -> str:
            scan_order.append(self.page_number)
            if self.page_number == 2:
                assert ocr_provider.page_one_finished.wait(timeout=2)
            if self.page_number == 3:
                page_three_scan_started.set()
            return ""

    class FakePdfReader:
        def __init__(self, stream) -> None:
            self.pages = [BlankPage(1), BlankPage(2), BlankPage(3)]

    def render_page(pdf_bytes: bytes, *, page_index: int, scale: float) -> bytes:
        return b"\x89PNG\r\nfake-page"

    def record_progress(progress: pdf_extraction.PdfExtractionProgress) -> None:
        if progress.page is not None:
            progress_snapshots.append(
                (
                    progress.page_number,
                    len(scan_order),
                    page_three_scan_started.is_set(),
                )
            )

    monkeypatch.setattr(pdf_extraction, "PdfReader", FakePdfReader)
    monkeypatch.setattr(pdf_extraction, "render_pdf_page_png", render_page)

    result = pdf_extraction.extract_pdf_pages(
        b"%PDF fake",
        max_pages=3,
        max_page_text_chars=10_000,
        max_total_text_chars=30_000,
        ocr_provider=ocr_provider,
        on_page_processed=record_progress,
    )

    assert any(
        page_number == 1 and scanned_page_count < 3 and not page_three_started
        for page_number, scanned_page_count, page_three_started in progress_snapshots
    )
    assert result.processed_page_count == 3
    assert result.ocr_worker_count == 1
    assert [page.page_number for page in result.pages] == [1, 2, 3]
    assert ocr_provider.ocr_page_numbers == [1, 2, 3]


def test_ocr_page_workers_preserve_final_order_and_metrics(
    tmp_path: Path,
    auth_headers,
) -> None:
    for worker_count in (1, 2):
        ocr_provider = DelayedOcrProvider(page_workers=worker_count)
        client = TestClient(
            create_app(
                settings=Settings(
                    data_dir=tmp_path / f"workers-{worker_count}",
                    api_token="test-token",
                    ocr_page_workers=worker_count,
                ),
                ocr_provider=ocr_provider,
                document_processing_async_jobs=False,
            )
        )
        project_id = _create_project(client, auth_headers)

        response = client.post(
            f"/projects/{project_id}/documents",
            headers=auth_headers,
            files={"file": ("scan.pdf", minimal_pdf("", "", ""), "application/pdf")},
        )

        assert response.status_code == 201
        document = response.json()
        assert document["status"] == "ready"
        assert document["processed_page_count"] == 3
        assert document["ocr_duration_ms"] == 60
        assert document["ocr_engine_duration_ms"] == 60
        assert document["ocr_worker_count"] == worker_count
        assert document["parse_wall_duration_ms"] >= document["first_chunk_ms"] >= 1
        assert document["render_duration_ms"] >= 0

        chunks = client.get(
            f"/projects/{project_id}/documents/{document['id']}/chunks",
            headers=auth_headers,
        ).json()["items"]
        assert [chunk["page_number"] for chunk in chunks] == [1, 2, 3]
        assert [chunk["chunk_index"] for chunk in chunks] == [0, 1, 2]
        assert [chunk["text"] for chunk in chunks] == [
            "Worker page 1",
            "Worker page 2",
            "Worker page 3",
        ]


def test_parallel_ocr_flushes_completed_page_before_all_pages_finish(
    tmp_path: Path,
    auth_headers,
) -> None:
    ocr_provider = BlockingFirstPageOcrProvider()
    client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                ocr_page_workers=2,
            ),
            ocr_provider=ocr_provider,
            document_processing_async_jobs=True,
        )
    )
    project_id = _create_project(client, auth_headers)

    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={"file": ("scan.pdf", minimal_pdf("", ""), "application/pdf")},
    )

    assert response.status_code == 201
    document = response.json()
    assert document["status"] == "processing"
    assert ocr_provider.page_one_started.wait(timeout=2)
    try:
        assert ocr_provider.page_two_finished.wait(timeout=2)
        partial = _wait_for_document_progress(
            client,
            auth_headers,
            project_id,
            document["id"],
            processed_page_count=1,
            chunks_count=1,
        )
        assert partial["status"] == "processing"

        chunks = client.get(
            f"/projects/{project_id}/documents/{document['id']}/chunks",
            headers=auth_headers,
        ).json()["items"]
        assert [(chunk["page_number"], chunk["chunk_index"]) for chunk in chunks] == [(2, 1)]
        assert chunks[0]["text"] == "Worker page 2"
    finally:
        ocr_provider.release_page_one.set()

    ready = _wait_for_document_status(client, auth_headers, project_id, document["id"], "ready")
    assert ready["processed_page_count"] == 2
    assert ready["chunks_count"] == 2
    assert ready["ocr_duration_ms"] == 30
    assert ocr_provider.ocr_page_numbers == [2, 1]

    chunks = client.get(
        f"/projects/{project_id}/documents/{document['id']}/chunks",
        headers=auth_headers,
    ).json()["items"]
    assert [chunk["page_number"] for chunk in chunks] == [1, 2]
    assert [chunk["chunk_index"] for chunk in chunks] == [0, 1]
    assert [chunk["text"] for chunk in chunks] == ["Worker page 1", "Worker page 2"]
