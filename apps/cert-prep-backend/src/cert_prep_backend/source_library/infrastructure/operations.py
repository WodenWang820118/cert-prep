"""Storage of document operations. The transition rules live on DocumentOperation; each
function loads the operation, lets the aggregate decide, and applies the result with an
update guarded by the state it was decided from."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from sqlite3 import Connection, Row
from uuid import uuid4

from cert_prep_contracts.transcription import TranscriptSegment

from cert_prep_backend.platform.database import Database, utc_now
from cert_prep_backend.platform.errors import (
    DocumentOperationStateError,
    DocumentProcessingCanceledError,
    NotFoundError,
)
from cert_prep_backend.source_library.domain.document import PdfExtractionResult, SourceDocument
from cert_prep_backend.source_library.domain.operation import (
    DocumentOperation,
    ensure_retry_allowed,
    failure_state,
    processing_to_cancel,
)
from cert_prep_backend.source_library.domain.statuses import (
    DocumentOperationPhase,
    DocumentOperationStatus,
)
from cert_prep_backend.source_library.infrastructure import chunks
from cert_prep_backend.source_library.infrastructure.documents import insert_processing_document
from cert_prep_backend.source_library.infrastructure.progress import (
    complete_document_extraction_in_transaction,
)
from cert_prep_backend.source_library.infrastructure.records import (
    document_from_row,
    document_query,
    ensure_project_exists,
)


@dataclass(frozen=True, slots=True)
class DocumentOperationClaim:
    operation: DocumentOperation
    acquired: bool


def claim_operation(
    db: Database,
    *,
    project_id: str,
    operation_id: str,
) -> DocumentOperationClaim:
    """Atomically claim a global upload operation id."""

    ensure_project_exists(db, project_id)
    claimed = DocumentOperation.claim_upload(
        operation_id=operation_id, project_id=project_id, now=utc_now()
    )
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        inserted = connection.execute(
            """
            INSERT INTO document_operations(
                id, project_id, document_id, status, phase, cancellable,
                error, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO NOTHING
            """,
            _operation_values(claimed),
        )
        operation = _required_operation(_operation_query_by_id(connection, operation_id))
        operation.ensure_belongs_to(project_id)
    return DocumentOperationClaim(operation=operation, acquired=inserted.rowcount == 1)


def cancel_operation(
    db: Database,
    *,
    project_id: str,
    operation_id: str,
) -> DocumentOperation:
    """Create a cancel tombstone or atomically request active-work cancellation."""

    ensure_project_exists(db, project_id)
    now = utc_now()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = _operation_query_by_id(connection, operation_id)
        if row is None:
            tombstone = DocumentOperation.canceled_before_start(
                operation_id=operation_id, project_id=project_id, now=now
            )
            connection.execute(
                """
                INSERT INTO document_operations(
                    id, project_id, document_id, status, phase, cancellable,
                    error, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                _operation_values(tombstone),
            )
            return _required_operation(_operation_query_by_id(connection, operation_id))
        return _cancel(connection, _operation_from_row(row), project_id=project_id, now=now)


def cancel_document_processing(
    db: Database,
    *,
    project_id: str,
    document_id: str,
) -> DocumentOperation:
    """Cancel the operation owning a document without a lookup/cancel race."""

    ensure_project_exists(db, project_id)
    now = utc_now()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        document = connection.execute(
            "SELECT status FROM documents WHERE project_id = ? AND id = ?",
            (project_id, document_id),
        ).fetchone()
        if document is None:
            raise NotFoundError("Document not found.")
        active = connection.execute(
            """
            SELECT *
            FROM document_operations
            WHERE project_id = ? AND document_id = ?
                AND status IN ('queued', 'running', 'cancel_requested')
            LIMIT 1
            """,
            (project_id, document_id),
        ).fetchone()
        last_canceled = None
        if active is None and document["status"] == "canceled":
            last_canceled = connection.execute(
                """
                SELECT *
                FROM document_operations
                WHERE project_id = ? AND document_id = ? AND status = 'canceled'
                ORDER BY updated_at DESC, created_at DESC, id DESC
                LIMIT 1
                """,
                (project_id, document_id),
            ).fetchone()
        operation = processing_to_cancel(
            active=None if active is None else _operation_from_row(active),
            document_status=document["status"],
            last_canceled=None if last_canceled is None else _operation_from_row(last_canceled),
        )
        if active is None:
            return operation
        return _cancel(connection, operation, project_id=project_id, now=now)


def create_and_attach_document(
    db: Database,
    *,
    project_id: str,
    operation_id: str,
    filename: str,
    sha256: str,
    language_hint: str,
    storage_path: str,
    page_count: int,
    document_id: str | None = None,
    source_kind: str = "document",
    duration_ms: int | None = None,
) -> SourceDocument:
    """Insert a document and attach it to the sole operation claimant atomically."""

    ensure_project_exists(db, project_id)
    now = utc_now()
    next_document_id = document_id or str(uuid4())
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        operation = _required_operation(_operation_query_by_id(connection, operation_id))
        operation.ensure_belongs_to(project_id)
        attached = operation.attach_document(next_document_id, now)
        document = insert_processing_document(
            connection,
            document_id=next_document_id,
            project_id=project_id,
            filename=filename,
            sha256=sha256,
            language_hint=language_hint,
            storage_path=storage_path,
            page_count=page_count,
            now=now,
            source_kind=source_kind,
            duration_ms=duration_ms,
        )
        _apply(
            connection,
            operation,
            attached,
            "Document operation could not attach its processing document.",
        )
    return document


def mark_capture_review_pending(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    operation_id: str,
) -> DocumentOperation:
    """Leave an uploaded capture cancellable while the user reviews OCR."""

    now = utc_now()
    failure = "Document operation could not enter capture review."
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = _operation_query_by_id(connection, operation_id)
        if row is None or row["project_id"] != project_id:
            raise DocumentOperationStateError(failure)
        operation = _operation_from_row(row)
        _apply(connection, operation, operation.enter_review(document_id, now), failure)
        return _required_operation(_operation_query_by_id(connection, operation_id))


def begin_capture_review_commit(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    operation_id: str,
) -> DocumentOperation:
    """Atomically claim the pending capture for the confirmation worker."""

    now = utc_now()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        return begin_capture_review_commit_in_connection(
            connection,
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
            now=now,
        )


def begin_capture_review_commit_in_connection(
    connection: Connection,
    *,
    project_id: str,
    document_id: str,
    operation_id: str,
    now: str | None = None,
) -> DocumentOperation:
    """Transition review work inside the caller's enclosing transaction."""

    operation = _required_operation(_operation_query_by_id(connection, operation_id))
    operation.ensure_belongs_to(project_id)
    confirmed = operation.begin_review_confirmation(document_id, now or utc_now())
    _apply(
        connection,
        operation,
        confirmed,
        "Capture review confirmation is already running or completed.",
    )
    return _required_operation(_operation_query_by_id(connection, operation_id))


def _begin_commit(
    connection: Connection,
    *,
    project_id: str,
    operation_id: str,
    document_id: str,
    now: str,
) -> DocumentOperation:
    """Win cancel-vs-complete inside the caller's uncommitted publication transaction."""

    operation = _required_operation(_operation_query_by_id(connection, operation_id))
    operation.ensure_belongs_to(project_id)
    committing = operation.begin_commit(document_id, now)
    _apply(
        connection,
        operation,
        committing,
        "Document operation was not in its cancellable processing phase.",
    )
    return committing


def publish_success(
    db: Database,
    *,
    project_id: str,
    operation_id: str,
    document_id: str,
    extraction: PdfExtractionResult,
) -> SourceDocument:
    """Atomically publish final extraction data and terminal operation success."""

    now = utc_now()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        operation = _required_operation(_operation_query_by_id(connection, operation_id))
        operation.ensure_belongs_to(project_id)
        if operation.already_published(document_id, results="extraction results"):
            return _document(connection, project_id, document_id)
        committing = _begin_commit(
            connection,
            project_id=project_id,
            operation_id=operation_id,
            document_id=document_id,
            now=now,
        )
        document = complete_document_extraction_in_transaction(
            connection,
            project_id=project_id,
            document_id=document_id,
            extraction=extraction,
            now=now,
        )
        _apply(
            connection,
            committing,
            committing.succeed(now),
            "Document operation success could not be committed.",
        )
    return document


def publish_capture_audio_success(
    db: Database,
    *,
    project_id: str,
    operation_id: str,
    document_id: str,
    segments: Sequence[tuple[TranscriptSegment, str]],
    model: str,
    device: str | None,
    warning: str | None,
) -> SourceDocument:
    """Atomically publish validated Capture Runtime transcript and translations."""

    if not segments:
        raise ValueError("A completed audio capture must contain at least one segment")
    now = utc_now()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        operation = _required_operation(_operation_query_by_id(connection, operation_id))
        operation.ensure_belongs_to(project_id)
        if operation.already_published(document_id, results="capture results"):
            return _document(connection, project_id, document_id)
        committing = _begin_commit(
            connection,
            project_id=project_id,
            operation_id=operation_id,
            document_id=document_id,
            now=now,
        )

        chunks.delete_audio_segments(
            connection,
            project_id=project_id,
            document_id=document_id,
        )
        for index, (segment, target_text) in enumerate(segments):
            chunks.insert_audio_segment(
                connection,
                project_id=project_id,
                document_id=document_id,
                chunk_index=index,
                segment=segment,
                now=now,
            )
            translated = connection.execute(
                """
                UPDATE document_chunks
                SET translated_text = ?, translation_source_revision = source_revision
                WHERE project_id = ? AND document_id = ?
                    AND locator_kind = 'time' AND chunk_index = ?
                """,
                (target_text, project_id, document_id, index),
            )
            if translated.rowcount != 1:
                raise DocumentOperationStateError(
                    "Capture audio translation could not be persisted."
                )

        duration_ms = max(segment.end_ms for segment, _target in segments)
        updated = connection.execute(
            """
            UPDATE documents
            SET duration_ms = ?, has_text = 1, status = 'ready',
                extraction_method = 'transcription', processed_page_count = ?,
                transcription_status = 'succeeded', translation_status = 'succeeded',
                configured_transcription_model = ?, effective_transcription_model = ?,
                transcription_device = ?, transcription_warning = ?,
                content_profile = 'study_material', classification_detail = '',
                updated_at = ?
            WHERE project_id = ? AND id = ? AND status = 'processing'
            """,
            (
                duration_ms,
                len(segments),
                model,
                model,
                device,
                warning,
                now,
                project_id,
                document_id,
            ),
        )
        if updated.rowcount != 1:
            raise DocumentProcessingCanceledError(
                "Document processing was canceled before capture publication."
            )
        _apply(
            connection,
            committing,
            committing.succeed(now),
            "Capture audio operation success could not be committed.",
        )
        return _document(connection, project_id, document_id)


def acknowledge_cancellation(
    db: Database,
    *,
    project_id: str,
    operation_id: str,
) -> DocumentOperation:
    now = utc_now()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        operation = _required_operation(_operation_query_by_id(connection, operation_id))
        operation.ensure_belongs_to(project_id)
        canceled = operation.acknowledge_cancellation(now)
        if canceled is operation:
            return operation
        _record_stopped_document(connection, canceled, now=now)
        _apply(
            connection,
            operation,
            canceled,
            "Document operation cancellation could not be acknowledged.",
        )
        return _required_operation(_operation_query_by_id(connection, operation_id))


def finish_failed(
    db: Database,
    *,
    project_id: str,
    operation_id: str,
    error: str,
    document_status: str | None = None,
    extraction_method: str | None = None,
) -> DocumentOperation:
    now = utc_now()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        operation = _required_operation(_operation_query_by_id(connection, operation_id))
        operation.ensure_belongs_to(project_id)
        stopped = operation.fail(error, now)
        if stopped is operation:
            return operation
        _record_stopped_document(
            connection,
            stopped,
            document_status=document_status,
            extraction_method=extraction_method,
            now=now,
        )
        _apply(connection, operation, stopped, "Document operation could not be stopped.")
        return _required_operation(_operation_query_by_id(connection, operation_id))


def start_retry_operation(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    operation_id: str | None = None,
) -> DocumentOperation:
    """Reset retryable parsing state and create its linked running operation atomically."""

    ensure_project_exists(db, project_id)
    next_operation_id = operation_id or str(uuid4())
    now = utc_now()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        existing = _operation_query_by_id(connection, next_operation_id)
        if existing is not None:
            _operation_from_row(existing).refuse_reuse_for_retry(project_id)
        document = document_query(connection, project_id, document_id)
        if document is None:
            raise NotFoundError("Document not found.")
        active = connection.execute(
            """
            SELECT id
            FROM document_operations
            WHERE project_id = ? AND document_id = ?
                AND status IN ('queued', 'running', 'cancel_requested')
            LIMIT 1
            """,
            (project_id, document_id),
        ).fetchone()
        ensure_retry_allowed(
            has_active_operation=active is not None,
            document_status=document["status"],
        )
        _reset_document_derived_state(
            connection,
            project_id=project_id,
            document_id=document_id,
            status="processing",
            extraction_method="none",
            fallback_reason=None,
            now=now,
        )
        connection.execute(
            """
            UPDATE documents
            SET duration_ms = NULL, transcription_status = 'pending',
                translation_status = 'pending', configured_transcription_model = NULL,
                effective_transcription_model = NULL, transcription_device = NULL,
                transcription_warning = NULL
            WHERE project_id = ? AND id = ? AND source_kind = 'audio'
            """,
            (project_id, document_id),
        )
        retry = DocumentOperation.start_retry(
            operation_id=next_operation_id,
            project_id=project_id,
            document_id=document_id,
            now=now,
        )
        connection.execute(
            """
            INSERT INTO document_operations(
                id, project_id, document_id, status, phase, cancellable,
                error, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            _operation_values(retry),
        )
        return _required_operation(_operation_query_by_id(connection, next_operation_id))


def recover_operations(db: Database) -> int:
    """Fail interrupted work while honoring durable user cancellation."""

    with db.connect() as connection:
        rows = connection.execute(
            """
            SELECT id, project_id, status
            FROM document_operations
            WHERE status IN ('queued', 'running', 'cancel_requested')
            ORDER BY created_at, id
            """
        ).fetchall()
    for row in rows:
        if row["status"] == "cancel_requested":
            acknowledge_cancellation(
                db,
                project_id=str(row["project_id"]),
                operation_id=str(row["id"]),
            )
        else:
            finish_failed(
                db,
                project_id=str(row["project_id"]),
                operation_id=str(row["id"]),
                error="Document processing was interrupted by an app restart.",
            )
    return len(rows)



def get_operation(
    db: Database,
    *,
    project_id: str,
    operation_id: str,
) -> DocumentOperation:
    with db.connect() as connection:
        row = connection.execute(
            "SELECT * FROM document_operations WHERE id = ? AND project_id = ?",
            (operation_id, project_id),
        ).fetchone()
    if row is None:
        raise NotFoundError("Document operation not found.")
    return _operation_from_row(row)



def get_active_operation_for_document(
    db: Database,
    *,
    project_id: str,
    document_id: str,
) -> DocumentOperation | None:
    with db.connect() as connection:
        row = connection.execute(
            """
            SELECT * FROM document_operations
            WHERE project_id = ? AND document_id = ?
              AND status IN ('queued', 'running', 'cancel_requested')
            ORDER BY updated_at DESC, id DESC
            LIMIT 1
            """,
            (project_id, document_id),
        ).fetchone()
    return None if row is None else _operation_from_row(row)



def _apply(
    connection: Connection,
    before: DocumentOperation,
    after: DocumentOperation,
    failure_message: str,
) -> None:
    """Store a transition only if the operation is still in the state it was decided from."""

    updated = connection.execute(
        """
        UPDATE document_operations
        SET document_id = ?, status = ?, phase = ?, cancellable = ?, error = ?, updated_at = ?
        WHERE id = ? AND project_id = ? AND status = ? AND phase = ? AND cancellable = ?
            AND document_id IS ?
        """,
        (
            after.document_id,
            after.status.value,
            after.phase.value,
            int(after.cancellable),
            after.error,
            after.updated_at,
            before.id,
            before.project_id,
            before.status.value,
            before.phase.value,
            int(before.cancellable),
            before.document_id,
        ),
    )
    if updated.rowcount != 1:
        raise DocumentOperationStateError(failure_message)


def _cancel(
    connection: Connection,
    operation: DocumentOperation,
    *,
    project_id: str,
    now: str,
) -> DocumentOperation:
    operation.ensure_belongs_to(project_id)
    requested = operation.cancel(now)
    if requested is operation:
        return operation
    _apply(
        connection,
        operation,
        requested,
        "Document operation changed while cancellation was requested.",
    )
    if (
        requested.status is DocumentOperationStatus.CANCEL_REQUESTED
        and requested.document_id is not None
    ):
        connection.execute(
            """
            UPDATE documents
            SET status = 'cancel_requested', updated_at = ?
            WHERE project_id = ? AND id = ? AND status = 'processing'
            """,
            (now, project_id, requested.document_id),
        )
    return _required_operation(_operation_query_by_id(connection, operation.id))


def _record_stopped_document(
    connection: Connection,
    stopped: DocumentOperation,
    *,
    document_status: str | None = None,
    extraction_method: str | None = None,
    now: str,
) -> None:
    """Leave the stopped run's document retryable; audio keeps the transcript it already has."""

    if stopped.document_id is None:
        return
    project_id = stopped.project_id
    document_id = str(stopped.document_id)
    document = document_query(connection, project_id, document_id)
    if document is None:
        raise NotFoundError("Document not found.")
    if document["source_kind"] == "audio":
        preserve = (
            _preserve_canceled_audio_state
            if stopped.status is DocumentOperationStatus.CANCELED
            else _preserve_failed_audio_state
        )
        preserve(connection, project_id=project_id, document_id=document_id, now=now)
        return
    state = failure_state(
        stopped,
        document_status=document_status,
        extraction_method=extraction_method,
        page_count=int(document["page_count"] or 0),
    )
    _reset_document_derived_state(
        connection,
        project_id=project_id,
        document_id=document_id,
        status=state.status,
        extraction_method=state.extraction_method,
        fallback_reason=state.fallback_reason,
        processed_page_count=state.processed_page_count,
        now=now,
    )


def _document(connection: Connection, project_id: str, document_id: str) -> SourceDocument:
    row = document_query(connection, project_id, document_id)
    if row is None:
        raise NotFoundError("Document not found.")
    return document_from_row(row)


def _operation_values(
    operation: DocumentOperation,
) -> tuple[str, str, str | None, str, str, int, str | None, str, str]:
    return (
        operation.id,
        operation.project_id,
        operation.document_id,
        operation.status.value,
        operation.phase.value,
        int(operation.cancellable),
        operation.error,
        operation.created_at,
        operation.updated_at,
    )


def _reset_document_derived_state(
    connection: Connection,
    *,
    project_id: str,
    document_id: str,
    status: str,
    extraction_method: str,
    fallback_reason: str | None,
    processed_page_count: int = 0,
    now: str,
) -> None:
    connection.execute(
        """
        DELETE FROM draft_generation_jobs
        WHERE project_id = ? AND document_id = ?
            AND status IN ('pending', 'running', 'cancel_requested')
        """,
        (project_id, document_id),
    )
    connection.execute(
        "DELETE FROM document_chunks WHERE project_id = ? AND document_id = ?",
        (project_id, document_id),
    )
    updated = connection.execute(
        """
        UPDATE documents
        SET status = ?, has_text = 0, extraction_method = ?,
            ocr_device = NULL, ocr_fallback_reason = ?, ocr_duration_ms = 0,
            processed_page_count = ?, parse_wall_duration_ms = 0,
            render_duration_ms = 0, ocr_engine_duration_ms = 0,
            ocr_worker_count = 0, first_chunk_ms = 0, exam_item_count = 0,
            content_profile = 'unknown', classification_detail = '',
            updated_at = ?
        WHERE project_id = ? AND id = ?
        """,
        (
            status,
            extraction_method,
            fallback_reason,
            processed_page_count,
            now,
            project_id,
            document_id,
        ),
    )
    if updated.rowcount != 1:
        raise NotFoundError("Document not found.")



def _operation_query_by_id(connection: Connection, operation_id: str) -> Row | None:
    return connection.execute(
        "SELECT * FROM document_operations WHERE id = ?",
        (operation_id,),
    ).fetchone()



def _preserve_canceled_audio_state(
    connection: Connection,
    *,
    project_id: str,
    document_id: str,
    now: str,
) -> None:
    connection.execute(
        """
        DELETE FROM draft_generation_jobs
        WHERE project_id = ? AND document_id = ?
            AND status IN ('pending', 'running', 'cancel_requested')
        """,
        (project_id, document_id),
    )
    chunks_count = connection.execute(
        """
        SELECT COUNT(*) FROM document_chunks
        WHERE project_id = ? AND document_id = ? AND locator_kind = 'time'
        """,
        (project_id, document_id),
    ).fetchone()[0]
    updated = connection.execute(
        """
        UPDATE documents
        SET status = ?, has_text = ?, extraction_method = ?,
            ocr_device = NULL, ocr_fallback_reason = NULL, ocr_duration_ms = 0,
            processed_page_count = ?, parse_wall_duration_ms = 0,
            render_duration_ms = 0, ocr_engine_duration_ms = 0,
            ocr_worker_count = 0, first_chunk_ms = 0, exam_item_count = 0,
            content_profile = ?, classification_detail = '',
            transcription_status = CASE
                WHEN transcription_status = 'succeeded' THEN 'succeeded'
                ELSE 'canceled'
            END,
            translation_status = CASE
                WHEN translation_status = 'succeeded' THEN 'succeeded'
                ELSE 'canceled'
            END,
            updated_at = ?
        WHERE project_id = ? AND id = ? AND source_kind = 'audio'
        """,
        (
            "canceled",
            int(chunks_count > 0),
            "transcription" if chunks_count > 0 else "none",
            chunks_count,
            "study_material" if chunks_count > 0 else "unknown",
            now,
            project_id,
            document_id,
        ),
    )
    if updated.rowcount != 1:
        raise NotFoundError("Audio document not found.")



def _preserve_failed_audio_state(
    connection: Connection,
    *,
    project_id: str,
    document_id: str,
    now: str,
) -> None:
    """Keep incremental transcript data while making an audio failure retryable."""

    connection.execute(
        """
        DELETE FROM draft_generation_jobs
        WHERE project_id = ? AND document_id = ?
            AND status IN ('pending', 'running', 'cancel_requested')
        """,
        (project_id, document_id),
    )
    chunks_count = connection.execute(
        """
        SELECT COUNT(*) FROM document_chunks
        WHERE project_id = ? AND document_id = ? AND locator_kind = 'time'
        """,
        (project_id, document_id),
    ).fetchone()[0]
    updated = connection.execute(
        """
        UPDATE documents
        SET status = CASE
                WHEN transcription_status = 'succeeded' THEN 'ready'
                ELSE 'transcription_failed'
            END,
            has_text = ?, extraction_method = ?,
            ocr_device = NULL, ocr_fallback_reason = NULL, ocr_duration_ms = 0,
            processed_page_count = ?, parse_wall_duration_ms = 0,
            render_duration_ms = 0, ocr_engine_duration_ms = 0,
            ocr_worker_count = 0, first_chunk_ms = 0, exam_item_count = 0,
            content_profile = ?, classification_detail = '',
            transcription_status = CASE
                WHEN transcription_status = 'succeeded' THEN 'succeeded'
                ELSE 'failed'
            END,
            translation_status = 'failed', updated_at = ?
        WHERE project_id = ? AND id = ? AND source_kind = 'audio'
        """,
        (
            int(chunks_count > 0),
            "transcription" if chunks_count > 0 else "none",
            chunks_count,
            "study_material" if chunks_count > 0 else "unknown",
            now,
            project_id,
            document_id,
        ),
    )
    if updated.rowcount != 1:
        raise NotFoundError("Audio document not found.")



def _required_operation(row: Row | None) -> DocumentOperation:
    if row is None:
        raise NotFoundError("Document operation not found.")
    return _operation_from_row(row)



def _operation_from_row(row: Row) -> DocumentOperation:
    return DocumentOperation(
        id=row["id"],
        project_id=row["project_id"],
        document_id=row["document_id"],
        status=DocumentOperationStatus(row["status"]),
        phase=DocumentOperationPhase(row["phase"]),
        cancellable=bool(row["cancellable"]),
        error=row["error"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )



__all__ = [
    "DocumentOperationClaim",
    "acknowledge_cancellation",
    "cancel_document_processing",
    "cancel_operation",
    "claim_operation",
    "create_and_attach_document",
    "finish_failed",
    "get_operation",
    "publish_success",
    "recover_operations",
    "start_retry_operation",
]

