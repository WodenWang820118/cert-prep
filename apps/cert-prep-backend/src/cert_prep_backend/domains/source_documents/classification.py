from __future__ import annotations

from cert_prep_backend.domains.exam_content import (
    aggregate_content_profile,
    classification_summary,
    content_profile_from_value,
)
from cert_prep_backend.domains.source_documents.models import ExtractedPage


def document_extraction_method_from_db(
    connection,
    project_id: str,
    document_id: str,
    *,
    fallback: str,
) -> str:
    """Derive a document-level extraction method from its page chunks."""

    rows = connection.execute(
        """
        SELECT DISTINCT extraction_method
        FROM document_chunks
        WHERE project_id = ? AND document_id = ?
        """,
        (project_id, document_id),
    ).fetchall()
    methods = {row["extraction_method"] for row in rows}
    if not methods:
        return fallback
    if len(methods) == 1:
        return methods.pop()
    return "mixed"


def document_classification(pages: tuple[ExtractedPage, ...]) -> tuple[str, str]:
    """Aggregate page-level content profiles into document classification fields."""

    profiles = [content_profile_from_value(page.content_profile) for page in pages]
    return aggregate_content_profile(profiles).value, classification_summary(profiles)


def document_classification_from_db(
    connection,
    project_id: str,
    document_id: str,
    *,
    fallback_pages: tuple[ExtractedPage, ...] = (),
) -> tuple[str, str]:
    """Recompute document classification from persisted chunks or fallback pages."""

    rows = connection.execute(
        """
        SELECT content_profile
        FROM document_chunks
        WHERE project_id = ? AND document_id = ?
        ORDER BY page_number, chunk_index
        """,
        (project_id, document_id),
    ).fetchall()
    if rows:
        profiles = [row["content_profile"] for row in rows]
        return aggregate_content_profile(profiles).value, classification_summary(profiles)
    return document_classification(fallback_pages)
