from __future__ import annotations

from sqlite3 import Row
from uuid import uuid4

from exam_prep_backend.database import Database
from exam_prep_backend.domains.exam_content import content_profile_from_value, line_metadata
from exam_prep_backend.domains.source_documents.models import ExtractedPage
from exam_prep_backend.domains.source_documents.records import ensure_document_exists
from exam_prep_backend.errors import NotFoundError


def list_chunks(db: Database, project_id: str, document_id: str) -> list[dict]:
    """List persisted page chunks for a source document."""

    ensure_document_exists(db, project_id, document_id)
    with db.connect() as connection:
        rows = connection.execute(
            """
            SELECT *
            FROM document_chunks
            WHERE project_id = ? AND document_id = ?
            ORDER BY page_number, chunk_index
            """,
            (project_id, document_id),
        ).fetchall()
    return [chunk_from_row(row) for row in rows]


def get_source_chunks(db: Database, project_id: str, document_id: str) -> list[dict]:
    """Return chunks in the shape consumed by mock-exam draft generation."""

    return list_chunks(db, project_id, document_id)


def get_chunk(db: Database, project_id: str, document_id: str, chunk_id: str) -> dict:
    """Load a single source document chunk."""

    with db.connect() as connection:
        row = connection.execute(
            """
            SELECT *
            FROM document_chunks
            WHERE project_id = ? AND document_id = ? AND id = ?
            """,
            (project_id, document_id, chunk_id),
        ).fetchone()
    if row is None:
        raise NotFoundError("Document chunk not found.")
    return chunk_from_row(row)


def chunk_from_row(row: Row) -> dict:
    """Map a persisted chunk row into the API/domain dictionary shape."""

    return {
        "id": row["id"],
        "document_id": row["document_id"],
        "page_number": row["page_number"],
        "chunk_index": row["chunk_index"],
        "text": row["text"],
        "raw_text": row["raw_text"],
        "line_start": row["line_start"],
        "line_end": row["line_end"],
        "line_count": row["line_count"],
        "source_excerpt": row["source_excerpt"],
        "extraction_method": row["extraction_method"],
        "content_profile": row["content_profile"],
        "created_at": row["created_at"],
    }


def upsert_page_chunk(
    connection,
    *,
    project_id: str,
    document_id: str,
    page: ExtractedPage,
    chunk_index: int,
    now: str,
) -> None:
    """Insert or replace the canonical chunk for one extracted PDF page."""

    rows = connection.execute(
        """
        SELECT id
        FROM document_chunks
        WHERE project_id = ? AND document_id = ? AND page_number = ?
        ORDER BY chunk_index, created_at, id
        """,
        (project_id, document_id, page.page_number),
    ).fetchall()
    values = (
        chunk_index,
        page.text,
        _page_raw_text(page),
        _page_line_start(page),
        _page_line_end(page),
        _page_line_count(page),
        page.source_excerpt,
        page.extraction_method,
        content_profile_from_value(page.content_profile).value,
    )
    if rows:
        keep_id = rows[0]["id"]
        connection.execute(
            """
            UPDATE document_chunks
            SET chunk_index = ?,
                text = ?,
                raw_text = ?,
                line_start = ?,
                line_end = ?,
                line_count = ?,
                source_excerpt = ?,
                extraction_method = ?,
                content_profile = ?
            WHERE id = ?
            """,
            (*values, keep_id),
        )
        connection.executemany(
            "DELETE FROM document_chunks WHERE id = ?",
            [(row["id"],) for row in rows[1:]],
        )
        return

    connection.execute(
        """
        INSERT INTO document_chunks(
            id, project_id, document_id, page_number, chunk_index,
            text, raw_text, line_start, line_end, line_count, source_excerpt,
            extraction_method, content_profile, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(uuid4()),
            project_id,
            document_id,
            page.page_number,
            *values,
            now,
        ),
    )


def sync_document_chunks(
    connection,
    *,
    project_id: str,
    document_id: str,
    pages: tuple[ExtractedPage, ...],
    now: str,
) -> None:
    """Make persisted chunks match the final ordered extraction result."""

    pages_by_number = {page.page_number: page for page in pages}
    rows = connection.execute(
        """
        SELECT id, page_number
        FROM document_chunks
        WHERE project_id = ? AND document_id = ?
        ORDER BY page_number, chunk_index, created_at, id
        """,
        (project_id, document_id),
    ).fetchall()
    kept_page_numbers: set[int] = set()
    for row in rows:
        page_number = row["page_number"]
        if page_number in pages_by_number and page_number not in kept_page_numbers:
            kept_page_numbers.add(page_number)
            continue
        connection.execute("DELETE FROM document_chunks WHERE id = ?", (row["id"],))

    for chunk_index, page in enumerate(sorted(pages, key=lambda item: item.page_number)):
        upsert_page_chunk(
            connection,
            project_id=project_id,
            document_id=document_id,
            page=page,
            chunk_index=chunk_index,
            now=now,
        )


def _page_raw_text(page: ExtractedPage) -> str:
    return page.raw_text or page.text


def _page_line_start(page: ExtractedPage) -> int | None:
    if page.line_start is not None:
        return page.line_start
    return line_metadata(_page_raw_text(page)).line_start


def _page_line_end(page: ExtractedPage) -> int | None:
    if page.line_end is not None:
        return page.line_end
    return line_metadata(_page_raw_text(page)).line_end


def _page_line_count(page: ExtractedPage) -> int:
    if page.line_count:
        return page.line_count
    return line_metadata(_page_raw_text(page)).line_count
