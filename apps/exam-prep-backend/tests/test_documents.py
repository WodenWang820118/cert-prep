import hashlib
from pathlib import Path

from fastapi.testclient import TestClient

from conftest import minimal_pdf
from exam_prep_backend.app import create_app
from exam_prep_backend.config import Settings
from exam_prep_backend.domains.mock_exams.models import DraftSuggestion, SourceChunk
from exam_prep_backend.domains.mock_exams.ports import ProviderHealth
from exam_prep_backend.domains.source_documents.ocr import OCRHealth, OCRPageResult


def test_pdf_upload_hashes_stores_extracts_and_chunks_by_page(
    client: TestClient, auth_headers, tmp_path: Path
) -> None:
    project_id = _create_project(client, auth_headers)
    pdf_bytes = minimal_pdf(
        "Authentication factors include something you know.",
        "Encryption protects data at rest and in transit.",
    )

    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={"file": ("security.pdf", pdf_bytes, "application/pdf")},
    )

    assert response.status_code == 201
    document = response.json()
    expected_sha = hashlib.sha256(pdf_bytes).hexdigest()
    assert document["sha256"] == expected_sha
    assert document["filename"] == "security.pdf"
    assert document["page_count"] == 2
    assert document["has_text"] is True
    assert document["status"] == "ready"
    assert document["extraction_method"] == "embedded"
    assert document["ocr_device"] is None
    assert document["ocr_fallback_reason"] is None
    assert document["ocr_duration_ms"] == 0
    assert document["processed_page_count"] == 2
    assert document["chunks_count"] == 2
    assert document["exam_item_count"] == 2
    assert "storage_path" not in document
    stored_path = tmp_path / "uploads" / project_id / f"{expected_sha}.pdf"
    assert stored_path.is_file()
    assert stored_path.read_bytes() == pdf_bytes

    chunks = client.get(
        f"/projects/{project_id}/documents/{document['id']}/chunks",
        headers=auth_headers,
    )
    assert chunks.status_code == 200
    assert [chunk["page_number"] for chunk in chunks.json()["items"]] == [1, 2]
    assert "Authentication factors" in chunks.json()["items"][0]["text"]
    assert chunks.json()["items"][0]["extraction_method"] == "embedded"

    drafts = client.get(f"/projects/{project_id}/question-drafts", headers=auth_headers)
    assert drafts.status_code == 200
    assert len(drafts.json()["items"]) == 2
    assert drafts.json()["items"][0]["status"] == "approved"


def test_scanned_pdf_upload_is_detected_without_chunks(client: TestClient, auth_headers) -> None:
    project_id = _create_project(client, auth_headers)
    pdf_bytes = minimal_pdf("")

    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={"file": ("scan.pdf", pdf_bytes, "application/pdf")},
    )

    assert response.status_code == 201
    document = response.json()
    assert document["has_text"] is False
    assert document["status"] == "no_text_detected"
    assert document["extraction_method"] == "none"
    assert document["ocr_device"] is None
    assert document["ocr_fallback_reason"] is None
    assert document["ocr_duration_ms"] == 0
    assert document["processed_page_count"] == 0
    assert document["chunks_count"] == 0
    assert document["exam_item_count"] == 0


def test_image_only_pdf_uses_ocr_and_creates_approved_mock_exam(
    tmp_path: Path, auth_headers
) -> None:
    ocr_provider = MockPaddleOcrProvider()
    llm_provider = MockExamProvider()
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            llm_provider=llm_provider,
            ocr_provider=ocr_provider,
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


def test_provider_specific_ocr_method_round_trips_through_upload_response(
    tmp_path: Path, auth_headers
) -> None:
    ocr_provider = MockOllamaOcrProvider()
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            ocr_provider=ocr_provider,
        )
    )
    project_id = _create_project(client, auth_headers)

    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={"file": ("ollama.pdf", minimal_pdf(""), "application/pdf")},
    )

    assert response.status_code == 201
    document = response.json()
    assert document["status"] == "ready"
    assert document["extraction_method"] == "gemma_ocr"
    assert document["ocr_device"] == "ollama"
    assert document["processed_page_count"] == 1
    assert "storage_path" not in document

    chunks = client.get(
        f"/projects/{project_id}/documents/{document['id']}/chunks",
        headers=auth_headers,
    ).json()["items"]
    assert chunks[0]["extraction_method"] == "gemma_ocr"
    assert chunks[0]["page_number"] == 1


def test_mixed_embedded_and_ocr_pdf_keeps_page_order(tmp_path: Path, auth_headers) -> None:
    ocr_provider = MockPaddleOcrProvider()
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            ocr_provider=ocr_provider,
        )
    )
    project_id = _create_project(client, auth_headers)

    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={
            "file": (
                "mixed.pdf",
                minimal_pdf("Embedded page text for page one.", ""),
                "application/pdf",
            )
        },
    )

    assert response.status_code == 201
    document = response.json()
    assert document["status"] == "ready"
    assert document["extraction_method"] == "mixed"
    assert document["processed_page_count"] == 2
    assert document["chunks_count"] == 2
    assert ocr_provider.ocr_page_numbers == [2]

    chunks = client.get(
        f"/projects/{project_id}/documents/{document['id']}/chunks",
        headers=auth_headers,
    ).json()["items"]
    assert [chunk["page_number"] for chunk in chunks] == [1, 2]
    assert [chunk["extraction_method"] for chunk in chunks] == [
        "embedded",
        "paddle_ocr_gpu",
    ]


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
    assert document["processed_page_count"] == 2
    assert document["chunks_count"] == 2
    assert document["exam_item_count"] == 2
    assert ocr_provider.ocr_page_numbers == [1, 2, 3]

    chunks = client.get(
        f"/projects/{project_id}/documents/{document['id']}/chunks",
        headers=auth_headers,
    ).json()["items"]
    assert [chunk["page_number"] for chunk in chunks] == [1, 3]


def test_pdf_upload_rejects_oversized_file(tmp_path: Path, auth_headers) -> None:
    client = TestClient(
        create_app(settings=Settings(data_dir=tmp_path, api_token="test-token", max_upload_bytes=8))
    )
    project_id = _create_project(client, auth_headers)

    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={"file": ("large.pdf", minimal_pdf("too large"), "application/pdf")},
    )

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"


def _create_project(client: TestClient, auth_headers) -> str:
    response = client.post("/projects", headers=auth_headers, json={"name": "CISSP"})
    assert response.status_code == 201
    return response.json()["id"]


class MockExamProvider:
    provider = "mock-exam"
    model = "gemma4:12b"

    def health(self) -> ProviderHealth:
        return ProviderHealth(
            provider=self.provider,
            model=self.model,
            available=True,
            detail="test provider",
        )

    def generate_drafts(
        self, chunks: list[SourceChunk] | tuple[SourceChunk, ...], limit: int
    ) -> list[DraftSuggestion]:
        suggestions = [
            DraftSuggestion(
                chunk_id=chunk.id,
                question=f"JLPT question {chunk.page_number}: choose the correct word.",
                choices=["A correct", "B wrong"],
                answer="A correct",
                answer_key_source="ai_inferred",
                rationale="OCR text identifies A as the correct option.",
                citation_page=chunk.page_number,
                source_excerpt=f"JLPT question {chunk.page_number}: choose the correct word.",
            )
            for chunk in chunks
        ]
        return suggestions[:limit]


class MockPaddleOcrProvider:
    provider = "mock-ocr"
    engine = "paddleocr"

    def __init__(self) -> None:
        self.ocr_page_numbers: list[int] = []

    def health(self) -> OCRHealth:
        return OCRHealth(
            provider=self.provider,
            engine=self.engine,
            available=True,
            detail="test provider",
            python_version="3.13.5",
            paddle_version="3.3.0",
            paddleocr_version="3.3.0",
            selected_device="gpu:0",
            cuda_available=True,
            gpu_count=1,
            model_cache_dir=None,
            fallback_reason=None,
        )

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        assert image_png.startswith(b"\x89PNG")
        self.ocr_page_numbers.append(page_number)
        return OCRPageResult(
            text=f"JLPT question {page_number}: choose the correct word. A correct B wrong",
            extraction_method="paddle_ocr_gpu",
            device="gpu:0",
            fallback_reason=None,
            duration_ms=123,
        )


class MockOllamaOcrProvider(MockPaddleOcrProvider):
    provider = "mock-ollama"
    engine = "gemma4:12b"

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        assert image_png.startswith(b"\x89PNG")
        self.ocr_page_numbers.append(page_number)
        return OCRPageResult(
            text=f"Ollama OCR page {page_number}",
            extraction_method="gemma_ocr",
            device="ollama",
            fallback_reason=None,
            duration_ms=77,
        )


class FailingSecondPageOcrProvider(MockPaddleOcrProvider):
    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        assert image_png.startswith(b"\x89PNG")
        self.ocr_page_numbers.append(page_number)
        if page_number == 2:
            raise RuntimeError("simulated OCR failure")
        return OCRPageResult(
            text=f"JLPT question {page_number}: choose the correct word. A correct B wrong",
            extraction_method="paddle_ocr_cpu_fallback",
            device="cpu",
            fallback_reason="gpu:0 failed: simulated GPU OCR failure",
            duration_ms=123,
        )
