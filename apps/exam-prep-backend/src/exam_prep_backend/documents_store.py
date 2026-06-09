from __future__ import annotations

from sqlite3 import Row
from uuid import uuid4

from exam_prep_backend.database import Database, utc_now
from exam_prep_backend.errors import NotFoundError
from exam_prep_backend.pdf_extraction import PdfExtractionResult
from exam_prep_backend.projects_store import ensure_project_exists


def create_document(
    db: Database,
    *,
    project_id: str,
    filename: str,
    sha256: str,
    storage_path: str,
    extraction: PdfExtractionResult,
) -> dict:
    ensure_project_exists(db, project_id)
    document_id = str(uuid4())
    now = utc_now()
    status = "ready" if extraction.has_text else "no_text_detected"
    with db.connect() as connection:
        connection.execute(
            """
            INSERT INTO documents(
                id, project_id, filename, sha256, storage_path, page_count,
                has_text, status, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                document_id,
                project_id,
                filename,
                sha256,
                storage_path,
                extraction.page_count,
                int(extraction.has_text),
                status,
                now,
            ),
        )
        for chunk_index, page in enumerate(extraction.pages):
            connection.execute(
                """
                INSERT INTO document_chunks(
                    id, project_id, document_id, page_number, chunk_index,
                    text, source_excerpt, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(uuid4()),
                    project_id,
                    document_id,
                    page.page_number,
                    chunk_index,
                    page.text,
                    page.source_excerpt,
                    now,
                ),
            )
        row = _document_query(connection, project_id, document_id)
    if row is None:
        raise NotFoundError("Document not found.")
    return _document_from_row(row)


def list_chunks(db: Database, project_id: str, document_id: str) -> list[dict]:
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
    return [_chunk_from_row(row) for row in rows]


def get_source_chunks(db: Database, project_id: str, document_id: str) -> list[dict]:
    return list_chunks(db, project_id, document_id)


def ensure_document_exists(db: Database, project_id: str, document_id: str) -> None:
    with db.connect() as connection:
        row = connection.execute(
            "SELECT id FROM documents WHERE project_id = ? AND id = ?",
            (project_id, document_id),
        ).fetchone()
    if row is None:
        raise NotFoundError("Document not found.")


def _document_query(connection, project_id: str, document_id: str) -> Row | None:
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


def _document_from_row(row: Row) -> dict:
    return {
        "id": row["id"],
        "project_id": row["project_id"],
        "filename": row["filename"],
        "sha256": row["sha256"],
        "storage_path": row["storage_path"],
        "page_count": row["page_count"],
        "has_text": bool(row["has_text"]),
        "status": row["status"],
        "chunks_count": row["chunks_count"],
        "created_at": row["created_at"],
    }


def _chunk_from_row(row: Row) -> dict:
    return {
        "id": row["id"],
        "document_id": row["document_id"],
        "page_number": row["page_number"],
        "chunk_index": row["chunk_index"],
        "text": row["text"],
        "source_excerpt": row["source_excerpt"],
        "created_at": row["created_at"],
    }
