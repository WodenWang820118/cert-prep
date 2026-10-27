from __future__ import annotations

from fastapi.testclient import TestClient

from conftest import minimal_image, minimal_pdf
from document_test_helpers import _create_project
from cert_prep_backend.source_library.domain.models import DocumentChunk
from cert_prep_backend.source_library.api.markdown import (
    markdown_content_disposition,
    markdown_download_filename,
    render_pdf_markdown,
)


def _chunk(page_number: int, text: str) -> DocumentChunk:
    return DocumentChunk(
        id=f"chunk-{page_number}-{len(text)}",
        document_id="document",
        page_number=page_number,
        chunk_index=0,
        text=text,
        raw_text=text,
        line_start=None,
        line_end=None,
        line_count=0,
        source_excerpt=text,
        extraction_method="embedded",
        content_profile="unknown",
        created_at="2026-10-27T00:00:00+00:00",
    )


def test_render_pdf_markdown_orders_pages_and_preserves_unicode() -> None:
    filename = "\u30101\u30112025\u5e7407\u6708N1 \u771f\u984c.pdf"
    content = render_pdf_markdown(
        filename=filename,
        chunks=[
            _chunk(2, "第二頁文字"),
            _chunk(1, "第一頁文字"),
            _chunk(2, "第二頁補充"),
        ],
    )

    assert content == (
        f"# {filename}\n\n"
        "## Page 1\n\n"
        "第一頁文字\n\n"
        "## Page 2\n\n"
        "第二頁文字\n\n"
        "第二頁補充\n"
    )


def test_render_pdf_markdown_keeps_empty_chunk_as_an_empty_page_body() -> None:
    assert render_pdf_markdown(
        filename="empty.pdf",
        chunks=[_chunk(1, "")],
    ) == "# empty.pdf\n\n## Page 1\n"


def test_markdown_download_filename_and_content_disposition_are_safe() -> None:
    filename = "\u30101\u30112025\u5e7407\u6708N1 \u771f\u984c.pdf"

    assert markdown_download_filename(filename) == (
        "\u30101\u30112025\u5e7407\u6708N1 \u771f\u984c.md"
    )
    header = markdown_content_disposition(filename)
    assert header.startswith('attachment; filename="')
    assert '"; filename*=' in header
    assert "/" not in header.split(";", 1)[1].split('"', 1)[0]
    assert "filename*=UTF-8''%E3%80%901%E3%80%912025" in header


def test_ready_pdf_can_be_downloaded_as_markdown(
    client: TestClient,
    auth_headers: dict[str, str],
) -> None:
    project_id = _create_project(client, auth_headers)
    response = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={
            "file": (
                "\u30101\u30112025\u5e7407\u6708N1 \u771f\u984c.pdf",
                minimal_pdf("page one", "page two"),
                "application/pdf",
            )
        },
    )
    assert response.status_code == 201
    document = response.json()

    markdown = client.get(
        f"/projects/{project_id}/documents/{document['id']}/markdown",
        headers=auth_headers,
    )

    assert markdown.status_code == 200
    assert markdown.headers["content-type"] == "text/markdown; charset=utf-8"
    assert markdown.headers["cache-control"] == "private, no-store"
    assert "filename*=UTF-8''" in markdown.headers["content-disposition"]
    assert markdown.text == (
        "# \u30101\u30112025\u5e7407\u6708N1 \u771f\u984c.pdf\n\n"
        "## Page 1\n\n"
        "page one\n\n"
        "## Page 2\n\n"
        "page two\n"
    )


def test_markdown_rejects_unready_or_non_pdf_documents(
    client: TestClient,
    auth_headers: dict[str, str],
) -> None:
    project_id = _create_project(client, auth_headers)
    image = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={"file": ("image.png", minimal_image(), "image/png")},
    )
    assert image.status_code == 201
    image_markdown = client.get(
        f"/projects/{project_id}/documents/{image.json()['id']}/markdown",
        headers=auth_headers,
    )
    assert image_markdown.status_code == 409
    assert image_markdown.json()["code"] == "markdown_unavailable"

    missing = client.get(
        f"/projects/{project_id}/documents/missing/markdown",
        headers=auth_headers,
    )
    assert missing.status_code == 404
