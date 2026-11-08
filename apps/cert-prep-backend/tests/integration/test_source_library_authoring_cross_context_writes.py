"""Today's results of the Source Library and Question Authoring writes that cross into each
other's tables, and of Source Library's project checks.

Stopping or retrying a document's run discards that document's unfinished draft generation
jobs in the same transaction. Committing generated drafts records the document's exam item
count and status in the same transaction as the drafts and the job or operation.

The writes now go through the owning context's use cases on the caller's connection, and the
project checks through Study Projects; bootstrap wires them as the app does.
"""

from __future__ import annotations

from pathlib import Path
import sqlite3
from sqlite3 import Connection

import pytest

from cert_prep_backend.authoring.domain.models import DraftSuggestion
from cert_prep_backend.authoring.infrastructure import draft_jobs
from cert_prep_backend.authoring.infrastructure import manual_operations
from cert_prep_backend.authoring.infrastructure import repository as drafts_repository
from cert_prep_backend.authoring.infrastructure.sources import SourceLibraryDraftSources
from cert_prep_backend.bootstrap.authoring_links import (
    authoring_documents,
    bind_document_exam_state,
)
from cert_prep_backend.bootstrap.source_library_links import (
    document_operation_repository,
    document_repository,
)
from cert_prep_backend.bootstrap.study_projects import authoring_projects
from cert_prep_backend.capture_integration.infrastructure.review_workflow import (
    CaptureReviewMaintenanceAdapter,
)
from cert_prep_backend.platform.config import Settings
from cert_prep_backend.platform.database import Database
from cert_prep_backend.platform.errors import NotFoundError
from cert_prep_backend.source_library.infrastructure.repository import (
    SqliteDocumentOperationRepository,
    SqliteDocumentRepository,
)

UNFINISHED_JOB_STATUSES = ("pending", "running", "cancel_requested")
FINISHED_JOB_STATUSES = ("succeeded", "failed", "canceled", "skipped_missing_model")


def test_a_failed_run_discards_unfinished_draft_jobs_and_keeps_finished_ones(
    tmp_path: Path,
) -> None:
    db = _database(tmp_path)
    doc = _attach_pdf(db, operation_id="upload")
    _seed_text_and_jobs(db, doc)
    _seed_text_and_jobs(db, "other-doc", attach=True)

    failed = _operations(db).fail("proj", "upload", error="OCR failed.")

    assert failed.status == "failed"
    assert _job_statuses(db, doc) == sorted(FINISHED_JOB_STATUSES)
    assert _job_statuses(db, "other-doc") == sorted(
        UNFINISHED_JOB_STATUSES + FINISHED_JOB_STATUSES
    )
    assert _chunk_count(db, doc) == 0
    document = _document_row(db, doc)
    assert document["has_text"] == 0
    assert document["exam_item_count"] == 0


def test_a_retry_discards_unfinished_draft_jobs(tmp_path: Path) -> None:
    db = _database(tmp_path)
    doc = _attach_pdf(db, operation_id="upload")
    _operations(db).fail("proj", "upload", error="OCR failed.")
    _seed_text_and_jobs(db, doc)

    retry = _operations(db).start_retry("proj", doc, "retry")

    assert retry.status == "running"
    assert _job_statuses(db, doc) == sorted(FINISHED_JOB_STATUSES)
    assert _chunk_count(db, doc) == 0
    assert _document_row(db, doc)["status"] == "processing"


def test_recovery_discards_unfinished_draft_jobs_of_interrupted_runs(tmp_path: Path) -> None:
    db = _database(tmp_path)
    doc = _attach_pdf(db, operation_id="upload")
    _seed_text_and_jobs(db, doc)

    assert _operations(db).recover_interrupted() == 1

    assert _job_statuses(db, doc) == sorted(FINISHED_JOB_STATUSES)
    assert _document_row(db, doc)["status"] == "ocr_failed"


@pytest.mark.parametrize("stop", ["cancel", "fail"])
def test_a_stopped_audio_run_discards_unfinished_jobs_and_keeps_its_transcript(
    tmp_path: Path, stop: str
) -> None:
    db = _database(tmp_path)
    audio = _attach_audio(db, operation_id="audio-upload")
    _seed_text_and_jobs(db, audio, locator_kind="time")

    if stop == "cancel":
        _operations(db).cancel("proj", "audio-upload")
        stopped = _operations(db).acknowledge_cancellation("proj", "audio-upload")
        assert stopped.status == "canceled"
        expected_status = "canceled"
    else:
        stopped = _operations(db).fail("proj", "audio-upload", error="Transcription failed.")
        assert stopped.status == "failed"
        expected_status = "transcription_failed"

    assert _job_statuses(db, audio) == sorted(FINISHED_JOB_STATUSES)
    assert _chunk_count(db, audio) == 1
    document = _document_row(db, audio)
    assert document["status"] == expected_status
    assert document["exam_item_count"] == 0


def test_the_job_cleanup_rolls_back_with_the_run_it_belongs_to(tmp_path: Path) -> None:
    db = _database(tmp_path)
    doc = _attach_pdf(db, operation_id="upload")
    _seed_text_and_jobs(db, doc)
    with db.connect() as connection:
        connection.execute(
            """
            CREATE TRIGGER reject_operation_stop
            BEFORE UPDATE OF status ON document_operations
            WHEN NEW.status = 'failed'
            BEGIN
                SELECT RAISE(ABORT, 'operation stop rejected');
            END;
            """
        )

    with pytest.raises(sqlite3.IntegrityError, match="operation stop rejected"):
        _operations(db).fail("proj", "upload", error="OCR failed.")

    assert _job_statuses(db, doc) == sorted(UNFINISHED_JOB_STATUSES + FINISHED_JOB_STATUSES)
    assert _chunk_count(db, doc) == 1
    assert _document_row(db, doc)["status"] == "processing"


def test_capture_review_recovery_discards_unfinished_draft_jobs(tmp_path: Path) -> None:
    db = _database(tmp_path)
    doc = _attach_pdf(db, operation_id="upload")
    _seed_text_and_jobs(db, doc)
    with db.connect() as connection:
        connection.execute(
            """
            INSERT INTO capture_review_sessions(
                id, project_id, document_id, operation_id, runtime_capture_id, status,
                expires_at, created_at, updated_at
            )
            VALUES ('session', 'proj', ?, 'upload', NULL, 'pending',
                '2999-01-01T00:00:00Z', 't0', 't0')
            """,
            (doc,),
        )

    assert CaptureReviewMaintenanceAdapter(db, None, _operations(db)).recover() == ("session",)

    assert _job_statuses(db, doc) == sorted(FINISHED_JOB_STATUSES)
    assert _document_row(db, doc)["status"] == "canceled"


def test_source_library_refuses_work_for_a_missing_project(tmp_path: Path) -> None:
    db = _database(tmp_path)
    doc = _attach_pdf(db, operation_id="upload")
    operations = _operations(db)
    documents = _documents(db)

    attempts = [
        lambda: operations.claim("missing", "new-upload"),
        lambda: operations.claim_upload("missing", "new-upload"),
        lambda: operations.start_retry("missing", doc, "retry"),
        lambda: operations.cancel("missing", "upload"),
        lambda: operations.cancel_processing_of("missing", doc),
        lambda: documents.documents_of("missing"),
        lambda: documents.attach_document(
            "missing",
            "upload",
            filename="source.pdf",
            sha256="sha",
            language_hint="auto",
            storage_path="C:/data/source.pdf",
            page_count=1,
        ),
    ]
    for attempt in attempts:
        with pytest.raises(NotFoundError, match="^Project not found.$"):
            attempt()

    with db.connect() as connection:
        operations_rows = connection.execute(
            "SELECT id, status FROM document_operations ORDER BY id"
        ).fetchall()
        document_ids = connection.execute("SELECT id FROM documents").fetchall()
    assert [tuple(row) for row in operations_rows] == [("upload", "running")]
    assert [row["id"] for row in document_ids] == [doc]
    assert [document.id for document in documents.documents_of("proj")] == [doc]


@pytest.mark.parametrize(
    ("status", "has_text", "expected_status"),
    [
        ("ready", 1, "ready"),
        ("exam_failed", 1, "ready"),
        ("processing", 1, "processing"),
        ("ready", 0, "exam_failed"),
    ],
)
def test_a_committed_draft_job_records_the_document_exam_state(
    tmp_path: Path, status: str, has_text: int, expected_status: str
) -> None:
    db = _database(tmp_path)
    _ready_document(db, "doc", status=status, has_text=has_text)
    _ready_document(db, "other-doc")
    with db.connect() as connection:
        _draft(connection, "earlier-approved", "doc", status="approved")
        _draft(connection, "earlier-rejected", "doc", status="rejected")
        _draft(connection, "other-document-draft", "other-doc", status="approved")
    job = _committing_job(db, "doc")

    drafts_repository.append_generated_drafts_and_complete_job(
        db,
        exam_state=bind_document_exam_state(db),
        job_id=job.id,
        project_id="proj",
        document_id="doc",
        suggestions=[_suggestion("doc-chunk", "First?"), _suggestion("doc-chunk", "Second?")],
        effective_provider="future-provider",
        effective_model="qwen3.5:4b",
        fallback_reason=None,
        projects=authoring_projects(db),
    )

    document = _document_row(db, "doc")
    assert document["status"] == expected_status
    assert document["exam_item_count"] == 4
    assert document["updated_at"] != "t0"
    assert _document_row(db, "other-doc")["exam_item_count"] == 0
    assert draft_jobs.get_job(db, job.id).status == "succeeded"


def test_a_draft_job_without_new_drafts_still_counts_the_document_drafts(
    tmp_path: Path,
) -> None:
    db = _database(tmp_path)
    _ready_document(db, "doc", status="exam_failed")
    with db.connect() as connection:
        _draft(connection, "earlier", "doc", status="approved")
    job = _committing_job(db, "doc")

    drafts_repository.append_generated_drafts_and_complete_job(
        db,
        exam_state=bind_document_exam_state(db),
        job_id=job.id,
        project_id="proj",
        document_id="doc",
        suggestions=[],
        effective_provider=None,
        effective_model=None,
        fallback_reason=None,
        projects=authoring_projects(db),
    )

    document = _document_row(db, "doc")
    assert document["status"] == "ready"
    assert document["exam_item_count"] == 1


@pytest.mark.parametrize(
    ("status", "has_text", "expected_status"),
    [
        ("ready", 1, "ready"),
        ("exam_failed", 0, "ready"),
        ("processing", 1, "processing"),
    ],
)
def test_a_committed_manual_operation_records_the_document_exam_state(
    tmp_path: Path, status: str, has_text: int, expected_status: str
) -> None:
    db = _database(tmp_path)
    _ready_document(db, "doc", status=status, has_text=has_text)
    with db.connect() as connection:
        _draft(connection, "earlier", "doc", status="rejected")
    operation = _committing_manual_operation(db, "doc")

    drafts_repository.append_generated_drafts_and_complete_manual_operation(
        db,
        exam_state=bind_document_exam_state(db),
        operation_id=operation.id,
        project_id="proj",
        document_id="doc",
        suggestions=[_suggestion("doc-chunk", "First?")],
        effective_provider="future-provider",
        effective_model="qwen3.5:4b",
        fallback_reason=None,
        projects=authoring_projects(db),
    )

    document = _document_row(db, "doc")
    assert document["status"] == expected_status
    assert document["exam_item_count"] == 2
    assert (
        manual_operations.get_operation(
            db, project_id="proj", document_id="doc", operation_id=operation.id
        ).status
        == "succeeded"
    )


@pytest.mark.parametrize("kind", ["job", "manual"])
def test_the_document_exam_state_rolls_back_with_the_draft_commit(
    tmp_path: Path, kind: str
) -> None:
    db = _database(tmp_path)
    _ready_document(db, "doc", status="exam_failed")
    if kind == "job":
        job = draft_jobs.enqueue_chunk_job(
            db,
            project_id="proj",
            document_id="doc",
            chunk_id="doc-chunk",
            page_number=1,
            strategy="hybrid_reasoning",
            provider="future-provider",
            model="qwen3.5:4b",
            projects=authoring_projects(db),
            sources=SourceLibraryDraftSources(document_repository(db)),
        )
        with pytest.raises(NotFoundError, match="atomic commit phase"):
            drafts_repository.append_generated_drafts_and_complete_job(
                db,
                exam_state=bind_document_exam_state(db),
                job_id=job.id,
                project_id="proj",
                document_id="doc",
                suggestions=[_suggestion("doc-chunk", "First?")],
                effective_provider=None,
                effective_model=None,
                fallback_reason=None,
                projects=authoring_projects(db),
            )
    else:
        operation = manual_operations.create_operation(
            db,
            project_id="proj",
            document_id="doc",
            limit=1,
            strategy="hybrid_reasoning",
            provider="future-provider",
            model="qwen3.5:4b",
            projects=authoring_projects(db),
            documents=authoring_documents(db),
        )
        with pytest.raises(NotFoundError):
            drafts_repository.append_generated_drafts_and_complete_manual_operation(
                db,
                exam_state=bind_document_exam_state(db),
                operation_id=operation.id,
                project_id="proj",
                document_id="doc",
                suggestions=[_suggestion("doc-chunk", "First?")],
                effective_provider=None,
                effective_model=None,
                fallback_reason=None,
                projects=authoring_projects(db),
            )

    document = _document_row(db, "doc")
    assert document["status"] == "exam_failed"
    assert document["exam_item_count"] == 0
    assert document["updated_at"] == "t0"
    assert drafts_repository.list_drafts(db, "proj", projects=authoring_projects(db)) == []


def _operations(db: Database) -> SqliteDocumentOperationRepository:
    return document_operation_repository(db)


def _documents(db: Database) -> SqliteDocumentRepository:
    return document_repository(db)


def _database(tmp_path: Path) -> Database:
    db = Database(Settings(data_dir=tmp_path, api_token="test-token"))
    db.migrate()
    with db.connect() as connection:
        connection.execute(
            """
            INSERT INTO projects(id, name, description, created_at, updated_at)
            VALUES ('proj', 'Study', '', 't0', 't0')
            """
        )
    return db


def _attach_pdf(db: Database, *, operation_id: str) -> str:
    assert _operations(db).claim_upload("proj", operation_id)
    document = _documents(db).attach_document(
        "proj",
        operation_id,
        filename="source.pdf",
        sha256="sha",
        language_hint="auto",
        storage_path="C:/data/source.pdf",
        page_count=1,
    )
    return document.id


def _attach_audio(db: Database, *, operation_id: str) -> str:
    assert _operations(db).claim_upload("proj", operation_id)
    document = _documents(db).attach_document(
        "proj",
        operation_id,
        filename="source.wav",
        sha256="audio-sha",
        language_hint="ja",
        storage_path="C:/data/source.wav",
        page_count=0,
        source_kind="audio",
        duration_ms=1000,
    )
    return document.id


def _ready_document(
    db: Database, document_id: str, *, status: str = "ready", has_text: int = 1
) -> None:
    with db.connect() as connection:
        connection.execute(
            """
            INSERT INTO documents(
                id, project_id, filename, sha256, storage_path,
                page_count, has_text, status, created_at, updated_at
            )
            VALUES (?, 'proj', 'notes.pdf', 'hash', 'notes.pdf', 1, ?, ?, 't0', 't0')
            """,
            (document_id, has_text, status),
        )
        _chunk(connection, document_id)


def _seed_text_and_jobs(
    db: Database, document_id: str, *, attach: bool = False, locator_kind: str = "page"
) -> None:
    """One chunk and a draft job in every unfinished and several finished states."""

    if attach:
        _ready_document(db, document_id, status="processing")
    with db.connect() as connection:
        if not attach:
            _chunk(connection, document_id, locator_kind=locator_kind)
            connection.execute(
                "UPDATE documents SET has_text = 1, exam_item_count = 3 WHERE id = ?",
                (document_id,),
            )
        for status in UNFINISHED_JOB_STATUSES + FINISHED_JOB_STATUSES:
            connection.execute(
                """
                INSERT INTO draft_generation_jobs(
                    id, project_id, document_id, chunk_id, source_chunk_id,
                    page_number, strategy, status, provider, model,
                    created_at, updated_at
                )
                VALUES (?, 'proj', ?, ?, ?, 1, ?, ?, 'future-provider', 'qwen3.5:4b',
                    't0', 't0')
                """,
                (
                    f"{document_id}-{status}",
                    document_id,
                    f"{document_id}-chunk",
                    f"{document_id}-chunk",
                    f"strategy-{status}",
                    status,
                ),
            )


def _chunk(connection: Connection, document_id: str, *, locator_kind: str = "page") -> None:
    connection.execute(
        """
        INSERT INTO document_chunks(
            id, project_id, document_id, page_number, chunk_index,
            text, source_excerpt, created_at, locator_kind
        )
        VALUES (?, 'proj', ?, 1, 0, 'source text', 'source text', 't0', ?)
        """,
        (f"{document_id}-chunk", document_id, locator_kind),
    )


def _draft(connection: Connection, draft_id: str, document_id: str, *, status: str) -> None:
    connection.execute(
        """
        INSERT INTO question_drafts(
            id, project_id, document_id, question, choices_json, answer,
            rationale, citation_page, source_excerpt, status, created_at, updated_at
        )
        VALUES (?, 'proj', ?, ?, '["A", "B"]', 'A', 'Because', 1, 'excerpt', ?, 't0', 't0')
        """,
        (draft_id, document_id, draft_id, status),
    )


def _committing_job(db: Database, document_id: str):
    job = draft_jobs.enqueue_chunk_job(
        db,
        project_id="proj",
        document_id=document_id,
        chunk_id=f"{document_id}-chunk",
        page_number=1,
        strategy="hybrid_reasoning",
        provider="future-provider",
        model="qwen3.5:4b",
        projects=authoring_projects(db),
        sources=SourceLibraryDraftSources(document_repository(db)),
    )
    draft_jobs.mark_running(db, job.id)
    draft_jobs.begin_commit(db, job.id)
    return job


def _committing_manual_operation(db: Database, document_id: str):
    operation = manual_operations.create_operation(
        db,
        project_id="proj",
        document_id=document_id,
        limit=1,
        strategy="hybrid_reasoning",
        provider="future-provider",
        model="qwen3.5:4b",
        projects=authoring_projects(db),
        documents=authoring_documents(db),
    )
    manual_operations.mark_running(db, operation.id)
    manual_operations.begin_commit(db, operation.id)
    return operation


def _suggestion(chunk_id: str, question: str) -> DraftSuggestion:
    return DraftSuggestion(
        chunk_id=chunk_id,
        question=question,
        choices=["A correct", "B wrong"],
        answer="A correct",
        answer_key_source="ai_inferred",
        rationale="The cited source identifies A.",
        citation_page=1,
        source_excerpt="source text",
    )


def _job_statuses(db: Database, document_id: str) -> list[str]:
    with db.connect() as connection:
        rows = connection.execute(
            "SELECT status FROM draft_generation_jobs WHERE document_id = ? ORDER BY status",
            (document_id,),
        ).fetchall()
    return [row["status"] for row in rows]


def _chunk_count(db: Database, document_id: str) -> int:
    with db.connect() as connection:
        return connection.execute(
            "SELECT COUNT(*) FROM document_chunks WHERE document_id = ?", (document_id,)
        ).fetchone()[0]


def _document_row(db: Database, document_id: str) -> sqlite3.Row:
    with db.connect() as connection:
        row = connection.execute(
            "SELECT * FROM documents WHERE id = ?", (document_id,)
        ).fetchone()
    assert row is not None
    return row
