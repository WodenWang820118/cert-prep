from __future__ import annotations

from cert_prep_backend.source_library.domain.exam_content import (
    aggregate_content_profile,
    classification_summary,
    content_profile_from_value,
)
from cert_prep_backend.source_library.domain.source import ExtractedPage


def source_classification(pages: tuple[ExtractedPage, ...]) -> tuple[str, str]:
    """Aggregate page-level content profiles into source classification fields."""

    profiles = [content_profile_from_value(page.content_profile) for page in pages]
    return aggregate_content_profile(profiles).value, classification_summary(profiles)


def source_classification_from_db(
    connection,
    project_id: str,
    source_id: str,
    *,
    fallback_pages: tuple[ExtractedPage, ...] = (),
) -> tuple[str, str]:
    """Recompute source classification from persisted chunks or fallback pages."""

    rows = connection.execute(
        """
        SELECT content_profile
        FROM source_chunks
        WHERE project_id = ? AND source_id = ?
        ORDER BY page_number, chunk_index
        """,
        (project_id, source_id),
    ).fetchall()
    if rows:
        profiles = [row["content_profile"] for row in rows]
        return aggregate_content_profile(profiles).value, classification_summary(profiles)
    return source_classification(fallback_pages)
