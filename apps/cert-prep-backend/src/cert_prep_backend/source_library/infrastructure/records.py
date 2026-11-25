from __future__ import annotations

from sqlite3 import Row

from cert_prep_contracts.sources import SourceKind

from cert_prep_backend.platform.database import Database
from cert_prep_backend.platform.errors import NotFoundError
from cert_prep_backend.source_library.application.ports import StudyProjects
from cert_prep_backend.source_library.domain.source import Source
from cert_prep_backend.source_library.domain.statuses import SourceStatus


def source_query(connection, project_id: str, source_id: str) -> Row | None:
    """Load a source row with its current chunk count."""

    return connection.execute(
        """
        SELECT sources.*,
            COUNT(source_chunks.id) AS chunks_count
        FROM sources
        LEFT JOIN source_chunks ON source_chunks.source_id = sources.id
        WHERE sources.project_id = ? AND sources.id = ?
        GROUP BY sources.id
        """,
        (project_id, source_id),
    ).fetchone()


def source_from_row(row: Row) -> Source:
    """Map a persisted source row with its chunk count into a Source."""

    return Source(
        id=row["id"],
        project_id=row["project_id"],
        filename=row["filename"],
        sha256=row["sha256"],
        language_hint=row["language_hint"],
        page_count=row["page_count"],
        has_text=bool(row["has_text"]),
        status=SourceStatus(row["status"]),
        extraction_method=row["extraction_method"],
        ocr_device=row["ocr_device"],
        extraction_provenance=row["extraction_provenance"],
        extraction_warnings=row["extraction_warnings"],
        failure_message=row["failure_message"],
        processed_page_count=row["processed_page_count"],
        question_count=row["question_count"],
        content_profile=row["content_profile"],
        classification_detail=row["classification_detail"],
        chunks_count=row["chunks_count"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        source_kind=SourceKind(row["source_kind"]),
        duration_ms=row["duration_ms"],
        transcription_status=row["transcription_status"],
        translation_status=row["translation_status"],
        configured_transcription_model=row["configured_transcription_model"],
        effective_transcription_model=row["effective_transcription_model"],
        transcription_device=row["transcription_device"],
        transcription_warning=row["transcription_warning"],
    )


def ensure_source_exists(db: Database, project_id: str, source_id: str) -> None:
    """Raise when a source does not belong to the requested project."""

    with db.connect() as connection:
        row = connection.execute(
            "SELECT id FROM sources WHERE project_id = ? AND id = ?",
            (project_id, source_id),
        ).fetchone()
    if row is None:
        raise NotFoundError("Document not found.")


def ensure_project_exists(projects: StudyProjects, project_id: str) -> None:
    """Raise unless the project exists. Study Projects owns projects (D17), so this asks it."""

    if not projects.exists(project_id):
        raise NotFoundError("Project not found.")
