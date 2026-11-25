"""Storage of source operations. The transition rules live on SourceOperation; each
function loads the operation, lets the aggregate decide, and applies the result with an
update guarded by the state it was decided from.

Stopping or retrying a run discards the source's unfinished question generation jobs. Question
Authoring owns those jobs, so the functions that do it take `question_jobs`, which binds that
context's jobs to the run's connection: the jobs go in the run's transaction. The repositories
check that the project exists before they call these functions.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from sqlite3 import Connection, Row
from uuid import uuid4

from cert_prep_contracts.sources import SourceKind
from cert_prep_contracts.transcription import TranscriptSegment

from cert_prep_backend.platform.database import Database, utc_now
from cert_prep_backend.platform.errors import (
    SourceOperationStateError,
    SourceProcessingCanceledError,
    NotFoundError,
)
from cert_prep_backend.source_library.application.ports import SourceQuestionJobs
from cert_prep_backend.source_library.domain.source import PageExtraction, Source
from cert_prep_backend.source_library.domain.operation import (
    SourceOperation,
    ensure_retry_allowed,
    failure_state,
    processing_to_cancel,
)
from cert_prep_backend.source_library.domain.statuses import (
    SourceOperationPhase,
    SourceOperationStatus,
)
from cert_prep_backend.source_library.infrastructure import chunks
from cert_prep_backend.source_library.infrastructure.sources import insert_processing_source
from cert_prep_backend.source_library.infrastructure.progress import (
    complete_source_extraction_in_transaction,
)
from cert_prep_backend.source_library.infrastructure.records import (
    source_from_row,
    source_query,
)

BindQuestionJobs = Callable[[Connection], SourceQuestionJobs]
"""Question Authoring's question jobs on the given connection, so they join its transaction."""


@dataclass(frozen=True, slots=True)
class SourceOperationClaim:
    operation: SourceOperation
    acquired: bool


def claim_operation(
    db: Database,
    *,
    project_id: str,
    operation_id: str,
) -> SourceOperationClaim:
    """Atomically claim a global upload operation id."""

    claimed = SourceOperation.claim_upload(
        operation_id=operation_id, project_id=project_id, now=utc_now()
    )
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        inserted = connection.execute(
            """
            INSERT INTO source_operations(
                id, project_id, source_id, status, phase, cancellable,
                error, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO NOTHING
            """,
            _operation_values(claimed),
        )
        operation = _required_operation(_operation_query_by_id(connection, operation_id))
        operation.ensure_belongs_to(project_id)
    return SourceOperationClaim(operation=operation, acquired=inserted.rowcount == 1)


def cancel_operation(
    db: Database,
    *,
    project_id: str,
    operation_id: str,
) -> SourceOperation:
    """Create a cancel tombstone or atomically request active-work cancellation."""

    now = utc_now()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = _operation_query_by_id(connection, operation_id)
        if row is None:
            tombstone = SourceOperation.canceled_before_start(
                operation_id=operation_id, project_id=project_id, now=now
            )
            connection.execute(
                """
                INSERT INTO source_operations(
                    id, project_id, source_id, status, phase, cancellable,
                    error, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                _operation_values(tombstone),
            )
            return _required_operation(_operation_query_by_id(connection, operation_id))
        return _cancel(connection, _operation_from_row(row), project_id=project_id, now=now)


def cancel_source_processing(
    db: Database,
    *,
    project_id: str,
    source_id: str,
) -> SourceOperation:
    """Cancel the operation owning a source without a lookup/cancel race."""

    now = utc_now()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        source = connection.execute(
            "SELECT status FROM sources WHERE project_id = ? AND id = ?",
            (project_id, source_id),
        ).fetchone()
        if source is None:
            raise NotFoundError("Document not found.")
        active = connection.execute(
            """
            SELECT *
            FROM source_operations
            WHERE project_id = ? AND source_id = ?
                AND status IN ('queued', 'running', 'cancel_requested')
            LIMIT 1
            """,
            (project_id, source_id),
        ).fetchone()
        last_canceled = None
        if active is None and source["status"] == "canceled":
            last_canceled = connection.execute(
                """
                SELECT *
                FROM source_operations
                WHERE project_id = ? AND source_id = ? AND status = 'canceled'
                ORDER BY updated_at DESC, created_at DESC, id DESC
                LIMIT 1
                """,
                (project_id, source_id),
            ).fetchone()
        operation = processing_to_cancel(
            active=None if active is None else _operation_from_row(active),
            source_status=source["status"],
            last_canceled=None if last_canceled is None else _operation_from_row(last_canceled),
        )
        if active is None:
            return operation
        return _cancel(connection, operation, project_id=project_id, now=now)


def create_and_attach_source(
    db: Database,
    *,
    project_id: str,
    operation_id: str,
    filename: str,
    sha256: str,
    language_hint: str,
    storage_path: str,
    page_count: int,
    source_id: str | None = None,
    source_kind: SourceKind,
    duration_ms: int | None = None,
) -> Source:
    """Insert a source and attach it to the sole operation claimant atomically."""

    now = utc_now()
    next_source_id = source_id or str(uuid4())
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        operation = _required_operation(_operation_query_by_id(connection, operation_id))
        operation.ensure_belongs_to(project_id)
        attached = operation.attach_source(next_source_id, now)
        source = insert_processing_source(
            connection,
            source_id=next_source_id,
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
    return source


def mark_capture_review_pending(
    db: Database,
    *,
    project_id: str,
    source_id: str,
    operation_id: str,
) -> SourceOperation:
    """Leave an uploaded capture cancellable while the user reviews OCR."""

    now = utc_now()
    failure = "Document operation could not enter capture review."
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = _operation_query_by_id(connection, operation_id)
        if row is None or row["project_id"] != project_id:
            raise SourceOperationStateError(failure)
        operation = _operation_from_row(row)
        _apply(connection, operation, operation.enter_review(source_id, now), failure)
        return _required_operation(_operation_query_by_id(connection, operation_id))


def begin_capture_review_commit_in_connection(
    connection: Connection,
    *,
    project_id: str,
    source_id: str,
    operation_id: str,
    now: str | None = None,
) -> SourceOperation:
    """Transition review work inside the caller's enclosing transaction."""

    operation = _required_operation(_operation_query_by_id(connection, operation_id))
    operation.ensure_belongs_to(project_id)
    confirmed = operation.begin_review_confirmation(source_id, now or utc_now())
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
    source_id: str,
    now: str,
) -> SourceOperation:
    """Win cancel-vs-complete inside the caller's uncommitted publication transaction."""

    operation = _required_operation(_operation_query_by_id(connection, operation_id))
    operation.ensure_belongs_to(project_id)
    committing = operation.begin_commit(source_id, now)
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
    source_id: str,
    extraction: PageExtraction,
    extraction_provenance: str | None = None,
) -> Source:
    """Atomically publish final extraction data and terminal operation success."""

    now = utc_now()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        operation = _required_operation(_operation_query_by_id(connection, operation_id))
        operation.ensure_belongs_to(project_id)
        if operation.already_published(source_id, results="extraction results"):
            return _source(connection, project_id, source_id)
        committing = _begin_commit(
            connection,
            project_id=project_id,
            operation_id=operation_id,
            source_id=source_id,
            now=now,
        )
        source = complete_source_extraction_in_transaction(
            connection,
            project_id=project_id,
            source_id=source_id,
            extraction=extraction,
            now=now,
            extraction_provenance=extraction_provenance,
        )
        _apply(
            connection,
            committing,
            committing.succeed(now),
            "Document operation success could not be committed.",
        )
    return source


def publish_capture_audio_success(
    db: Database,
    *,
    project_id: str,
    operation_id: str,
    source_id: str,
    segments: Sequence[tuple[TranscriptSegment, str]],
    model: str,
    device: str | None,
    warning: str | None,
    extraction_provenance: str | None = None,
) -> Source:
    """Atomically publish validated Capture Runtime transcript and translations."""

    if not segments:
        raise ValueError("A completed audio capture must contain at least one segment")
    now = utc_now()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        operation = _required_operation(_operation_query_by_id(connection, operation_id))
        operation.ensure_belongs_to(project_id)
        if operation.already_published(source_id, results="capture results"):
            return _source(connection, project_id, source_id)
        committing = _begin_commit(
            connection,
            project_id=project_id,
            operation_id=operation_id,
            source_id=source_id,
            now=now,
        )

        chunks.delete_audio_segments(
            connection,
            project_id=project_id,
            source_id=source_id,
        )
        for index, (segment, target_text) in enumerate(segments):
            chunks.insert_audio_segment(
                connection,
                project_id=project_id,
                source_id=source_id,
                chunk_index=index,
                segment=segment,
                now=now,
            )
            translated = connection.execute(
                """
                UPDATE source_chunks
                SET translated_text = ?, translation_source_revision = source_revision
                WHERE project_id = ? AND source_id = ?
                    AND locator_kind = 'time' AND chunk_index = ?
                """,
                (target_text, project_id, source_id, index),
            )
            if translated.rowcount != 1:
                raise SourceOperationStateError(
                    "Capture audio translation could not be persisted."
                )

        duration_ms = max(segment.end_ms for segment, _target in segments)
        updated = connection.execute(
            """
            UPDATE sources
            SET duration_ms = ?, has_text = 1, status = 'ready',
                extraction_method = 'transcription', processed_page_count = ?,
                failure_message = NULL,
                transcription_status = 'succeeded', translation_status = 'succeeded',
                configured_transcription_model = ?, effective_transcription_model = ?,
                transcription_device = ?, transcription_warning = ?,
                extraction_provenance = ?,
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
                extraction_provenance,
                now,
                project_id,
                source_id,
            ),
        )
        if updated.rowcount != 1:
            raise SourceProcessingCanceledError(
                "Document processing was canceled before capture publication."
            )
        _apply(
            connection,
            committing,
            committing.succeed(now),
            "Capture audio operation success could not be committed.",
        )
        return _source(connection, project_id, source_id)


def acknowledge_cancellation(
    db: Database,
    *,
    project_id: str,
    operation_id: str,
    question_jobs: BindQuestionJobs,
) -> SourceOperation:
    now = utc_now()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        operation = _required_operation(_operation_query_by_id(connection, operation_id))
        operation.ensure_belongs_to(project_id)
        canceled = operation.acknowledge_cancellation(now)
        if canceled is operation:
            return operation
        _record_stopped_source(
            connection, canceled, question_jobs=question_jobs(connection), now=now
        )
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
    question_jobs: BindQuestionJobs,
    source_status: str | None = None,
    extraction_method: str | None = None,
) -> SourceOperation:
    now = utc_now()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        operation = _required_operation(_operation_query_by_id(connection, operation_id))
        operation.ensure_belongs_to(project_id)
        stopped = operation.fail(error, now)
        if stopped is operation:
            return operation
        _record_stopped_source(
            connection,
            stopped,
            question_jobs=question_jobs(connection),
            source_status=source_status,
            extraction_method=extraction_method,
            now=now,
        )
        _apply(connection, operation, stopped, "Document operation could not be stopped.")
        return _required_operation(_operation_query_by_id(connection, operation_id))


def start_retry_operation(
    db: Database,
    *,
    project_id: str,
    source_id: str,
    question_jobs: BindQuestionJobs,
    operation_id: str | None = None,
) -> SourceOperation:
    """Reset retryable parsing state and create its linked running operation atomically."""

    next_operation_id = operation_id or str(uuid4())
    now = utc_now()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        existing = _operation_query_by_id(connection, next_operation_id)
        if existing is not None:
            _operation_from_row(existing).refuse_reuse_for_retry(project_id)
        source = source_query(connection, project_id, source_id)
        if source is None:
            raise NotFoundError("Document not found.")
        active = connection.execute(
            """
            SELECT id
            FROM source_operations
            WHERE project_id = ? AND source_id = ?
                AND status IN ('queued', 'running', 'cancel_requested')
            LIMIT 1
            """,
            (project_id, source_id),
        ).fetchone()
        ensure_retry_allowed(
            has_active_operation=active is not None,
            source_status=source["status"],
        )
        _reset_source_derived_state(
            connection,
            question_jobs=question_jobs(connection),
            project_id=project_id,
            source_id=source_id,
            status="processing",
            extraction_method="none",
            failure_message=None,
            now=now,
        )
        connection.execute(
            """
            UPDATE sources
            SET duration_ms = NULL, transcription_status = 'pending',
                translation_status = 'pending', configured_transcription_model = NULL,
                effective_transcription_model = NULL, transcription_device = NULL,
                transcription_warning = NULL
            WHERE project_id = ? AND id = ? AND source_kind = 'recording'
            """,
            (project_id, source_id),
        )
        retry = SourceOperation.start_retry(
            operation_id=next_operation_id,
            project_id=project_id,
            source_id=source_id,
            now=now,
        )
        connection.execute(
            """
            INSERT INTO source_operations(
                id, project_id, source_id, status, phase, cancellable,
                error, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            _operation_values(retry),
        )
        return _required_operation(_operation_query_by_id(connection, next_operation_id))


def recover_operations(db: Database, *, question_jobs: BindQuestionJobs) -> int:
    """Fail interrupted work while honoring durable user cancellation."""

    with db.connect() as connection:
        rows = connection.execute(
            """
            SELECT id, project_id, status
            FROM source_operations
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
                question_jobs=question_jobs,
            )
        else:
            finish_failed(
                db,
                project_id=str(row["project_id"]),
                operation_id=str(row["id"]),
                error="Document processing was interrupted by an app restart.",
                question_jobs=question_jobs,
            )
    return len(rows)



def get_operation(
    db: Database,
    *,
    project_id: str,
    operation_id: str,
) -> SourceOperation:
    with db.connect() as connection:
        row = connection.execute(
            "SELECT * FROM source_operations WHERE id = ? AND project_id = ?",
            (operation_id, project_id),
        ).fetchone()
    if row is None:
        raise NotFoundError("Document operation not found.")
    return _operation_from_row(row)



def get_active_operation_for_source(
    db: Database,
    *,
    project_id: str,
    source_id: str,
) -> SourceOperation | None:
    with db.connect() as connection:
        row = connection.execute(
            """
            SELECT * FROM source_operations
            WHERE project_id = ? AND source_id = ?
              AND status IN ('queued', 'running', 'cancel_requested')
            ORDER BY updated_at DESC, id DESC
            LIMIT 1
            """,
            (project_id, source_id),
        ).fetchone()
    return None if row is None else _operation_from_row(row)



def _apply(
    connection: Connection,
    before: SourceOperation,
    after: SourceOperation,
    failure_message: str,
) -> None:
    """Store a transition only if the operation is still in the state it was decided from."""

    updated = connection.execute(
        """
        UPDATE source_operations
        SET source_id = ?, status = ?, phase = ?, cancellable = ?, error = ?, updated_at = ?
        WHERE id = ? AND project_id = ? AND status = ? AND phase = ? AND cancellable = ?
            AND source_id IS ?
        """,
        (
            after.source_id,
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
            before.source_id,
        ),
    )
    if updated.rowcount != 1:
        raise SourceOperationStateError(failure_message)


def _cancel(
    connection: Connection,
    operation: SourceOperation,
    *,
    project_id: str,
    now: str,
) -> SourceOperation:
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
        requested.status is SourceOperationStatus.CANCEL_REQUESTED
        and requested.source_id is not None
    ):
        connection.execute(
            """
            UPDATE sources
            SET status = 'cancel_requested', updated_at = ?
            WHERE project_id = ? AND id = ? AND status = 'processing'
            """,
            (now, project_id, requested.source_id),
        )
    return _required_operation(_operation_query_by_id(connection, operation.id))


def _record_stopped_source(
    connection: Connection,
    stopped: SourceOperation,
    *,
    question_jobs: SourceQuestionJobs,
    source_status: str | None = None,
    extraction_method: str | None = None,
    now: str,
) -> None:
    """Leave the stopped run's source retryable; audio keeps the transcript it already has."""

    if stopped.source_id is None:
        return
    project_id = stopped.project_id
    source_id = str(stopped.source_id)
    source = source_query(connection, project_id, source_id)
    if source is None:
        raise NotFoundError("Document not found.")
    if source["source_kind"] == "recording":
        if stopped.status is SourceOperationStatus.CANCELED:
            _preserve_canceled_audio_state(
                connection,
                question_jobs=question_jobs,
                project_id=project_id,
                source_id=source_id,
                now=now,
            )
        else:
            _preserve_failed_audio_state(
                connection,
                question_jobs=question_jobs,
                project_id=project_id,
                source_id=source_id,
                error=stopped.error,
                now=now,
            )
        return
    state = failure_state(
        stopped,
        source_status=source_status,
        extraction_method=extraction_method,
        page_count=int(source["page_count"] or 0),
    )
    _reset_source_derived_state(
        connection,
        question_jobs=question_jobs,
        project_id=project_id,
        source_id=source_id,
        status=state.status,
        extraction_method=state.extraction_method,
        failure_message=state.failure_message,
        processed_page_count=state.processed_page_count,
        now=now,
    )


def _source(connection: Connection, project_id: str, source_id: str) -> Source:
    row = source_query(connection, project_id, source_id)
    if row is None:
        raise NotFoundError("Document not found.")
    return source_from_row(row)


def _operation_values(
    operation: SourceOperation,
) -> tuple[str, str, str | None, str, str, int, str | None, str, str]:
    return (
        operation.id,
        operation.project_id,
        operation.source_id,
        operation.status.value,
        operation.phase.value,
        int(operation.cancellable),
        operation.error,
        operation.created_at,
        operation.updated_at,
    )


def _reset_source_derived_state(
    connection: Connection,
    *,
    question_jobs: SourceQuestionJobs,
    project_id: str,
    source_id: str,
    status: str,
    extraction_method: str,
    failure_message: str | None,
    processed_page_count: int = 0,
    now: str,
) -> None:
    question_jobs.discard_unfinished(project_id, source_id)
    connection.execute(
        "DELETE FROM source_chunks WHERE project_id = ? AND source_id = ?",
        (project_id, source_id),
    )
    # The source's questions outlive its chunks, so its question count stays as it is.
    updated = connection.execute(
        """
        UPDATE sources
        SET status = ?, has_text = 0, extraction_method = ?,
            ocr_device = NULL, extraction_warnings = NULL, extraction_provenance = NULL,
            failure_message = ?,
            processed_page_count = ?,
            content_profile = 'unknown', classification_detail = '',
            updated_at = ?
        WHERE project_id = ? AND id = ?
        """,
        (
            status,
            extraction_method,
            failure_message,
            processed_page_count,
            now,
            project_id,
            source_id,
        ),
    )
    if updated.rowcount != 1:
        raise NotFoundError("Document not found.")



def _operation_query_by_id(connection: Connection, operation_id: str) -> Row | None:
    return connection.execute(
        "SELECT * FROM source_operations WHERE id = ?",
        (operation_id,),
    ).fetchone()



# The stored extraction provenance describes a completed transcript. A stopped audio run
# keeps it exactly when it keeps that transcript: transcription had succeeded and its time
# chunks are still there (extraction_method stays 'transcription'). Partial chunks of an
# unfinished transcription are not the result the provenance describes. Bound parameter:
# the number of kept time chunks. SQLite reads the old transcription_status here.
_KEEP_PROVENANCE_OF_COMPLETED_TRANSCRIPT = """CASE
                WHEN transcription_status = 'succeeded' AND ? > 0
                THEN extraction_provenance
            END"""


def _preserve_canceled_audio_state(
    connection: Connection,
    *,
    question_jobs: SourceQuestionJobs,
    project_id: str,
    source_id: str,
    now: str,
) -> None:
    question_jobs.discard_unfinished(project_id, source_id)
    chunks_count = connection.execute(
        """
        SELECT COUNT(*) FROM source_chunks
        WHERE project_id = ? AND source_id = ? AND locator_kind = 'time'
        """,
        (project_id, source_id),
    ).fetchone()[0]
    updated = connection.execute(
        """
        UPDATE sources
        SET status = ?, has_text = ?, extraction_method = ?,
            ocr_device = NULL, extraction_warnings = NULL,
            extraction_provenance = """
        + _KEEP_PROVENANCE_OF_COMPLETED_TRANSCRIPT
        + """,
            failure_message = NULL,
            processed_page_count = ?,
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
        WHERE project_id = ? AND id = ? AND source_kind = 'recording'
        """,
        (
            "canceled",
            int(chunks_count > 0),
            "transcription" if chunks_count > 0 else "none",
            chunks_count,
            chunks_count,
            "study_material" if chunks_count > 0 else "unknown",
            now,
            project_id,
            source_id,
        ),
    )
    if updated.rowcount != 1:
        raise NotFoundError("Audio document not found.")



def _preserve_failed_audio_state(
    connection: Connection,
    *,
    question_jobs: SourceQuestionJobs,
    project_id: str,
    source_id: str,
    error: str | None,
    now: str,
) -> None:
    """Keep incremental transcript data while making an audio failure retryable."""

    question_jobs.discard_unfinished(project_id, source_id)
    chunks_count = connection.execute(
        """
        SELECT COUNT(*) FROM source_chunks
        WHERE project_id = ? AND source_id = ? AND locator_kind = 'time'
        """,
        (project_id, source_id),
    ).fetchone()[0]
    updated = connection.execute(
        """
        UPDATE sources
        SET status = CASE
                WHEN transcription_status = 'succeeded' THEN 'ready'
                ELSE 'transcription_failed'
            END,
            has_text = ?, extraction_method = ?,
            ocr_device = NULL, extraction_warnings = NULL,
            extraction_provenance = """
        + _KEEP_PROVENANCE_OF_COMPLETED_TRANSCRIPT
        + """,
            failure_message = CASE WHEN transcription_status != 'succeeded' THEN ? END,
            processed_page_count = ?,
            content_profile = ?, classification_detail = '',
            transcription_status = CASE
                WHEN transcription_status = 'succeeded' THEN 'succeeded'
                ELSE 'failed'
            END,
            translation_status = 'failed', updated_at = ?
        WHERE project_id = ? AND id = ? AND source_kind = 'recording'
        """,
        (
            int(chunks_count > 0),
            "transcription" if chunks_count > 0 else "none",
            chunks_count,
            error,
            chunks_count,
            "study_material" if chunks_count > 0 else "unknown",
            now,
            project_id,
            source_id,
        ),
    )
    if updated.rowcount != 1:
        raise NotFoundError("Audio document not found.")



def _required_operation(row: Row | None) -> SourceOperation:
    if row is None:
        raise NotFoundError("Document operation not found.")
    return _operation_from_row(row)



def _operation_from_row(row: Row) -> SourceOperation:
    return SourceOperation(
        id=row["id"],
        project_id=row["project_id"],
        source_id=row["source_id"],
        status=SourceOperationStatus(row["status"]),
        phase=SourceOperationPhase(row["phase"]),
        cancellable=bool(row["cancellable"]),
        error=row["error"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )



__all__ = [
    "BindQuestionJobs",
    "SourceOperationClaim",
    "acknowledge_cancellation",
    "cancel_source_processing",
    "cancel_operation",
    "claim_operation",
    "create_and_attach_source",
    "finish_failed",
    "get_operation",
    "publish_success",
    "recover_operations",
    "start_retry_operation",
]

