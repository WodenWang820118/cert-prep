from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sqlite3
from threading import Barrier

import pytest
from fastapi.testclient import TestClient

from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import Settings
from cert_prep_backend.core.exceptions import (
    DocumentOperationConflictError,
    DocumentProcessingCanceledError,
    OperationNotCancellableError,
)
from cert_prep_backend.domains.source_documents.models import (
    ExtractedPage,
    PdfExtraction,
)
from cert_prep_backend.domains.mock_exams import draft_jobs
from cert_prep_backend.domains.source_documents import operations
from cert_prep_backend.domains.source_documents.progress import (
    fail_document_extraction,
    record_extraction_progress,
)
from cert_prep_backend.persistence.database import Database


def test_concurrent_global_operation_claim_has_exactly_one_owner(tmp_path: Path) -> None:
    db = _database(tmp_path)
    _insert_project(db, "project")
    barrier = Barrier(8)

    def claim() -> operations.DocumentOperationClaim:
        barrier.wait()
        return operations.claim_operation(
            db,
            project_id="project",
            operation_id="shared-operation",
        )

    with ThreadPoolExecutor(max_workers=8) as executor:
        claims = list(executor.map(lambda _index: claim(), range(8)))

    assert sum(claim.acquired for claim in claims) == 1
    assert {claim.operation["id"] for claim in claims} == {"shared-operation"}
    assert operations.get_operation(
        db,
        project_id="project",
        operation_id="shared-operation",
    )["status"] == "queued"


def test_concurrent_post_claim_and_delete_tombstone_never_create_duplicate_work(
    tmp_path: Path,
) -> None:
    db = _database(tmp_path)
    _insert_project(db, "project")
    barrier = Barrier(2)

    def claim():
        barrier.wait()
        return operations.claim_operation(
            db,
            project_id="project",
            operation_id="racing-operation",
        )

    def cancel():
        barrier.wait()
        return operations.cancel_operation(
            db,
            project_id="project",
            operation_id="racing-operation",
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        claim_future = executor.submit(claim)
        cancel_future = executor.submit(cancel)
        claim_result = claim_future.result()
        cancel_result = cancel_future.result()

    assert claim_result.operation["id"] == "racing-operation"
    assert cancel_result["status"] == "canceled"
    assert operations.get_operation(
        db,
        project_id="project",
        operation_id="racing-operation",
    )["status"] == "canceled"
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 0


def test_global_operation_id_collision_does_not_cross_project_boundary(
    tmp_path: Path,
) -> None:
    db = _database(tmp_path)
    _insert_project(db, "project-a")
    _insert_project(db, "project-b")
    operations.claim_operation(
        db,
        project_id="project-a",
        operation_id="global-id",
    )

    with pytest.raises(DocumentOperationConflictError):
        operations.claim_operation(
            db,
            project_id="project-b",
            operation_id="global-id",
        )
    with pytest.raises(DocumentOperationConflictError):
        operations.cancel_operation(
            db,
            project_id="project-b",
            operation_id="global-id",
        )

    assert operations.get_operation(
        db,
        project_id="project-a",
        operation_id="global-id",
    )["status"] == "queued"


def test_cancel_before_attach_is_terminal_and_creates_no_document(tmp_path: Path) -> None:
    db = _database(tmp_path)
    _insert_project(db, "project")
    operations.claim_operation(db, project_id="project", operation_id="upload")
    canceled = operations.cancel_operation(
        db,
        project_id="project",
        operation_id="upload",
    )

    assert canceled["status"] == "canceled"
    with pytest.raises(DocumentProcessingCanceledError):
        operations.create_and_attach_document(
            db,
            project_id="project",
            operation_id="upload",
            document_id="document",
            filename="source.pdf",
            sha256="sha",
            language_hint="auto",
            storage_path="C:/data/source.pdf",
            page_count=1,
        )
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 0


def test_progress_checkpoint_rejects_wrong_or_canceled_operation_without_writes(
    tmp_path: Path,
) -> None:
    db = _database(tmp_path)
    _insert_project(db, "project")
    _attach(db, operation_id="upload", document_id="document")
    page = _ready_extraction().pages[0]

    with pytest.raises(DocumentProcessingCanceledError):
        record_extraction_progress(
            db,
            project_id="project",
            document_id="document",
            operation_id="wrong-operation",
            processed_page_count=1,
            page=page,
            ocr_device="cpu",
            ocr_fallback_reason=None,
            ocr_duration_ms=1,
        )
    operations.cancel_operation(
        db,
        project_id="project",
        operation_id="upload",
    )
    with pytest.raises(DocumentProcessingCanceledError):
        record_extraction_progress(
            db,
            project_id="project",
            document_id="document",
            operation_id="upload",
            processed_page_count=1,
            page=page,
            ocr_device="cpu",
            ocr_fallback_reason=None,
            ocr_duration_ms=1,
        )

    with db.connect() as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM document_chunks WHERE document_id = 'document'"
        ).fetchone()[0] == 0


@pytest.mark.parametrize(
    "terminal_status",
    [
        "succeeded",
        "failed",
        "skipped_provider_unavailable",
        "skipped_missing_model",
    ],
)
def test_cancel_first_rolls_back_late_publication_and_preserves_draft_history(
    tmp_path: Path,
    terminal_status: str,
) -> None:
    db = _database(tmp_path)
    _insert_project(db, "project")
    _attach(db, operation_id="upload", document_id="document")
    _seed_partial_work(db, "document")
    _seed_terminal_draft_history(db, "document", status=terminal_status)
    with db.connect() as connection:
        terminal_row = connection.execute(
            "SELECT * FROM draft_generation_jobs WHERE id = 'terminal-job'"
        ).fetchone()
    assert terminal_row is not None
    terminal_before = dict(terminal_row)
    public_terminal_before = draft_jobs.get_job(db, "terminal-job")

    requested = operations.cancel_operation(
        db,
        project_id="project",
        operation_id="upload",
    )
    assert requested["status"] == "cancel_requested"
    with pytest.raises(DocumentProcessingCanceledError):
        operations.publish_success(
            db,
            project_id="project",
            operation_id="upload",
            document_id="document",
            extraction=_ready_extraction(),
        )
    terminal = operations.acknowledge_cancellation(
        db,
        project_id="project",
        operation_id="upload",
    )

    assert terminal["status"] == "canceled"
    document = _document_row(db, "document")
    assert document["status"] == "canceled"
    assert document["storage_path"] == "C:/data/source.pdf"
    assert document["sha256"] == "sha"
    assert document["page_count"] == 1
    assert document["has_text"] == 0
    assert document["ocr_device"] is None
    assert document["ocr_fallback_reason"] is None
    for column in (
        "ocr_duration_ms",
        "processed_page_count",
        "parse_wall_duration_ms",
        "render_duration_ms",
        "ocr_engine_duration_ms",
        "ocr_worker_count",
        "first_chunk_ms",
        "exam_item_count",
    ):
        assert document[column] == 0
    with db.connect() as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM document_chunks WHERE document_id = 'document'"
        ).fetchone()[0] == 0
        remaining_jobs = connection.execute(
            "SELECT * FROM draft_generation_jobs WHERE document_id = 'document'"
        ).fetchall()
        assert len(remaining_jobs) == 1
        terminal_after = dict(remaining_jobs[0])
    assert terminal_before.pop("chunk_id") == "partial-chunk"
    assert terminal_after.pop("chunk_id") is None
    assert terminal_after == terminal_before
    assert terminal_after["source_chunk_id"] == "partial-chunk"
    assert draft_jobs.get_job(db, "terminal-job") == public_terminal_before
    assert draft_jobs.retry_document_jobs(
        db,
        project_id="project",
        document_id="document",
        provider="ollama",
        model="qwen3.5:2b",
    ) == []
    assert draft_jobs.recover_runnable_jobs(db) == []
    assert draft_jobs.get_job(db, "terminal-job") == public_terminal_before


@pytest.mark.parametrize(
    ("request_cancel", "expected_operation_status", "expected_document_status"),
    [
        (False, "failed", "ocr_failed"),
        (True, "canceled", "canceled"),
    ],
)
def test_app_startup_recovers_durable_document_operations(
    tmp_path: Path,
    request_cancel: bool,
    expected_operation_status: str,
    expected_document_status: str,
) -> None:
    settings = Settings(data_dir=tmp_path, api_token="test-token")
    db = Database(settings)
    db.migrate()
    _insert_project(db, "project")
    _attach(db, operation_id="upload", document_id="document")
    _seed_partial_work(db, "document")
    if request_cancel:
        operations.cancel_operation(
            db,
            project_id="project",
            operation_id="upload",
        )

    with TestClient(
        create_app(settings=settings, document_processing_async_jobs=False)
    ) as client:
        recovered_db = client.app.state.database
        operation = operations.get_operation(
            recovered_db,
            project_id="project",
            operation_id="upload",
        )
        document = _document_row(recovered_db, "document")
        with recovered_db.connect() as connection:
            active_count = connection.execute(
                """
                SELECT COUNT(*)
                FROM document_operations
                WHERE status IN ('queued', 'running', 'cancel_requested')
                """
            ).fetchone()[0]

    assert operation["status"] == expected_operation_status
    assert document["status"] == expected_document_status
    assert active_count == 0


def test_publication_is_atomic_and_terminal_finalizers_are_read_only(
    tmp_path: Path,
) -> None:
    db = _database(tmp_path)
    _insert_project(db, "project")
    _attach(db, operation_id="upload", document_id="document")

    published = operations.publish_success(
        db,
        project_id="project",
        operation_id="upload",
        document_id="document",
        extraction=_ready_extraction(),
    )
    before = _terminal_snapshot(db, "upload", "document")

    assert published["status"] == "ready"
    assert operations.cancel_operation(
        db,
        project_id="project",
        operation_id="upload",
    )["status"] == "succeeded"
    assert operations.finish_failed(
        db,
        project_id="project",
        operation_id="upload",
        error="late failure",
    )["status"] == "succeeded"
    assert operations.acknowledge_cancellation(
        db,
        project_id="project",
        operation_id="upload",
    )["status"] == "succeeded"
    assert _terminal_snapshot(db, "upload", "document") == before


def test_success_trigger_failure_rolls_back_commit_phase_document_and_chunks(
    tmp_path: Path,
) -> None:
    db = _database(tmp_path)
    _insert_project(db, "project")
    _attach(db, operation_id="upload", document_id="document")
    with db.connect() as connection:
        connection.execute(
            """
            CREATE TRIGGER reject_document_operation_success
            BEFORE UPDATE OF status ON document_operations
            WHEN NEW.status = 'succeeded'
            BEGIN
                SELECT RAISE(ABORT, 'operation success rejected');
            END;
            """
        )

    with pytest.raises(sqlite3.IntegrityError, match="operation success rejected"):
        operations.publish_success(
            db,
            project_id="project",
            operation_id="upload",
            document_id="document",
            extraction=_ready_extraction(),
        )

    operation = operations.get_operation(
        db,
        project_id="project",
        operation_id="upload",
    )
    assert (operation["status"], operation["phase"], operation["cancellable"]) == (
        "running",
        "processing",
        True,
    )
    assert _document_row(db, "document")["status"] == "processing"
    with db.connect() as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM document_chunks WHERE document_id = 'document'"
        ).fetchone()[0] == 0


def test_real_cancel_vs_publish_race_has_only_two_legal_outcomes(tmp_path: Path) -> None:
    db = _database(tmp_path)
    _insert_project(db, "project")
    _attach(db, operation_id="upload", document_id="document")
    barrier = Barrier(2)

    def publish():
        barrier.wait()
        try:
            operations.publish_success(
                db,
                project_id="project",
                operation_id="upload",
                document_id="document",
                extraction=_ready_extraction(),
            )
            return "succeeded"
        except DocumentProcessingCanceledError:
            return "canceled"

    def cancel():
        barrier.wait()
        return operations.cancel_operation(
            db,
            project_id="project",
            operation_id="upload",
        )["status"]

    with ThreadPoolExecutor(max_workers=2) as executor:
        publish_future = executor.submit(publish)
        cancel_future = executor.submit(cancel)
        publish_result = publish_future.result()
        cancel_result = cancel_future.result()

    operation = operations.get_operation(
        db,
        project_id="project",
        operation_id="upload",
    )
    if operation["status"] == "succeeded":
        assert publish_result == "succeeded"
        assert cancel_result == "succeeded"
        assert _document_row(db, "document")["status"] == "ready"
    else:
        assert operation["status"] == "cancel_requested"
        assert publish_result == "canceled"
        assert cancel_result == "cancel_requested"
        operations.acknowledge_cancellation(
            db,
            project_id="project",
            operation_id="upload",
        )
        assert _document_row(db, "document")["status"] == "canceled"


def test_persisted_legacy_committing_state_rejects_cancel(tmp_path: Path) -> None:
    db = _database(tmp_path)
    _insert_project(db, "project")
    _attach(db, operation_id="upload", document_id="document")
    with db.connect() as connection:
        connection.execute(
            """
            UPDATE document_operations
            SET phase = 'committing', cancellable = 0
            WHERE id = 'upload'
            """
        )

    with pytest.raises(OperationNotCancellableError):
        operations.cancel_operation(
            db,
            project_id="project",
            operation_id="upload",
        )


def test_legacy_failure_writer_cannot_overwrite_cancel_requested_document(
    tmp_path: Path,
) -> None:
    db = _database(tmp_path)
    _insert_project(db, "project")
    _attach(db, operation_id="upload", document_id="document")
    operations.cancel_operation(
        db,
        project_id="project",
        operation_id="upload",
    )

    document = fail_document_extraction(
        db,
        project_id="project",
        document_id="document",
        status="ocr_failed",
        detail="late OCR failure",
    )

    assert document["status"] == "cancel_requested"
    assert operations.get_operation(
        db,
        project_id="project",
        operation_id="upload",
    )["status"] == "cancel_requested"


def test_concurrent_retry_has_one_owner_and_recovery_is_idempotent(
    tmp_path: Path,
) -> None:
    db = _database(tmp_path)
    _insert_project(db, "project")
    _attach(db, operation_id="first", document_id="document")
    operations.cancel_operation(db, project_id="project", operation_id="first")
    operations.acknowledge_cancellation(
        db,
        project_id="project",
        operation_id="first",
    )
    barrier = Barrier(2)

    def retry(operation_id: str):
        barrier.wait()
        try:
            return operations.start_retry_operation(
                db,
                project_id="project",
                document_id="document",
                operation_id=operation_id,
            )["id"]
        except DocumentOperationConflictError:
            return "conflict"

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(retry, ("retry-a", "retry-b")))

    assert results.count("conflict") == 1
    retry_id = next(result for result in results if result != "conflict")
    _seed_partial_work(db, "document")
    assert operations.recover_operations(db) == 1
    first_recovery = _terminal_snapshot(db, retry_id, "document")
    assert operations.recover_operations(db) == 0
    assert _terminal_snapshot(db, retry_id, "document") == first_recovery
    assert operations.get_operation(
        db,
        project_id="project",
        operation_id=retry_id,
    )["status"] == "failed"
    document = _document_row(db, "document")
    assert document["status"] == "ocr_failed"
    assert document["storage_path"] == "C:/data/source.pdf"
    with db.connect() as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM document_chunks WHERE document_id = 'document'"
        ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM draft_generation_jobs WHERE document_id = 'document'"
        ).fetchone()[0] == 0


def _database(tmp_path: Path) -> Database:
    db = Database(Settings(data_dir=tmp_path, api_token="test-token"))
    db.migrate()
    return db


def _insert_project(db: Database, project_id: str) -> None:
    with db.connect() as connection:
        connection.execute(
            """
            INSERT INTO projects(id, name, description, created_at, updated_at)
            VALUES (?, ?, '', '2026-07-14', '2026-07-14')
            """,
            (project_id, project_id),
        )


def _attach(db: Database, *, operation_id: str, document_id: str) -> None:
    claim = operations.claim_operation(
        db,
        project_id="project",
        operation_id=operation_id,
    )
    assert claim.acquired is True
    operations.create_and_attach_document(
        db,
        project_id="project",
        operation_id=operation_id,
        document_id=document_id,
        filename="source.pdf",
        sha256="sha",
        language_hint="auto",
        storage_path="C:/data/source.pdf",
        page_count=1,
    )


def _ready_extraction() -> PdfExtraction:
    return PdfExtraction(
        page_count=1,
        pages=(
            ExtractedPage(
                page_number=1,
                text="Question source text",
                source_excerpt="Question source text",
                extraction_method="embedded",
            ),
        ),
        status="ready",
        extraction_method="embedded",
        ocr_device="cpu",
        ocr_fallback_reason=None,
        ocr_duration_ms=10,
        processed_page_count=1,
        parse_wall_duration_ms=20,
        render_duration_ms=3,
        ocr_engine_duration_ms=7,
        ocr_worker_count=1,
        first_chunk_ms=5,
    )


def _seed_partial_work(db: Database, document_id: str) -> None:
    with db.connect() as connection:
        connection.execute(
            """
            UPDATE documents
            SET has_text = 1, ocr_device = 'igpu', ocr_fallback_reason = 'fallback',
                ocr_duration_ms = 11, processed_page_count = 1,
                parse_wall_duration_ms = 12, render_duration_ms = 13,
                ocr_engine_duration_ms = 14, ocr_worker_count = 2,
                first_chunk_ms = 15, exam_item_count = 3,
                content_profile = 'mixed', classification_detail = 'partial'
            WHERE id = ?
            """,
            (document_id,),
        )
        connection.execute(
            """
            INSERT INTO document_chunks(
                id, project_id, document_id, page_number, chunk_index,
                text, source_excerpt, created_at
            )
            VALUES (
                'partial-chunk', 'project', ?, 1, 0,
                'partial text', 'partial text', '2026-07-14'
            )
            """,
            (document_id,),
        )
        connection.execute(
            """
            INSERT INTO draft_generation_jobs(
                id, project_id, document_id, chunk_id, source_chunk_id,
                page_number, strategy, status, provider, model,
                created_at, updated_at
            )
            VALUES (
                'partial-job', 'project', ?, 'partial-chunk', 'partial-chunk', 1,
                'hybrid_reasoning', 'pending', 'fastflowlm', 'qwen3.5:4b',
                '2026-07-14', '2026-07-14'
            )
            """,
            (document_id,),
        )


def _seed_terminal_draft_history(
    db: Database,
    document_id: str,
    *,
    status: str,
) -> None:
    phase = "completed" if status == "succeeded" else "failed"
    with db.connect() as connection:
        connection.execute(
            """
            INSERT INTO draft_generation_jobs(
                id, project_id, document_id, chunk_id, page_number, strategy,
                source_chunk_id, status, phase, cancellable, provider, model,
                effective_provider, effective_model, fallback_reason,
                generated_count, retry_count, last_error, created_at, updated_at
            )
            VALUES (
                'terminal-job', 'project', ?, 'partial-chunk', 1,
                'deterministic_only', 'partial-chunk', ?, ?, 0,
                'fastflowlm', 'qwen3.5:4b', 'fastflowlm', 'qwen3.5:4b',
                'configured', 3, 1, 'historical detail',
                '2026-07-13', '2026-07-14'
            )
            """,
            (document_id, status, phase),
        )


def _document_row(db: Database, document_id: str) -> sqlite3.Row:
    with db.connect() as connection:
        row = connection.execute(
            "SELECT * FROM documents WHERE id = ?",
            (document_id,),
        ).fetchone()
    assert row is not None
    return row


def _terminal_snapshot(db: Database, operation_id: str, document_id: str) -> tuple:
    with db.connect() as connection:
        operation = connection.execute(
            "SELECT * FROM document_operations WHERE id = ?",
            (operation_id,),
        ).fetchone()
        document = connection.execute(
            "SELECT * FROM documents WHERE id = ?",
            (document_id,),
        ).fetchone()
        chunks = connection.execute(
            """
            SELECT page_number, chunk_index, text, source_excerpt
            FROM document_chunks
            WHERE document_id = ?
            ORDER BY page_number, chunk_index
            """,
            (document_id,),
        ).fetchall()
    assert operation is not None
    assert document is not None
    return tuple(operation), tuple(document), tuple(tuple(row) for row in chunks)
