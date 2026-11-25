"""Today's results of the Source Library and Question Authoring writes that cross into each
other's tables, and of Source Library's project checks.

Stopping or retrying a source's run discards that source's unfinished question generation
jobs in the same transaction. Committing generated questions records the source's exam item
count and status in the same transaction as the questions and the job or operation.

The writes now go through the owning context's use cases on the caller's connection, and the
project checks through Study Projects; bootstrap wires them as the app does.
"""

from __future__ import annotations

from pathlib import Path
import sqlite3
from sqlite3 import Connection

import pytest

from cert_prep_backend.authoring.domain.models import QuestionSuggestion
from cert_prep_backend.authoring.domain.question import NewQuestion
from cert_prep_backend.authoring.infrastructure import question_generation_jobs
from cert_prep_backend.authoring.infrastructure import manual_operations
from cert_prep_backend.authoring.infrastructure import repository as questions_repository
from cert_prep_backend.authoring.infrastructure.sources import SourceLibraryQuestionSources
from cert_prep_backend.bootstrap.authoring_links import (
    SourceLibraryQuestionCount,
    authoring_sources,
    bind_source_question_count,
    question_repository,
)
from cert_prep_backend.bootstrap.source_library_links import (
    source_operation_repository,
    source_repository,
)
from cert_prep_backend.bootstrap.study_projects import authoring_projects
from cert_prep_backend.capture_integration.infrastructure.review_workflow import (
    CaptureReviewMaintenanceAdapter,
)
from cert_prep_backend.platform.config import Settings
from cert_prep_backend.platform.database import Database
from cert_prep_backend.platform.errors import NotFoundError
from cert_prep_backend.source_library.domain.source import NO_TEXT_DETECTED_MESSAGE
from cert_prep_backend.source_library.infrastructure.repository import (
    SqliteSourceOperationRepository,
    SqliteSourceRepository,
)

UNFINISHED_JOB_STATUSES = ("pending", "running", "cancel_requested")
FINISHED_JOB_STATUSES = ("succeeded", "failed", "canceled", "skipped_missing_model")


def test_a_failed_run_discards_unfinished_question_jobs_and_keeps_finished_ones(
    tmp_path: Path,
) -> None:
    db = _database(tmp_path)
    source_id = _attach_pdf(db, operation_id="upload")
    _seed_text_and_jobs(db, source_id)
    _seed_text_and_jobs(db, "other-doc", attach=True)

    failed = _operations(db).fail("proj", "upload", error="OCR failed.")

    assert failed.status == "failed"
    assert _job_statuses(db, source_id) == sorted(FINISHED_JOB_STATUSES)
    assert _job_statuses(db, "other-doc") == sorted(
        UNFINISHED_JOB_STATUSES + FINISHED_JOB_STATUSES
    )
    assert _chunk_count(db, source_id) == 0
    source = _source_row(db, source_id)
    assert source["has_text"] == 0
    # The questions outlive the run's text, so the source still counts them.
    assert source["question_count"] == 3


def test_a_retry_discards_unfinished_question_jobs(tmp_path: Path) -> None:
    db = _database(tmp_path)
    source_id = _attach_pdf(db, operation_id="upload")
    _operations(db).fail("proj", "upload", error="OCR failed.")
    _seed_text_and_jobs(db, source_id)

    retry = _operations(db).start_retry("proj", source_id, "retry")

    assert retry.status == "running"
    assert _job_statuses(db, source_id) == sorted(FINISHED_JOB_STATUSES)
    assert _chunk_count(db, source_id) == 0
    assert _source_row(db, source_id)["status"] == "processing"


def test_recovery_discards_unfinished_question_jobs_of_interrupted_runs(tmp_path: Path) -> None:
    db = _database(tmp_path)
    source_id = _attach_pdf(db, operation_id="upload")
    _seed_text_and_jobs(db, source_id)

    assert _operations(db).recover_interrupted() == 1

    assert _job_statuses(db, source_id) == sorted(FINISHED_JOB_STATUSES)
    assert _source_row(db, source_id)["status"] == "extraction_failed"


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
    source = _source_row(db, audio)
    assert source["status"] == expected_status
    assert source["question_count"] == 3
    assert source["extraction_warnings"] is None
    assert source["failure_message"] == (
        "Transcription failed." if stop == "fail" else None
    )


@pytest.mark.parametrize(
    ("status", "expected_failure"),
    [
        ("ready", None),
        ("no_text_detected", "earlier failure"),
        ("processing", "earlier failure"),
    ],
)
def test_the_question_count_clears_the_failure_message_when_ready_and_keeps_it_otherwise(
    tmp_path: Path, status: str, expected_failure: str | None
) -> None:
    db = _database(tmp_path)
    _ready_source(db, "doc", status="no_text_detected")
    with db.connect() as connection:
        connection.execute(
            """
            UPDATE sources SET extraction_warnings = 'kept warning',
                failure_message = 'earlier failure'
            WHERE id = 'doc'
            """
        )
        source_repository(db, connection).record_question_count(
            "proj", "doc", status=status, question_count=2
        )

    source = _source_row(db, "doc")
    assert source["status"] == status
    assert source["question_count"] == 2
    assert source["extraction_warnings"] == "kept warning"
    assert source["failure_message"] == expected_failure


def test_a_source_that_ends_without_text_gets_the_no_text_reason_and_keeps_its_warnings(
    tmp_path: Path,
) -> None:
    db = _database(tmp_path)
    _ready_source(db, "warned", status="ready")
    with db.connect() as connection:
        connection.execute(
            "UPDATE sources SET extraction_warnings = 'page 2 is blank' WHERE id = 'warned'"
        )
        source_repository(db, connection).record_question_count(
            "proj", "warned", status="no_text_detected", question_count=0
        )

    warned = _source_row(db, "warned")
    assert warned["status"] == "no_text_detected"
    assert warned["extraction_warnings"] == "page 2 is blank"
    assert warned["failure_message"] == NO_TEXT_DETECTED_MESSAGE


def test_an_authored_question_count_needs_the_transaction_of_its_question(
    tmp_path: Path,
) -> None:
    db = _database(tmp_path)
    _ready_source(db, "reef", status="ready")
    before = dict(_source_row(db, "reef"))

    with pytest.raises(RuntimeError, match="joins the transaction that stores the question"):
        _sources(db).record_authored_question_count("proj", "reef", question_count=3)

    assert dict(_source_row(db, "reef")) == before


def test_the_job_cleanup_rolls_back_with_the_run_it_belongs_to(tmp_path: Path) -> None:
    db = _database(tmp_path)
    source_id = _attach_pdf(db, operation_id="upload")
    _seed_text_and_jobs(db, source_id)
    with db.connect() as connection:
        connection.execute(
            """
            CREATE TRIGGER reject_operation_stop
            BEFORE UPDATE OF status ON source_operations
            WHEN NEW.status = 'failed'
            BEGIN
                SELECT RAISE(ABORT, 'operation stop rejected');
            END;
            """
        )

    with pytest.raises(sqlite3.IntegrityError, match="operation stop rejected"):
        _operations(db).fail("proj", "upload", error="OCR failed.")

    assert _job_statuses(db, source_id) == sorted(UNFINISHED_JOB_STATUSES + FINISHED_JOB_STATUSES)
    assert _chunk_count(db, source_id) == 1
    assert _source_row(db, source_id)["status"] == "processing"


def test_capture_review_recovery_discards_unfinished_question_jobs(tmp_path: Path) -> None:
    db = _database(tmp_path)
    source_id = _attach_pdf(db, operation_id="upload")
    _seed_text_and_jobs(db, source_id)
    with db.connect() as connection:
        connection.execute(
            """
            INSERT INTO capture_review_sessions(
                id, project_id, source_id, operation_id, runtime_capture_id, status,
                expires_at, created_at, updated_at
            )
            VALUES ('session', 'proj', ?, 'upload', NULL, 'pending',
                '2999-01-01T00:00:00Z', 't0', 't0')
            """,
            (source_id,),
        )

    assert CaptureReviewMaintenanceAdapter(db, None, _operations(db)).recover() == ("session",)

    assert _job_statuses(db, source_id) == sorted(FINISHED_JOB_STATUSES)
    assert _source_row(db, source_id)["status"] == "canceled"


def test_source_library_refuses_work_for_a_missing_project(tmp_path: Path) -> None:
    db = _database(tmp_path)
    source_id = _attach_pdf(db, operation_id="upload")
    operations = _operations(db)
    sources = _sources(db)

    attempts = [
        lambda: operations.claim("missing", "new-upload"),
        lambda: operations.claim_upload("missing", "new-upload"),
        lambda: operations.start_retry("missing", source_id, "retry"),
        lambda: operations.cancel("missing", "upload"),
        lambda: operations.cancel_processing_of("missing", source_id),
        lambda: sources.sources_of("missing"),
        lambda: sources.attach_source(
            "missing",
            "upload",
            filename="source.pdf",
            source_kind="pdf",
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
            "SELECT id, status FROM source_operations ORDER BY id"
        ).fetchall()
        source_ids = connection.execute("SELECT id FROM sources").fetchall()
    assert [tuple(row) for row in operations_rows] == [("upload", "running")]
    assert [row["id"] for row in source_ids] == [source_id]
    assert [source.id for source in sources.sources_of("proj")] == [source_id]


@pytest.mark.parametrize(
    ("status", "has_text", "expected_status"),
    [
        ("ready", 1, "ready"),
        ("no_text_detected", 1, "ready"),
        ("processing", 1, "processing"),
        ("ready", 0, "no_text_detected"),
    ],
)
def test_a_committed_question_job_records_the_source_question_count(
    tmp_path: Path, status: str, has_text: int, expected_status: str
) -> None:
    db = _database(tmp_path)
    _ready_source(db, "doc", status=status, has_text=has_text)
    _ready_source(db, "other-doc")
    with db.connect() as connection:
        _question(connection, "earlier-first", "doc")
        _question(connection, "earlier-second", "doc")
        _question(connection, "other-document-authored_question", "other-doc")
    job = _committing_job(db, "doc")

    questions_repository.append_generated_questions_and_complete_job(
        db,
        question_count=bind_source_question_count(db),
        job_id=job.id,
        project_id="proj",
        source_id="doc",
        suggestions=[_suggestion("doc-chunk", "First?"), _suggestion("doc-chunk", "Second?")],
        effective_provider="future-provider",
        effective_model="qwen3.5:4b",
        fallback_reason=None,
        projects=authoring_projects(db),
    )

    source = _source_row(db, "doc")
    assert source["status"] == expected_status
    assert source["question_count"] == 4
    assert source["updated_at"] != "t0"
    assert _source_row(db, "other-doc")["question_count"] == 0
    assert question_generation_jobs.get_job(db, job.id).status == "succeeded"


def test_a_question_job_without_new_questions_still_counts_the_source_questions(
    tmp_path: Path,
) -> None:
    db = _database(tmp_path)
    _ready_source(db, "doc", status="no_text_detected")
    with db.connect() as connection:
        _question(connection, "earlier", "doc")
    job = _committing_job(db, "doc")

    questions_repository.append_generated_questions_and_complete_job(
        db,
        question_count=bind_source_question_count(db),
        job_id=job.id,
        project_id="proj",
        source_id="doc",
        suggestions=[],
        effective_provider=None,
        effective_model=None,
        fallback_reason=None,
        projects=authoring_projects(db),
    )

    source = _source_row(db, "doc")
    assert source["status"] == "ready"
    assert source["question_count"] == 1


@pytest.mark.parametrize(
    ("status", "has_text", "expected_status"),
    [
        ("ready", 1, "ready"),
        ("no_text_detected", 0, "ready"),
        ("processing", 1, "processing"),
    ],
)
def test_a_committed_manual_operation_records_the_source_question_count(
    tmp_path: Path, status: str, has_text: int, expected_status: str
) -> None:
    db = _database(tmp_path)
    _ready_source(db, "doc", status=status, has_text=has_text)
    with db.connect() as connection:
        _question(connection, "earlier", "doc")
    operation = _committing_manual_operation(db, "doc")

    questions_repository.append_generated_questions_and_complete_manual_operation(
        db,
        question_count=bind_source_question_count(db),
        operation_id=operation.id,
        project_id="proj",
        source_id="doc",
        suggestions=[_suggestion("doc-chunk", "First?")],
        effective_provider="future-provider",
        effective_model="qwen3.5:4b",
        fallback_reason=None,
        projects=authoring_projects(db),
    )

    source = _source_row(db, "doc")
    assert source["status"] == expected_status
    assert source["question_count"] == 2
    assert (
        manual_operations.get_operation(
            db, project_id="proj", source_id="doc", operation_id=operation.id
        ).status
        == "succeeded"
    )


@pytest.mark.parametrize("kind", ["job", "manual"])
def test_the_source_question_count_rolls_back_with_the_question_commit(
    tmp_path: Path, kind: str
) -> None:
    db = _database(tmp_path)
    _ready_source(db, "doc", status="no_text_detected")
    if kind == "job":
        job = question_generation_jobs.enqueue_chunk_job(
            db,
            project_id="proj",
            source_id="doc",
            chunk_id="doc-chunk",
            page_number=1,
            strategy="hybrid_reasoning",
            provider="future-provider",
            model="qwen3.5:4b",
            projects=authoring_projects(db),
            sources=SourceLibraryQuestionSources(source_repository(db)),
        )
        with pytest.raises(NotFoundError, match="atomic commit phase"):
            questions_repository.append_generated_questions_and_complete_job(
                db,
                question_count=bind_source_question_count(db),
                job_id=job.id,
                project_id="proj",
                source_id="doc",
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
            source_id="doc",
            limit=1,
            strategy="hybrid_reasoning",
            provider="future-provider",
            model="qwen3.5:4b",
            projects=authoring_projects(db),
            sources=authoring_sources(db),
        )
        with pytest.raises(NotFoundError):
            questions_repository.append_generated_questions_and_complete_manual_operation(
                db,
                question_count=bind_source_question_count(db),
                operation_id=operation.id,
                project_id="proj",
                source_id="doc",
                suggestions=[_suggestion("doc-chunk", "First?")],
                effective_provider=None,
                effective_model=None,
                fallback_reason=None,
                projects=authoring_projects(db),
            )

    source = _source_row(db, "doc")
    assert source["status"] == "no_text_detected"
    assert source["question_count"] == 0
    assert source["updated_at"] == "t0"
    assert questions_repository.list_questions(db, "proj", projects=authoring_projects(db)) == []


def test_a_hand_written_question_stores_the_source_question_count(tmp_path: Path) -> None:
    db = _database(tmp_path)
    _ready_source(db, "cove", status="extraction_failed")
    with db.connect() as connection:
        connection.execute(
            """
            UPDATE sources
            SET failure_message = 'The lantern scan stopped early.'
            WHERE id = 'cove'
            """
        )
        _question(connection, "earlier-lantern", "cove")
    before = dict(_source_row(db, "cove"))

    written = question_repository(db).write(
        "proj",
        NewQuestion(
            question="Which lantern marks the cove?",
            choices=("The red lantern", "The green lantern"),
            answer="The red lantern",
            rationale="The chart names the red lantern.",
            source_id="cove",
            chunk_id="cove-chunk",
        ),
    )

    assert written.question == "Which lantern marks the cove?"
    after = dict(_source_row(db, "cove"))
    assert after["question_count"] == 2
    before["question_count"] = 2
    assert after == before


def test_a_question_without_a_source_stores_no_question_count(tmp_path: Path) -> None:
    db = _database(tmp_path)
    _ready_source(db, "cove", status="extraction_failed")
    before = dict(_source_row(db, "cove"))

    def refuse(_connection: Connection) -> object:
        raise RuntimeError("The cove count must stay unwritten.")

    written = questions_repository.create_question(
        db,
        "proj",
        NewQuestion(question="Which lantern marks the cove?"),
        projects=authoring_projects(db),
        sources=SourceLibraryQuestionSources(source_repository(db)),
        question_count=refuse,
    )

    assert written.source_id is None
    assert dict(_source_row(db, "cove")) == before
    assert (
        questions_repository.list_questions(db, "proj", projects=authoring_projects(db))
        == [written]
    )


def test_a_failed_question_count_does_not_store_the_hand_written_question(
    tmp_path: Path,
) -> None:
    db = _database(tmp_path)
    _ready_source(db, "cove", status="extraction_failed")
    with db.connect() as connection:
        connection.execute(
            """
            UPDATE sources
            SET failure_message = 'The lantern scan stopped early.'
            WHERE id = 'cove'
            """
        )
    before = dict(_source_row(db, "cove"))

    class Raiser:
        def record_authored_question_count(
            self, project_id: str, source_id: str, count: int
        ) -> None:
            raise RuntimeError("The cove count could not be stored.")

    def bind(_connection: Connection) -> Raiser:
        return Raiser()

    with pytest.raises(RuntimeError, match="The cove count could not be stored."):
        questions_repository.create_question(
            db,
            "proj",
            NewQuestion(
                question="Which lantern marks the cove?",
                source_id="cove",
                chunk_id="cove-chunk",
            ),
            projects=authoring_projects(db),
            sources=SourceLibraryQuestionSources(source_repository(db)),
            question_count=bind,
        )

    assert questions_repository.list_questions(db, "proj", projects=authoring_projects(db)) == []
    assert dict(_source_row(db, "cove")) == before


@pytest.mark.parametrize(
    "write",
    [
        questions_repository.SqliteQuestionRepository.append_generated_questions_and_record_count,
        questions_repository.SqliteQuestionRepository.append_import_questions_and_record_count,
    ],
)
def test_a_failed_question_count_rolls_back_synchronously_generated_questions(
    tmp_path: Path, write
) -> None:
    db = _database(tmp_path)
    _ready_source(db, "cove")
    suggestions = [_suggestion("cove-chunk", "Which lantern marks the cove?")]
    question_repository(db).append_generated_questions_and_record_count("proj", "cove", suggestions)
    before = dict(_source_row(db, "cove"))
    assert before["question_count"] == 1

    class FailingQuestionCount(SourceLibraryQuestionCount):
        def record_question_count(self, project_id: str, source_id: str, count: int) -> None:
            super().record_question_count(project_id, source_id, count)
            assert count == 2
            raise RuntimeError("The cove count could not be stored.")

        def record_import_question_count(self, project_id: str, source_id: str, count: int) -> None:
            super().record_import_question_count(project_id, source_id, count)
            assert count == 2
            raise RuntimeError("The cove count could not be stored.")

    def bind(connection: Connection) -> FailingQuestionCount:
        return FailingQuestionCount(source_repository(db, connection))

    repository = questions_repository.SqliteQuestionRepository(
        db,
        projects=authoring_projects(db),
        sources=SourceLibraryQuestionSources(source_repository(db)),
        question_count=bind,
    )
    with pytest.raises(RuntimeError, match="The cove count could not be stored"):
        write(repository, "proj", "cove", [_suggestion("cove-chunk", "Which boat is moored?")])

    assert [
        question.question for question in repository.for_source("proj", source_id="cove")
    ] == [suggestions[0].question]
    assert dict(_source_row(db, "cove")) == before


def test_synchronous_generation_keeps_a_processing_source_processing(tmp_path: Path) -> None:
    db = _database(tmp_path)
    _ready_source(db, "cove", status="processing")

    question_repository(db).append_generated_questions_and_record_count(
        "proj", "cove", [_suggestion("cove-chunk", "Which lantern marks the cove?")]
    )

    source = _source_row(db, "cove")
    assert source["status"] == "processing"
    assert source["question_count"] == 1


def test_import_generation_without_suggestions_records_the_no_text_status(tmp_path: Path) -> None:
    db = _database(tmp_path)
    _ready_source(db, "cove", has_text=0)
    with db.connect() as connection:
        _question(connection, "existing", "cove")

    created = question_repository(db).append_import_questions_and_record_count("proj", "cove", [])

    assert created == []
    source = _source_row(db, "cove")
    assert source["status"] == "no_text_detected"
    assert source["question_count"] == 1


def _operations(db: Database) -> SqliteSourceOperationRepository:
    return source_operation_repository(db)


def _sources(db: Database) -> SqliteSourceRepository:
    return source_repository(db)


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
    source = _sources(db).attach_source(
        "proj",
        operation_id,
        filename="source.pdf",
        source_kind="pdf",
        sha256="sha",
        language_hint="auto",
        storage_path="C:/data/source.pdf",
        page_count=1,
    )
    return source.id


def _attach_audio(db: Database, *, operation_id: str) -> str:
    assert _operations(db).claim_upload("proj", operation_id)
    source = _sources(db).attach_source(
        "proj",
        operation_id,
        filename="source.wav",
        sha256="audio-sha",
        language_hint="ja",
        storage_path="C:/data/source.wav",
        page_count=0,
        source_kind="recording",
        duration_ms=1000,
    )
    return source.id


def _ready_source(
    db: Database, source_id: str, *, status: str = "ready", has_text: int = 1
) -> None:
    with db.connect() as connection:
        connection.execute(
            """
            INSERT INTO sources(
                id, project_id, filename, sha256, storage_path,
                page_count, has_text, status, created_at, updated_at, source_kind
            )
            VALUES (?, 'proj', 'notes.pdf', 'hash', 'notes.pdf', 1, ?, ?, 't0', 't0', 'pdf')
            """,
            (source_id, has_text, status),
        )
        _chunk(connection, source_id)


def _seed_text_and_jobs(
    db: Database, source_id: str, *, attach: bool = False, locator_kind: str = "page"
) -> None:
    """One chunk, three questions and a question job in every unfinished and several finished
    states."""

    if attach:
        _ready_source(db, source_id, status="processing")
    with db.connect() as connection:
        if not attach:
            _chunk(connection, source_id, locator_kind=locator_kind)
            for number in range(3):
                _question(connection, f"{source_id}-question-{number}", source_id)
            connection.execute(
                "UPDATE sources SET has_text = 1, question_count = 3 WHERE id = ?",
                (source_id,),
            )
        for status in UNFINISHED_JOB_STATUSES + FINISHED_JOB_STATUSES:
            connection.execute(
                """
                INSERT INTO question_generation_jobs(
                    id, project_id, source_id, chunk_id, source_chunk_id,
                    page_number, strategy, status, provider, model,
                    created_at, updated_at
                )
                VALUES (?, 'proj', ?, ?, ?, 1, ?, ?, 'future-provider', 'qwen3.5:4b',
                    't0', 't0')
                """,
                (
                    f"{source_id}-{status}",
                    source_id,
                    f"{source_id}-chunk",
                    f"{source_id}-chunk",
                    f"strategy-{status}",
                    status,
                ),
            )


def _chunk(connection: Connection, source_id: str, *, locator_kind: str = "page") -> None:
    connection.execute(
        """
        INSERT INTO source_chunks(
            id, project_id, source_id, page_number, chunk_index,
            text, source_excerpt, created_at, locator_kind
        )
        VALUES (?, 'proj', ?, 1, 0, 'source text', 'source text', 't0', ?)
        """,
        (f"{source_id}-chunk", source_id, locator_kind),
    )


def _question(connection: Connection, question_id: str, source_id: str) -> None:
    connection.execute(
        """
        INSERT INTO questions(
            id, project_id, source_id, question, choices_json, answer,
            rationale, citation_page, source_excerpt, created_at, updated_at
        )
        VALUES (?, 'proj', ?, ?, '["A", "B"]', 'A', 'Because', 1, 'excerpt', 't0', 't0')
        """,
        (question_id, source_id, question_id),
    )


def _committing_job(db: Database, source_id: str):
    job = question_generation_jobs.enqueue_chunk_job(
        db,
        project_id="proj",
        source_id=source_id,
        chunk_id=f"{source_id}-chunk",
        page_number=1,
        strategy="hybrid_reasoning",
        provider="future-provider",
        model="qwen3.5:4b",
        projects=authoring_projects(db),
        sources=SourceLibraryQuestionSources(source_repository(db)),
    )
    question_generation_jobs.mark_running(db, job.id)
    question_generation_jobs.begin_commit(db, job.id)
    return job


def _committing_manual_operation(db: Database, source_id: str):
    operation = manual_operations.create_operation(
        db,
        project_id="proj",
        source_id=source_id,
        limit=1,
        strategy="hybrid_reasoning",
        provider="future-provider",
        model="qwen3.5:4b",
        projects=authoring_projects(db),
        sources=authoring_sources(db),
    )
    manual_operations.mark_running(db, operation.id)
    manual_operations.begin_commit(db, operation.id)
    return operation


def _suggestion(chunk_id: str, question: str) -> QuestionSuggestion:
    return QuestionSuggestion(
        chunk_id=chunk_id,
        question=question,
        choices=["A correct", "B wrong"],
        answer="A correct",
        answer_key_source="ai_inferred",
        rationale="The cited source identifies A.",
        citation_page=1,
        source_excerpt="source text",
    )


def _job_statuses(db: Database, source_id: str) -> list[str]:
    with db.connect() as connection:
        rows = connection.execute(
            "SELECT status FROM question_generation_jobs WHERE source_id = ? ORDER BY status",
            (source_id,),
        ).fetchall()
    return [row["status"] for row in rows]


def _chunk_count(db: Database, source_id: str) -> int:
    with db.connect() as connection:
        return connection.execute(
            "SELECT COUNT(*) FROM source_chunks WHERE source_id = ?", (source_id,)
        ).fetchone()[0]


def _source_row(db: Database, source_id: str) -> sqlite3.Row:
    with db.connect() as connection:
        row = connection.execute(
            "SELECT * FROM sources WHERE id = ?", (source_id,)
        ).fetchone()
    assert row is not None
    return row
