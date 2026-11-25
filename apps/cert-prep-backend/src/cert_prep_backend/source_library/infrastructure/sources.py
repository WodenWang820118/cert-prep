from __future__ import annotations

from sqlite3 import Connection

from cert_prep_contracts.sources import SourceKind

from cert_prep_backend.platform.database import Database, utc_now
from cert_prep_backend.source_library.domain.source import (
    NO_TEXT_DETECTED_MESSAGE,
    Source,
    SourceFile,
)
from cert_prep_backend.source_library.infrastructure.records import (
    source_from_row,
    source_query,
)
from cert_prep_backend.source_library.domain.statuses import SourceStatus
from cert_prep_backend.platform.errors import NotFoundError


def insert_processing_source(
    connection,
    *,
    source_id: str,
    project_id: str,
    filename: str,
    sha256: str,
    language_hint: str,
    storage_path: str,
    page_count: int,
    now: str,
    source_kind: SourceKind,
    duration_ms: int | None = None,
) -> Source:
    """Insert processing metadata using the caller's transaction."""

    connection.execute(
        """
        INSERT INTO sources(
            id, project_id, filename, sha256, storage_path, page_count,
            has_text, status, extraction_method, language_hint,
            content_profile, classification_detail, created_at, updated_at, source_kind,
            duration_ms,
            transcription_status, translation_status
        )
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'none', ?,
            'unknown', '', ?, ?, ?, ?,
            CASE WHEN ? = 'recording' THEN 'pending' ELSE 'not_applicable' END,
            CASE WHEN ? = 'recording' THEN 'pending' ELSE 'not_applicable' END)
        """,
        (
            source_id,
            project_id,
            filename,
            sha256,
            storage_path,
            page_count,
            SourceStatus.PROCESSING,
            language_hint,
            now,
            now,
            source_kind,
            duration_ms,
            source_kind,
            source_kind,
        ),
    )
    row = source_query(connection, project_id, source_id)
    if row is None:
        raise NotFoundError("Document not found.")
    return source_from_row(row)


def list_sources(db: Database, project_id: str) -> list[Source]:
    """List sources for a project in newest-first order."""

    with db.connect() as connection:
        rows = connection.execute(
            """
            SELECT sources.*,
                COUNT(source_chunks.id) AS chunks_count
            FROM sources
            LEFT JOIN source_chunks ON source_chunks.source_id = sources.id
            WHERE sources.project_id = ?
            GROUP BY sources.id
            ORDER BY sources.created_at DESC
            """,
            (project_id,),
        ).fetchall()
    return [source_from_row(row) for row in rows]


def get_source(db: Database, project_id: str, source_id: str) -> Source:
    """Load a source by project and source id."""

    with db.connect() as connection:
        row = source_query(connection, project_id, source_id)
    if row is None:
        raise NotFoundError("Document not found.")
    return source_from_row(row)


def get_source_file(db: Database, project_id: str, source_id: str) -> SourceFile:
    """Load private source-file metadata used by retry processing."""

    with db.connect() as connection:
        row = connection.execute(
            """
            SELECT filename, sha256, storage_path
            FROM sources
            WHERE project_id = ? AND id = ?
            """,
            (project_id, source_id),
        ).fetchone()
    if row is None:
        raise NotFoundError("Document not found.")
    return SourceFile(
        filename=str(row["filename"]),
        sha256=str(row["sha256"]),
        storage_path=str(row["storage_path"]),
    )


def update_question_count(
    db: Database,
    *,
    project_id: str,
    source_id: str,
    status: str,
    question_count: int,
) -> Source:
    """Update question generation state on a source."""

    with db.connect() as connection:
        set_question_count(
            connection,
            project_id=project_id,
            source_id=source_id,
            status=status,
            question_count=question_count,
        )
        row = source_query(connection, project_id, source_id)
    if row is None:
        raise NotFoundError("Document not found.")
    return source_from_row(row)


def set_question_count(
    connection: Connection,
    *,
    project_id: str,
    source_id: str,
    status: str,
    question_count: int,
) -> None:
    """Store the source's status and question count using the caller's transaction.

    A ready source has no failure message. A source that becomes no_text_detected gets
    Source Library's no-text reason; one that already was keeps the reason it has. Extraction
    warnings stay as they are."""

    connection.execute(
        """
        UPDATE sources
        SET status = :status, question_count = :question_count,
            failure_message = CASE
                WHEN :status = 'ready' THEN NULL
                WHEN :status = 'no_text_detected' AND status = 'no_text_detected'
                    THEN COALESCE(failure_message, :no_text_reason)
                WHEN :status = 'no_text_detected' THEN :no_text_reason
                ELSE failure_message
            END,
            updated_at = :updated_at
        WHERE project_id = :project_id AND id = :source_id
        """,
        {
            "status": status,
            "question_count": question_count,
            "no_text_reason": NO_TEXT_DETECTED_MESSAGE,
            "updated_at": utc_now(),
            "project_id": project_id,
            "source_id": source_id,
        },
    )


def set_authored_question_count(
    connection: Connection,
    *,
    project_id: str,
    source_id: str,
    question_count: int,
) -> None:
    """Store the count only; status, failure message and `updated_at` stay.

    A hand-written question changes how many questions the source has, and nothing else
    about the source.
    """

    connection.execute(
        """
        UPDATE sources
        SET question_count = :question_count
        WHERE project_id = :project_id AND id = :source_id
        """,
        {
            "question_count": question_count,
            "project_id": project_id,
            "source_id": source_id,
        },
    )
