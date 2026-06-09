import hashlib
from pathlib import Path

from fastapi.testclient import TestClient

from conftest import minimal_pdf


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
    assert document["chunks_count"] == 2
    assert Path(document["storage_path"]).is_file()
    assert Path(document["storage_path"]).read_bytes() == pdf_bytes

    chunks = client.get(
        f"/projects/{project_id}/documents/{document['id']}/chunks",
        headers=auth_headers,
    )
    assert chunks.status_code == 200
    assert [chunk["page_number"] for chunk in chunks.json()["items"]] == [1, 2]
    assert "Authentication factors" in chunks.json()["items"][0]["text"]


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
    assert document["chunks_count"] == 0


def _create_project(client: TestClient, auth_headers) -> str:
    response = client.post("/projects", headers=auth_headers, json={"name": "CISSP"})
    assert response.status_code == 201
    return response.json()["id"]
