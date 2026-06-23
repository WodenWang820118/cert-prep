from __future__ import annotations

from sqlite3 import Row

from cert_prep_backend.database import Database
from cert_prep_backend.errors import NotFoundError


def document_query(connection, project_id: str, document_id: str) -> Row | None:
    """Load a document row with its current chunk count."""

    return connection.execute(
        """
        SELECT documents.*,
            COUNT(document_chunks.id) AS chunks_count
        FROM documents
        LEFT JOIN document_chunks ON document_chunks.document_id = documents.id
        WHERE documents.project_id = ? AND documents.id = ?
        GROUP BY documents.id
        """,
        (project_id, document_id),
    ).fetchone()


def document_from_row(row: Row) -> dict:
    """Map a persisted document row into the API/domain dictionary shape."""

    return {
        "id": row["id"],
        "project_id": row["project_id"],
        "filename": row["filename"],
        "sha256": row["sha256"],
        "language_hint": row["language_hint"],
        "page_count": row["page_count"],
        "has_text": bool(row["has_text"]),
        "status": row["status"],
        "extraction_method": row["extraction_method"],
        "ocr_device": row["ocr_device"],
        "ocr_fallback_reason": row["ocr_fallback_reason"],
        "ocr_duration_ms": row["ocr_duration_ms"],
        "processed_page_count": row["processed_page_count"],
        "parse_wall_duration_ms": row["parse_wall_duration_ms"],
        "render_duration_ms": row["render_duration_ms"],
        "ocr_engine_duration_ms": row["ocr_engine_duration_ms"],
        "ocr_worker_count": row["ocr_worker_count"],
        "first_chunk_ms": row["first_chunk_ms"],
        "exam_item_count": row["exam_item_count"],
        "content_profile": row["content_profile"],
        "classification_detail": row["classification_detail"],
        "chunks_count": row["chunks_count"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def ensure_document_exists(db: Database, project_id: str, document_id: str) -> None:
    """Raise when a document does not belong to the requested project."""

    with db.connect() as connection:
        row = connection.execute(
            "SELECT id FROM documents WHERE project_id = ? AND id = ?",
            (project_id, document_id),
        ).fetchone()
    if row is None:
        raise NotFoundError("Document not found.")
