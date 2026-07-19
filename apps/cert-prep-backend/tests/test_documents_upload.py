import hashlib
from io import BytesIO
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from conftest import minimal_audio, minimal_image, minimal_pdf
from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import Settings
from document_test_helpers import _create_project, _wait_for_question_drafts
from document_test_llm_fakes import MockExamProvider
from document_test_ocr_fakes import (
    CapturingOcrProvider,
    JlptBlockOcrProvider,
    MockOllamaOcrProvider,
    MockPaddleOcrProvider,
)


def _animated_image(image_format: str) -> bytes:
    frames = [Image.new("RGB", (2, 2), color) for color in ("red", "blue")]
    output = BytesIO()
    frames[0].save(
        output,
        format=image_format,
        save_all=True,
        append_images=frames[1:],
        duration=100,
        loop=0,
    )
    return output.getvalue()


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
        data={"language_hint": "ja"},
        files={"file": ("security.pdf", pdf_bytes, "application/pdf")},
    )

    assert response.status_code == 201
    document = response.json()
    expected_sha = hashlib.sha256(pdf_bytes).hexdigest()
    assert document["sha256"] == expected_sha
    assert document["filename"] == "security.pdf"
    assert document["language_hint"] == "ja"
    assert document["page_count"] == 2
    assert document["has_text"] is True
    assert document["status"] == "ready"
    assert document["extraction_method"] == "embedded"
    assert document["ocr_device"] is None
    assert document["ocr_fallback_reason"] is None
    assert document["ocr_duration_ms"] == 0
    assert document["processed_page_count"] == 2
    assert document["parse_wall_duration_ms"] >= 0
    assert document["render_duration_ms"] == 0
    assert document["ocr_engine_duration_ms"] == 0
    assert document["ocr_worker_count"] == 0
    assert document["first_chunk_ms"] >= 1
    assert document["chunks_count"] == 2
    assert document["exam_item_count"] == 0
    assert document["content_profile"] == "unknown"
    assert document["classification_detail"]
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
    first_chunk = chunks.json()["items"][0]
    assert "Authentication factors" in first_chunk["text"]
    assert "Authentication factors" in first_chunk["raw_text"]
    assert first_chunk["line_start"] == 1
    assert first_chunk["line_end"] >= 1
    assert first_chunk["line_count"] >= 1
    assert first_chunk["content_profile"] == "unknown"
    assert first_chunk["extraction_method"] == "embedded"

    drafts = client.get(f"/projects/{project_id}/question-drafts", headers=auth_headers)
    assert drafts.status_code == 200
    assert drafts.json()["items"] == []

    documents = client.get(f"/projects/{project_id}/documents", headers=auth_headers)
    assert documents.status_code == 200
    assert documents.json()["items"][0]["id"] == document["id"]
    assert documents.json()["items"][0]["chunks_count"] == 2
    assert "storage_path" not in documents.json()["items"][0]

    detail = client.get(
        f"/projects/{project_id}/documents/{document['id']}",
        headers=auth_headers,
    )
    assert detail.status_code == 200
    assert detail.json()["id"] == document["id"]
    assert detail.json()["language_hint"] == "ja"


@pytest.mark.parametrize(
    ("image_format", "filename", "content_type", "canonical_suffix"),
    [
        ("PNG", "source.png", "image/png", ".png"),
        ("JPEG", "source.jpeg", "image/jpeg", ".jpg"),
        ("WEBP", "source.webp", "image/webp", ".webp"),
    ],
)
def test_static_image_upload_hashes_stores_raw_bytes_and_creates_page_one_chunk(
    tmp_path: Path,
    auth_headers,
    image_format: str,
    filename: str,
    content_type: str,
    canonical_suffix: str,
) -> None:
    ocr_provider = CapturingOcrProvider()
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            ocr_provider=ocr_provider,
            document_processing_async_jobs=False,
        )
    )
    project_id = _create_project(client, auth_headers)
    image_bytes = minimal_image(image_format)

    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        data={"language_hint": "mixed"},
        files={"file": (filename, image_bytes, content_type)},
    )

    assert response.status_code == 201
    document = response.json()
    expected_sha = hashlib.sha256(image_bytes).hexdigest()
    assert document["filename"] == filename
    assert document["sha256"] == expected_sha
    assert document["language_hint"] == "mixed"
    assert document["page_count"] == 1
    assert document["processed_page_count"] == 1
    assert document["status"] == "ready"
    assert document["extraction_method"] == "paddle_ocr_gpu"
    assert document["ocr_device"] == "gpu:0"
    assert document["render_duration_ms"] == 0
    assert document["chunks_count"] == 1

    stored_path = tmp_path / "uploads" / project_id / f"{expected_sha}{canonical_suffix}"
    assert stored_path.is_file()
    assert stored_path.read_bytes() == image_bytes
    assert ocr_provider.ocr_page_numbers == [1]
    assert len(ocr_provider.image_payloads) == 1
    with Image.open(BytesIO(ocr_provider.image_payloads[0])) as normalized:
        assert normalized.format == "PNG"
        assert normalized.mode == "RGB"

    chunks = client.get(
        f"/projects/{project_id}/documents/{document['id']}/chunks",
        headers=auth_headers,
    )
    assert chunks.status_code == 200
    assert len(chunks.json()["items"]) == 1
    assert chunks.json()["items"][0]["page_number"] == 1
    assert chunks.json()["items"][0]["extraction_method"] == "paddle_ocr_gpu"


def test_source_content_overrides_misleading_upload_metadata(
    tmp_path: Path,
    auth_headers,
) -> None:
    ocr_provider = CapturingOcrProvider()
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            ocr_provider=ocr_provider,
            document_processing_async_jobs=False,
        )
    )
    project_id = _create_project(client, auth_headers)
    image_bytes = minimal_image("PNG")

    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={"file": ("misleading.pdf", image_bytes, "application/pdf")},
    )

    assert response.status_code == 201
    document = response.json()
    expected_sha = hashlib.sha256(image_bytes).hexdigest()
    assert document["filename"] == "misleading.pdf"
    assert (tmp_path / "uploads" / project_id / f"{expected_sha}.png").read_bytes() == (
        image_bytes
    )


def test_static_image_with_no_ocr_text_uses_no_text_detected_status(
    client: TestClient,
    auth_headers,
) -> None:
    project_id = _create_project(client, auth_headers)

    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={"file": ("blank.png", minimal_image("PNG"), "image/png")},
    )

    assert response.status_code == 201
    document = response.json()
    assert document["page_count"] == 1
    assert document["processed_page_count"] == 1
    assert document["status"] == "no_text_detected"
    assert document["extraction_method"] == "none"
    assert document["chunks_count"] == 0


def test_static_image_ocr_failure_uses_existing_ocr_failed_status(
    tmp_path: Path,
    auth_headers,
) -> None:
    class FailingImageOcrProvider(MockPaddleOcrProvider):
        def extract_page_text(self, image_png: bytes, page_number: int):
            raise RuntimeError("simulated image OCR failure")

    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            ocr_provider=FailingImageOcrProvider(),
            document_processing_async_jobs=False,
        )
    )
    project_id = _create_project(client, auth_headers)

    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={"file": ("failure.png", minimal_image("PNG"), "image/png")},
    )

    assert response.status_code == 201
    document = response.json()
    assert document["status"] == "ocr_failed"
    assert document["extraction_method"] == "ocr_failed"
    assert document["processed_page_count"] == 1
    assert document["chunks_count"] == 0


@pytest.mark.parametrize(
    ("filename", "content"),
    [
        ("unsupported.bmp", minimal_image("BMP")),
        ("unsupported.gif", minimal_image("GIF")),
        ("unsupported.tiff", minimal_image("TIFF")),
        ("unsupported.svg", b"<svg xmlns='http://www.w3.org/2000/svg'></svg>"),
        ("unsupported.heic", b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00heicmif1"),
        ("corrupt.jpg", minimal_image("JPEG")[:32]),
        ("animated.png", _animated_image("PNG")),
        ("animated.webp", _animated_image("WEBP")),
    ],
)
def test_source_upload_rejects_unsupported_corrupt_and_animated_content(
    client: TestClient,
    auth_headers,
    filename: str,
    content: bytes,
) -> None:
    project_id = _create_project(client, auth_headers)

    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={"file": (filename, content, "application/octet-stream")},
    )

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"


def test_source_upload_rejects_empty_file(client: TestClient, auth_headers) -> None:
    project_id = _create_project(client, auth_headers)

    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={"file": ("empty.png", b"", "image/png")},
    )

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"


def test_source_upload_rejects_image_over_configured_pixel_limit(
    tmp_path: Path,
    auth_headers,
) -> None:
    client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                max_image_pixels=5,
            ),
            document_processing_async_jobs=False,
        )
    )
    project_id = _create_project(client, auth_headers)

    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={
            "file": (
                "too-many-pixels.png",
                minimal_image("PNG", size=(3, 2)),
                "image/png",
            )
        },
    )

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"
    assert "6 pixels; the limit is 5" in response.json()["message"]


def test_multiple_pdf_uploads_in_one_project_keep_document_scoped_chunks(
    tmp_path: Path, auth_headers
) -> None:
    client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                streaming_draft_generation_on_upload=True,
                streaming_draft_generation_page_limit=1,
            ),
            llm_provider=MockExamProvider(),
            document_processing_async_jobs=False,
            streaming_draft_generation_async_jobs=False,
        )
    )
    project_id = _create_project(client, auth_headers)

    first_response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={
            "file": (
                "identity.pdf",
                minimal_pdf(
                    "Mondai 1 Alpha document page one covers identity proofing. "
                    "1 A correct 2 B wrong 3 C wrong 4 D wrong",
                    "Alpha document page two covers password rotation.",
                ),
                "application/pdf",
            )
        },
    )
    second_response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={
            "file": (
                "network.pdf",
                minimal_pdf(
                    "Mondai 1 Beta document page one covers firewall policy. "
                    "1 A correct 2 B wrong 3 C wrong 4 D wrong",
                    "Beta document page two covers network segmentation.",
                ),
                "application/pdf",
            )
        },
    )

    assert first_response.status_code == 201
    assert second_response.status_code == 201
    first_document = first_response.json()
    second_document = second_response.json()
    assert first_document["id"] != second_document["id"]

    documents_response = client.get(f"/projects/{project_id}/documents", headers=auth_headers)
    assert documents_response.status_code == 200
    documents_by_id = {
        document["id"]: document for document in documents_response.json()["items"]
    }
    assert {first_document["id"], second_document["id"]}.issubset(documents_by_id)
    assert documents_by_id[first_document["id"]]["filename"] == "identity.pdf"
    assert documents_by_id[second_document["id"]]["filename"] == "network.pdf"

    first_chunks_response = client.get(
        f"/projects/{project_id}/documents/{first_document['id']}/chunks",
        headers=auth_headers,
    )
    second_chunks_response = client.get(
        f"/projects/{project_id}/documents/{second_document['id']}/chunks",
        headers=auth_headers,
    )

    assert first_chunks_response.status_code == 200
    assert second_chunks_response.status_code == 200
    first_chunks = first_chunks_response.json()["items"]
    second_chunks = second_chunks_response.json()["items"]
    assert [chunk["page_number"] for chunk in first_chunks] == [1, 2]
    assert [chunk["page_number"] for chunk in second_chunks] == [1, 2]
    assert "Alpha document page one" in first_chunks[0]["text"]
    assert "Alpha document page two" in first_chunks[1]["text"]
    assert "Beta document page one" not in first_chunks[0]["text"]
    assert "Beta document page two" not in first_chunks[1]["text"]
    assert "Beta document page one" in second_chunks[0]["text"]
    assert "Beta document page two" in second_chunks[1]["text"]
    assert "Alpha document page one" not in second_chunks[0]["text"]
    assert "Alpha document page two" not in second_chunks[1]["text"]

    drafts = _wait_for_question_drafts(client, auth_headers, project_id, count=2)
    drafts_by_document_id = {
        document_id: [
            draft for draft in drafts if draft["document_id"] == document_id
        ]
        for document_id in [first_document["id"], second_document["id"]]
    }
    assert {first_document["id"], second_document["id"]} == {
        draft["document_id"] for draft in drafts
    }
    assert len(drafts_by_document_id[first_document["id"]]) == 1
    assert len(drafts_by_document_id[second_document["id"]]) == 1
    first_draft = drafts_by_document_id[first_document["id"]][0]
    second_draft = drafts_by_document_id[second_document["id"]][0]
    assert first_draft["answer_key_source"] == "ai_inferred"
    assert second_draft["answer_key_source"] == "ai_inferred"
    assert "Alpha document page one" in first_draft["source_excerpt"]
    assert "Beta document page one" not in first_draft["source_excerpt"]
    assert "Beta document page one" in second_draft["source_excerpt"]
    assert "Alpha document page one" not in second_draft["source_excerpt"]


def test_pdf_and_image_uploads_keep_streaming_drafts_document_scoped(
    tmp_path: Path,
    auth_headers,
) -> None:
    client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                streaming_draft_generation_on_upload=True,
                streaming_draft_generation_page_limit=1,
            ),
            llm_provider=MockExamProvider(),
            ocr_provider=JlptBlockOcrProvider(),
            document_processing_async_jobs=False,
            streaming_draft_generation_async_jobs=False,
        )
    )
    project_id = _create_project(client, auth_headers)

    pdf_response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={
            "file": (
                "source.pdf",
                minimal_pdf(
                    "Mondai 1 PDF document question. "
                    "1 A correct 2 B wrong 3 C wrong 4 D wrong"
                ),
                "application/pdf",
            )
        },
    )
    image_response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={"file": ("source.png", minimal_image("PNG"), "image/png")},
    )

    assert pdf_response.status_code == 201
    assert image_response.status_code == 201
    document_ids = {pdf_response.json()["id"], image_response.json()["id"]}
    drafts = _wait_for_question_drafts(client, auth_headers, project_id, count=2)
    assert {draft["document_id"] for draft in drafts} == document_ids
    assert all(draft["answer_key_source"] == "ai_inferred" for draft in drafts)


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
    assert document["processed_page_count"] == 1
    assert document["chunks_count"] == 0
    assert document["exam_item_count"] == 0


def test_provider_specific_ocr_method_round_trips_through_upload_response(
    tmp_path: Path, auth_headers
) -> None:
    ocr_provider = MockOllamaOcrProvider()
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
            document_processing_async_jobs=False,
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


def test_pdf_upload_rejects_oversized_file(tmp_path: Path, auth_headers) -> None:
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token", max_upload_bytes=8),
            document_processing_async_jobs=False,
        )
    )
    project_id = _create_project(client, auth_headers)

    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={"file": ("large.pdf", minimal_pdf("too large"), "application/pdf")},
    )

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"


def test_audio_upload_uses_configured_audio_size_limit(
    tmp_path: Path,
    auth_headers,
) -> None:
    client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                max_audio_upload_bytes=8,
            ),
            document_processing_async_jobs=False,
        )
    )
    project_id = _create_project(client, auth_headers)
    wav = minimal_audio(".wav")

    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={"file": ("large.wav", wav, "audio/wav")},
    )

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"
    assert "limit is 8 bytes" in response.json()["message"]


def test_disguised_pdf_cannot_bypass_audio_signature_validation(
    tmp_path: Path,
    auth_headers,
) -> None:
    pdf = minimal_pdf("ordinary document limit")
    client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                max_upload_bytes=8,
                max_audio_upload_bytes=len(pdf) + 1,
            ),
            document_processing_async_jobs=False,
        )
    )
    project_id = _create_project(client, auth_headers)

    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={"file": ("disguised.mp3", pdf, "audio/mpeg")},
    )

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"
    assert "does not match its MP3, WAV, or M4A type" in response.json()["message"]
