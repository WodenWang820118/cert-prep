import hashlib
from pathlib import Path

from fastapi.testclient import TestClient

from conftest import minimal_pdf
from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import Settings
from document_test_helpers import _create_project, _wait_for_question_drafts
from document_test_llm_fakes import MockExamProvider
from document_test_ocr_fakes import MockOllamaOcrProvider, MockPaddleOcrProvider


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


def test_sequential_pdf_uploads_in_one_project_keep_document_scoped_chunks(
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
