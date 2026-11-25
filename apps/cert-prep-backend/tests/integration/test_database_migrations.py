from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

import pytest

from cert_prep_backend.platform.config import Settings
from cert_prep_backend.source_library.infrastructure import chunks as chunk_repository
from cert_prep_backend.platform import database as database_module
from cert_prep_backend.platform.database import MIGRATIONS, Database


# Text only Capture Runtime could have written; migration 30 must not keep it.
RUNTIME_TEXT = "worker exited 3221225477 while reading page 2 of C:/scans/notes.pdf"
# A reason Cert wrote itself; migration 30 keeps it.
INTERRUPTED_TEXT = "Parsing was interrupted before completion."
# Two reasons earlier releases of Cert wrote; migration 30 keeps them too.
REQUIREMENTS_TEXT = "Capture Runtime extraction requirements are unavailable."
ASSETS_TEXT = (
    "Capture Runtime extraction assets are unavailable. Install the required WindowsML or "
    "Whisper asset in Runtime setup, then retry."
)

# Migration 30 drops these document columns.
RETIRED_DOCUMENT_COLUMNS = frozenset(
    {
        "ocr_fallback_reason",
        "ocr_duration_ms",
        "parse_wall_duration_ms",
        "render_duration_ms",
        "ocr_engine_duration_ms",
        "ocr_worker_count",
        "first_chunk_ms",
    }
)

def test_saved_exam_runtime_metadata_columns_are_migrated(tmp_path: Path) -> None:
    db = Database(Settings(data_dir=tmp_path, api_token="test-token"))
    db.migrate()

    with db.connect() as connection:
        document_columns = _columns(connection, "documents")
        chunk_columns = _columns(connection, "document_chunks")
        draft_columns = _columns(connection, "question_drafts")
        draft_job_columns = _columns(connection, "draft_generation_jobs")
        manual_draft_operation_columns = _columns(
            connection,
            "manual_draft_generation_operations",
        )
        session_columns = _columns(connection, "practice_sessions")
        session_question_columns = _columns(connection, "practice_session_questions")
        document_operation_columns = _columns(connection, "document_operations")
        runtime_installation_columns = _columns(
            connection,
            "runtime_installation_jobs",
        )
        capture_review_columns = _columns(connection, "capture_review_sessions")

    assert document_columns["extraction_provenance"] is None
    assert capture_review_columns["runtime_ingestion_id"] is None
    assert document_columns["content_profile"] == "'unknown'"
    assert "classification_detail" in document_columns
    assert {"extraction_warnings", "failure_message"} <= set(document_columns)
    assert RETIRED_DOCUMENT_COLUMNS.isdisjoint(document_columns)
    assert document_columns["extraction_method"] == "'none'"
    assert chunk_columns["extraction_method"] == "'none'"
    assert {"raw_text", "line_start", "line_end", "line_count", "content_profile"} <= set(
        chunk_columns
    )
    assert {
        "source_order",
        "source_question_number",
        "item_kind",
        "group_key",
        "group_prompt",
        "confidence",
    } <= set(draft_columns)
    assert session_columns["mode"] == "'random_draw'"
    assert {
        "source_document_id",
        "requested_question_count",
        "random_seed",
        "abandoned_at",
    } <= set(session_columns)
    assert {
        "project_id",
        "document_id",
        "chunk_id",
        "page_number",
        "strategy",
        "status",
        "provider",
        "model",
        "generated_count",
        "retry_count",
        "last_error",
        "effective_provider",
        "effective_model",
        "fallback_reason",
        "phase",
        "cancellable",
    } <= set(draft_job_columns)
    assert {
        "project_id",
        "document_id",
        "limit_count",
        "strategy",
        "status",
        "phase",
        "cancellable",
        "provider",
        "model",
        "effective_provider",
        "effective_model",
        "fallback_reason",
        "generated_count",
        "unavailable_blocks_json",
        "error",
        "commit_started_at",
    } <= set(manual_draft_operation_columns)
    assert {
        "session_id",
        "project_id",
        "question_id",
        "question_order",
        "question",
        "choices_json",
        "correct_answer",
        "rationale",
        "citation_page",
        "source_excerpt",
        "created_at",
        "document_id",
    } <= set(session_question_columns)
    assert {
        "id",
        "project_id",
        "document_id",
        "status",
        "phase",
        "cancellable",
        "error",
        "created_at",
        "updated_at",
    } <= set(document_operation_columns)
    assert {
        "id",
        "kind",
        "provider",
        "model",
        "status",
        "phase",
        "cancellable",
        "detail",
        "completed",
        "total",
        "error",
        "created_at",
        "updated_at",
        "commit_started_at",
    } <= set(runtime_installation_columns)
    assert capture_review_columns["last_event_sequence"] == "0"


def test_failed_migration_rolls_back_schema_and_reopens_cleanly(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    settings = Settings(data_dir=tmp_path, api_token="test-token")
    failing_migrations = (
        (1, "CREATE TABLE atomic_probe (id INTEGER PRIMARY KEY);"),
        (
            2,
            """
            ALTER TABLE atomic_probe ADD COLUMN partial TEXT;
            SELECT * FROM table_that_does_not_exist;
            """,
        ),
    )
    monkeypatch.setattr(database_module, "MIGRATIONS", failing_migrations)

    with pytest.raises(sqlite3.OperationalError, match="table_that_does_not_exist"):
        Database(settings).migrate()

    with sqlite3.connect(settings.database_path) as connection:
        columns_after_failure = {
            row[1] for row in connection.execute("PRAGMA table_info(atomic_probe)")
        }
        versions_after_failure = [
            row[0]
            for row in connection.execute(
                "SELECT version FROM schema_migrations ORDER BY version"
            )
        ]
    assert columns_after_failure == {"id"}
    assert versions_after_failure == [1]

    repaired_migrations = (
        failing_migrations[0],
        (2, "ALTER TABLE atomic_probe ADD COLUMN stable TEXT;"),
    )
    monkeypatch.setattr(database_module, "MIGRATIONS", repaired_migrations)
    Database(settings).migrate()

    with sqlite3.connect(settings.database_path) as connection:
        columns_after_reopen = {
            row[1] for row in connection.execute("PRAGMA table_info(atomic_probe)")
        }
        versions_after_reopen = [
            row[0]
            for row in connection.execute(
                "SELECT version FROM schema_migrations ORDER BY version"
            )
        ]
    assert columns_after_reopen == {"id", "stable"}
    assert versions_after_reopen == [1, 2]


def test_practice_session_resume_migration_backfills_statuses_and_active_uniqueness(
    tmp_path: Path,
) -> None:
    settings = Settings(data_dir=tmp_path, api_token="test-token")
    _create_version_14_practice_database(settings.database_path)

    db = Database(settings)
    db.migrate()

    with db.connect() as connection:
        session_rows = {
            row["id"]: row
            for row in connection.execute(
                "SELECT * FROM practice_sessions ORDER BY project_id, created_at"
            ).fetchall()
        }
        index_rows = {
            row["name"]: row
            for row in connection.execute("PRAGMA index_list(practice_sessions)").fetchall()
        }

        assert session_rows["completed-by-coverage"]["status"] == "completed"
        assert (
            session_rows["completed-by-coverage"]["completed_at"]
            == "2026-07-01T00:02:00+00:00"
        )
        assert session_rows["completed-by-coverage"]["abandoned_at"] is None

        assert session_rows["preserved-completed"]["status"] == "completed"
        assert (
            session_rows["preserved-completed"]["completed_at"]
            == "2026-06-30T00:09:00+00:00"
        )

        assert session_rows["older-incomplete"]["status"] == "active"
        assert session_rows["older-incomplete"]["abandoned_at"] is None
        assert session_rows["latest-incomplete"]["status"] == "abandoned"
        assert session_rows["latest-incomplete"]["abandoned_at"] is not None
        assert session_rows["other-project-incomplete"]["status"] == "active"
        assert session_rows["other-project-incomplete"]["abandoned_at"] is None

        assert index_rows["idx_practice_sessions_one_active_per_project"]["unique"] == 1
        assert index_rows["idx_practice_sessions_one_active_per_project"]["partial"] == 1

        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO practice_sessions(
                    id, project_id, question_ids_json, status, mode,
                    requested_question_count, created_at
                )
                VALUES ('conflicting-active', 'project-1', '["q-1"]', 'active',
                    'random_draw', 1, '2026-07-02T00:00:00+00:00')
                """
            )


def test_migration_20_repairs_populated_v19_duplicate_active_operations(
    tmp_path: Path,
) -> None:
    settings = Settings(data_dir=tmp_path, api_token="test-token")
    _create_v19_duplicate_operation_fixture(settings.database_path)

    Database(settings).migrate()
    Database(settings).migrate()

    with sqlite3.connect(settings.database_path) as connection:
        connection.row_factory = sqlite3.Row
        operations = {
            row["id"]: row
            for row in connection.execute(
                "SELECT * FROM document_operations ORDER BY id"
            ).fetchall()
        }
        indexes = {
            row["name"]: row
            for row in connection.execute(
                "PRAGMA index_list(document_operations)"
            ).fetchall()
        }
        applied = connection.execute(
            "SELECT COUNT(*) FROM schema_migrations WHERE version = 20"
        ).fetchone()[0]
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO document_operations(
                    id, project_id, document_id, status, phase, cancellable,
                    created_at, updated_at
                )
                VALUES (
                    'post-migration-conflict', 'project', 'document', 'queued',
                    'queued', 1, '2026-01-06', '2026-01-06'
                )
                """
            )

    assert applied == 1
    active_index = indexes["idx_document_operations_one_active_document"]
    assert active_index["unique"] == 1
    assert active_index["partial"] == 1
    assert operations["cancel-requested"]["status"] == "cancel_requested"
    assert operations["cancel-requested"]["phase"] == "canceling"
    assert operations["cancel-requested"]["cancellable"] == 0
    for operation_id in ("queued-newest", "running-newer"):
        operation = operations[operation_id]
        assert (operation["status"], operation["phase"], operation["cancellable"]) == (
            "failed",
            "failed",
            0,
        )
        assert operation["error"] == (
            "Superseded while repairing duplicate active document operations."
        )
    assert (
        operations["terminal-history"]["status"],
        operations["terminal-history"]["error"],
    ) == ("succeeded", None)
    assert operations["unattached-a"]["status"] == "queued"
    assert operations["unattached-b"]["status"] == "running"
    assert operations["running-priority"]["status"] == "running"
    assert operations["queued-later"]["status"] == "failed"
    assert operations["tie-z"]["status"] == "running"
    assert operations["tie-a"]["status"] == "failed"


def test_migration_22_adds_nullable_commit_timestamps_without_rewriting_jobs(
    tmp_path: Path,
) -> None:
    settings = Settings(data_dir=tmp_path, api_token="test-token")
    _create_v21_commit_transition_fixture(settings.database_path)

    Database(settings).migrate()
    Database(settings).migrate()

    with sqlite3.connect(settings.database_path) as connection:
        connection.row_factory = sqlite3.Row
        manual_columns = _columns(
            connection,
            "manual_draft_generation_operations",
        )
        runtime_columns = _columns(connection, "runtime_installation_jobs")
        manual = connection.execute(
            "SELECT * FROM manual_draft_generation_operations WHERE id = 'manual-job'"
        ).fetchone()
        runtime = connection.execute(
            "SELECT * FROM runtime_installation_jobs WHERE id = 'runtime-job'"
        ).fetchone()
        applied = connection.execute(
            "SELECT COUNT(*) FROM schema_migrations WHERE version = 22"
        ).fetchone()[0]

    assert manual_columns["commit_started_at"] is None
    assert runtime_columns["commit_started_at"] is None
    assert manual is not None
    assert (manual["status"], manual["phase"], manual["commit_started_at"]) == (
        "running",
        "generating",
        None,
    )
    assert runtime is not None
    assert (runtime["status"], runtime["phase"], runtime["commit_started_at"]) == (
        "running",
        "installing",
        None,
    )
    assert applied == 1


def test_audio_migrations_preserve_pdf_defaults_and_install_time_citation_trigger(
    tmp_path: Path,
) -> None:
    settings = Settings(data_dir=tmp_path, api_token="test-token")
    _create_v22_source_document_fixture(settings.database_path)
    db = Database(settings)

    db.migrate()
    db.migrate()

    with db.connect() as connection:
        pdf_document = connection.execute(
            "SELECT * FROM documents WHERE id = 'pdf-document'"
        ).fetchone()
        pdf_chunk = connection.execute(
            "SELECT * FROM document_chunks WHERE id = 'pdf-chunk'"
        ).fetchone()
        assert pdf_document is not None
        assert pdf_chunk is not None
        connection.execute(
            """
            INSERT INTO documents(
                id, project_id, filename, sha256, storage_path, page_count,
                has_text, status, created_at, updated_at, source_kind,
                duration_ms, transcription_status, translation_status
            )
            VALUES (
                'audio-document', 'project', 'source.wav', 'audio-sha',
                'source.wav', 0, 1, 'ready', '2026-07-19', '2026-07-19',
                'audio', 1000, 'succeeded', 'succeeded'
            )
            """
        )
        connection.execute(
            """
            INSERT INTO document_chunks(
                id, project_id, document_id, page_number, chunk_index,
                text, raw_text, source_excerpt, extraction_method,
                content_profile, created_at, locator_kind, start_ms, end_ms,
                source_revision, translated_text, translation_source_revision
            )
            VALUES (
                'audio-chunk', 'project', 'audio-document', 0, 0,
                '日本語', '日本語', '日本語', 'transcription',
                'study_material', '2026-07-19', 'time', 100, 900, 1,
                '繁體中文', 1
            )
            """
        )
        connection.execute(
            """
            INSERT INTO question_drafts(
                id, project_id, document_id, chunk_id, question,
                choices_json, status, citation_page, created_at, updated_at
            )
            VALUES (
                'audio-draft', 'project', 'audio-document', 'audio-chunk',
                'Question?', '["A", "B"]', 'approved', 0,
                '2026-07-19', '2026-07-19'
            )
            """
        )
        audio_draft = connection.execute(
            "SELECT * FROM question_drafts WHERE id = 'audio-draft'"
        ).fetchone()
        applied = connection.execute(
            "SELECT version FROM schema_migrations WHERE version IN (23, 24) ORDER BY version"
        ).fetchall()

    assert pdf_document["source_kind"] == "document"
    assert pdf_document["transcription_status"] == "not_applicable"
    assert pdf_chunk["locator_kind"] == "page"
    assert pdf_chunk["source_revision"] == 1
    assert pdf_chunk["translation_source_revision"] is None
    assert chunk_repository.chunk_from_row(pdf_chunk).translation_stale is False
    assert audio_draft is not None
    assert audio_draft["citation_locator_kind"] == "time"
    assert audio_draft["citation_start_ms"] == 100
    assert audio_draft["citation_end_ms"] == 900
    assert audio_draft["citation_page"] is None
    assert [row["version"] for row in applied] == [23, 24]


def _create_version_14_practice_database(database_path: Path) -> None:
    database_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(database_path) as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute(
            """
            CREATE TABLE schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            )
            """
        )
        for version, sql in MIGRATIONS:
            if version > 14:
                break
            connection.executescript(sql)
            connection.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                (version, "2026-06-30T00:00:00+00:00"),
            )

        connection.executemany(
            """
            INSERT INTO projects(id, name, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            """,
            [
                (
                    "project-1",
                    "Project 1",
                    "2026-06-30T00:00:00+00:00",
                    "2026-06-30T00:00:00+00:00",
                ),
                (
                    "project-2",
                    "Project 2",
                    "2026-06-30T00:00:00+00:00",
                    "2026-06-30T00:00:00+00:00",
                ),
            ],
        )
        connection.executemany(
            """
            INSERT INTO question_drafts(
                id, project_id, question, choices_json, answer, rationale,
                citation_page, status, created_at, updated_at
            )
            VALUES (?, ?, ?, '["A", "B"]', 'A', 'Grounded.', 1,
                'approved', ?, ?)
            """,
            [
                (
                    "q-1",
                    "project-1",
                    "Question 1?",
                    "2026-06-30T00:00:00+00:00",
                    "2026-06-30T00:00:00+00:00",
                ),
                (
                    "q-2",
                    "project-1",
                    "Question 2?",
                    "2026-06-30T00:00:00+00:00",
                    "2026-06-30T00:00:00+00:00",
                ),
                (
                    "q-other",
                    "project-2",
                    "Other question?",
                    "2026-06-30T00:00:00+00:00",
                    "2026-06-30T00:00:00+00:00",
                ),
            ],
        )
        connection.executemany(
            """
            INSERT INTO practice_sessions(
                id, project_id, question_ids_json, status, mode,
                requested_question_count, created_at, completed_at
            )
            VALUES (?, ?, ?, ?, 'random_draw', ?, ?, ?)
            """,
            [
                (
                    "preserved-completed",
                    "project-1",
                    '["q-1"]',
                    "completed",
                    1,
                    "2026-06-30T00:00:00+00:00",
                    "2026-06-30T00:09:00+00:00",
                ),
                (
                    "completed-by-coverage",
                    "project-1",
                    '["q-1", "q-2"]',
                    "active",
                    2,
                    "2026-07-01T00:00:00+00:00",
                    None,
                ),
                (
                    "older-incomplete",
                    "project-1",
                    '["q-1", "q-2"]',
                    "active",
                    2,
                    "2026-07-01T01:00:00+00:00",
                    None,
                ),
                (
                    "latest-incomplete",
                    "project-1",
                    '["q-1", "q-2"]',
                    "active",
                    2,
                    "2026-07-01T02:00:00+00:00",
                    None,
                ),
                (
                    "other-project-incomplete",
                    "project-2",
                    '["q-other"]',
                    "active",
                    1,
                    "2026-07-01T03:00:00+00:00",
                    None,
                ),
            ],
        )
        connection.executemany(
            """
            INSERT INTO practice_attempts(
                id, session_id, project_id, question_id, selected_answer,
                is_correct, created_at
            )
            VALUES (?, 'completed-by-coverage', 'project-1', ?, 'A', 1, ?)
            """,
            [
                ("attempt-q1-old", "q-1", "2026-07-01T00:01:00+00:00"),
                ("attempt-q2", "q-2", "2026-07-01T00:02:00+00:00"),
                ("attempt-q1-new", "q-1", "2026-07-01T00:04:00+00:00"),
            ],
        )
        connection.execute(
            """
            INSERT INTO practice_attempts(
                id, session_id, project_id, question_id, selected_answer,
                is_correct, created_at
            )
            VALUES ('attempt-older-session-recent', 'older-incomplete',
                'project-1', 'q-1', 'A', 1, '2026-07-01T04:00:00+00:00')
            """
        )


def _create_v21_commit_transition_fixture(database_path: Path) -> None:
    database_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(database_path) as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute(
            """
            CREATE TABLE schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            )
            """
        )
        for version, sql in MIGRATIONS:
            if version >= 22:
                break
            connection.executescript(sql)
            connection.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                (version, f"migration-{version}"),
            )

        connection.execute(
            """
            INSERT INTO projects(id, name, created_at, updated_at)
            VALUES ('project', 'Project', '2026-07-13', '2026-07-13')
            """
        )
        connection.execute(
            """
            INSERT INTO documents(
                id, project_id, filename, sha256, storage_path, page_count,
                has_text, status, created_at, updated_at
            )
            VALUES (
                'document', 'project', 'source.pdf', 'sha256', 'source.pdf',
                1, 1, 'ready', '2026-07-13', '2026-07-13'
            )
            """
        )
        connection.execute(
            """
            INSERT INTO manual_draft_generation_operations(
                id, project_id, document_id, limit_count, strategy,
                status, phase, cancellable, provider, model,
                generated_count, created_at, updated_at
            )
            VALUES (
                'manual-job', 'project', 'document', 1,
                'hybrid_reasoning', 'running', 'generating', 1,
                'ollama', 'qwen3.5:4b', 0, '2026-07-13', '2026-07-13'
            )
            """
        )
        connection.execute(
            """
            INSERT INTO runtime_installation_jobs(
                id, kind, provider, model, status, phase, cancellable,
                detail, created_at, updated_at
            )
            VALUES (
                'runtime-job', 'ollama_model', 'ollama', 'qwen3.5:4b',
                'running', 'installing', 1, 'pulling model',
                '2026-07-13', '2026-07-13'
            )
            """
        )


def _create_v22_source_document_fixture(database_path: Path) -> None:
    database_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(database_path) as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute(
            """
            CREATE TABLE schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            )
            """
        )
        for version, sql in MIGRATIONS:
            if version > 22:
                break
            connection.executescript(sql)
            connection.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                (version, f"migration-{version}"),
            )
        connection.execute(
            """
            INSERT INTO projects(id, name, created_at, updated_at)
            VALUES ('project', 'Project', '2026-07-18', '2026-07-18')
            """
        )
        connection.execute(
            """
            INSERT INTO documents(
                id, project_id, filename, sha256, storage_path, page_count,
                has_text, status, created_at, updated_at
            )
            VALUES (
                'pdf-document', 'project', 'source.pdf', 'pdf-sha', 'source.pdf',
                1, 1, 'ready', '2026-07-18', '2026-07-18'
            )
            """
        )
        connection.execute(
            """
            INSERT INTO document_chunks(
                id, project_id, document_id, page_number, chunk_index,
                text, raw_text, source_excerpt, extraction_method,
                content_profile, created_at
            )
            VALUES (
                'pdf-chunk', 'project', 'pdf-document', 1, 0,
                'Normalized PDF text', 'Original PDF text', 'PDF excerpt',
                'embedded', 'study_material', '2026-07-18'
            )
            """
        )


def _create_v19_duplicate_operation_fixture(database_path: Path) -> None:
    database_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(database_path) as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute(
            """
            CREATE TABLE schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            )
            """
        )
        for version, sql in MIGRATIONS:
            if version >= 20:
                break
            connection.executescript(sql)
            connection.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                (version, f"migration-{version}"),
            )

        connection.execute(
            """
            INSERT INTO projects(id, name, created_at, updated_at)
            VALUES ('project', 'Project', '2026-01-01', '2026-01-01')
            """
        )
        connection.executemany(
            """
            INSERT INTO documents(
                id, project_id, filename, sha256, storage_path, page_count,
                has_text, status, created_at, updated_at
            )
            VALUES (?, 'project', ?, ?, ?, 1, 0, 'processing', ?, ?)
            """,
            [
                (
                    "document",
                    "document.pdf",
                    "document-sha",
                    "document.pdf",
                    "2026-01-01",
                    "2026-01-01",
                ),
                (
                    "document-running-priority",
                    "running.pdf",
                    "running-sha",
                    "running.pdf",
                    "2026-01-01",
                    "2026-01-01",
                ),
                (
                    "document-tie",
                    "tie.pdf",
                    "tie-sha",
                    "tie.pdf",
                    "2026-01-01",
                    "2026-01-01",
                ),
            ],
        )
        connection.executemany(
            """
            INSERT INTO document_operations(
                id, project_id, document_id, status, phase, cancellable,
                error, created_at, updated_at
            )
            VALUES (?, 'project', ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    "terminal-history",
                    "document",
                    "succeeded",
                    "completed",
                    0,
                    None,
                    "2026-01-01",
                    "2026-01-01",
                ),
                (
                    "cancel-requested",
                    "document",
                    "cancel_requested",
                    "canceling",
                    0,
                    None,
                    "2026-01-02",
                    "2026-01-02",
                ),
                (
                    "running-newer",
                    "document",
                    "running",
                    "processing",
                    1,
                    None,
                    "2026-01-03",
                    "2026-01-04",
                ),
                (
                    "queued-newest",
                    "document",
                    "queued",
                    "queued",
                    1,
                    None,
                    "2026-01-05",
                    "2026-01-05",
                ),
                (
                    "unattached-a",
                    None,
                    "queued",
                    "queued",
                    1,
                    None,
                    "2026-01-03",
                    "2026-01-03",
                ),
                (
                    "unattached-b",
                    None,
                    "running",
                    "processing",
                    1,
                    None,
                    "2026-01-04",
                    "2026-01-04",
                ),
                (
                    "running-priority",
                    "document-running-priority",
                    "running",
                    "processing",
                    1,
                    None,
                    "2026-01-01",
                    "2026-01-01",
                ),
                (
                    "queued-later",
                    "document-running-priority",
                    "queued",
                    "queued",
                    1,
                    None,
                    "2026-01-09",
                    "2026-01-09",
                ),
                (
                    "tie-a",
                    "document-tie",
                    "running",
                    "processing",
                    1,
                    None,
                    "2026-01-02",
                    "2026-01-02",
                ),
                (
                    "tie-z",
                    "document-tie",
                    "running",
                    "processing",
                    1,
                    None,
                    "2026-01-02",
                    "2026-01-02",
                ),
            ],
        )


def _columns(connection, table_name: str) -> dict[str, str | None]:
    rows = connection.execute(f"PRAGMA table_info({table_name})").fetchall()
    return {row["name"]: row["dflt_value"] for row in rows}


def test_migration_29_stores_one_device_preference_row(tmp_path: Path) -> None:
    db = Database(Settings(data_dir=tmp_path, api_token="test-token"))
    db.migrate()

    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM ollama_device_preference").fetchone()[0] == 0

    with pytest.raises(sqlite3.IntegrityError):
        with db.connect() as connection:
            connection.execute(
                """
                INSERT INTO ollama_device_preference(id, mode, updated_at)
                VALUES (1, 'gpu', '2026-11-11T00:00:00+00:00')
                """
            )

    with pytest.raises(sqlite3.IntegrityError):
        with db.connect() as connection:
            connection.execute(
                """
                INSERT INTO ollama_device_preference(id, mode, updated_at)
                VALUES (2, 'auto', '2026-11-11T00:00:00+00:00')
                """
            )

    with db.connect() as connection:
        connection.execute(
            """
            INSERT INTO ollama_device_preference(id, mode, updated_at)
            VALUES (1, 'cpu', '2026-11-11T00:00:00+00:00')
            """
        )
        stored = connection.execute(
            "SELECT mode FROM ollama_device_preference WHERE id = 1"
        ).fetchone()
    assert stored["mode"] == "cpu"


def test_migration_29_upgrades_a_version_28_database(tmp_path: Path) -> None:
    settings = Settings(data_dir=tmp_path, api_token="test-token")
    settings.database_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(settings.database_path) as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute(
            """
            CREATE TABLE schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            )
            """
        )
        for version, sql in MIGRATIONS:
            if version > 28:
                continue
            connection.executescript(sql)
            connection.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                (version, "2026-01-01T00:00:00+00:00"),
            )
        connection.execute(
            """
            INSERT INTO projects(id, name, description, created_at, updated_at)
            VALUES ('project-kept', 'Kept', '', '2026-01-01', '2026-01-01')
            """
        )
        connection.commit()

    Database(settings).migrate()

    with Database(settings).connect() as connection:
        count = connection.execute("SELECT COUNT(*) FROM ollama_device_preference").fetchone()[0]
        project = connection.execute(
            "SELECT name FROM projects WHERE id = 'project-kept'"
        ).fetchone()
        versions = [
            row[0]
            for row in connection.execute("SELECT version FROM schema_migrations ORDER BY version")
        ]
    assert count == 0
    assert project["name"] == "Kept"
    assert versions == [version for version, _sql in MIGRATIONS]


def test_migration_30_rewrites_extraction_vocabulary_and_preserves_sources(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = Settings(data_dir=tmp_path, api_token="test-token")
    with monkeypatch.context() as patch:
        patch.setattr(
            database_module,
            "MIGRATIONS",
            tuple(migration for migration in MIGRATIONS if migration[0] < 30),
        )
        previous = Database(settings)
        pdf_error = (
            "This PDF requires WindowsML OCR, which is unavailable in the installed "
            "Capture Runtime."
        )
        image_error = (
            "WindowsML OCR is unavailable. "
            "No downloadable model is published for this runtime release."
        )
        with previous.connect() as connection:
            connection.execute(
                """INSERT INTO projects(id, name, description, created_at, updated_at)
                   VALUES ('p', 'Kept', '', '2026-01-01', '2026-01-01')"""
            )
            # Each WindowsML device name a release stored, and the values that stay.
            stored_devices = {
                "ocr": "windowsml-dml",
                "embedded": "amd_windowsml:0",
                "mixed": "windowsml",
                "failed": "cpu",
                "exam": "directml",
                "audio": None,
                "runtime": None,
                "speech": None,
                "interrupted": None,
                "silent": None,
                "retried": None,
                "requirements": None,
                "assets": None,
                "notext": None,
                "notext-ambiguous": None,
                "notext-unmatched": None,
            }
            audio_documents = {"audio", "speech", "silent"}
            # The stored values of the old vocabulary, named once.
            old_failed = "ocr_failed"
            old_recognition = "windowsml_ocr"
            for doc, status, method, message in (
                ("ocr", "ready", old_recognition, image_error),
                ("embedded", "ready", "embedded", None),
                ("mixed", "ready", "mixed", None),
                ("failed", old_failed, old_failed, pdf_error),
                ("exam", "exam_failed", "none", "No reviewable text."),
                ("audio", "ready", "transcription", None),
                # A failure reason an earlier release copied from the runtime's error text.
                ("runtime", old_failed, old_failed, RUNTIME_TEXT),
                ("speech", "transcription_failed", "none", RUNTIME_TEXT),
                # A failure reason Cert itself wrote: true, so it is kept.
                ("interrupted", old_failed, old_failed, INTERRUPTED_TEXT),
                # A failed recording: the writer of that release stored no reason, only the
                # operation error.
                ("silent", "transcription_failed", "none", None),
                # Retried successfully; only an earlier failed operation keeps runtime text.
                ("retried", "ready", old_recognition, None),
                # Two texts earlier releases of Cert wrote itself.
                ("requirements", old_failed, old_failed, REQUIREMENTS_TEXT),
                ("assets", old_failed, old_failed, ASSETS_TEXT),
                # Two failed runs stored the same runtime text; only the one that settled
                # last, at the document's updated_at, found no text.
                ("notext", "no_text_detected", "none", RUNTIME_TEXT),
                # Two failed runs settled at the document's updated_at: neither is known to
                # be the run without text.
                ("notext-ambiguous", "no_text_detected", "none", RUNTIME_TEXT),
                # No failed run settled at the document's updated_at.
                ("notext-unmatched", "no_text_detected", "none", RUNTIME_TEXT),
            ):
                connection.execute(
                    """INSERT INTO documents(
                        id, project_id, filename, sha256, storage_path, page_count, has_text,
                        status, created_at, extraction_method, ocr_device, ocr_fallback_reason,
                        source_kind
                    ) VALUES (?, 'p', 'source', 'digest', 'path', 1, 1,
                              ?, '2026-01-01', ?, ?, ?, ?)""",
                    (
                        doc, status, method, stored_devices[doc],
                        message, "audio" if doc in audio_documents else "document",
                    ),
                )
                connection.execute(
                    """INSERT INTO document_chunks(
                        id, project_id, document_id, page_number, chunk_index, text,
                        source_excerpt, created_at, extraction_method, locator_kind,
                        start_ms, end_ms
                    ) VALUES (?, 'p', ?, 1, 0, 'kept text', 'excerpt', '2026-01-01',
                              ?, ?, ?, ?)""",
                    (
                        doc, doc, method, "time" if doc in audio_documents else "page",
                        12 if doc in audio_documents else None,
                        30 if doc in audio_documents else None,
                    ),
                )
            connection.execute(
                """INSERT INTO question_drafts(
                    id, project_id, document_id, chunk_id, question, choices_json,
                    status, created_at, updated_at
                ) VALUES ('q', 'p', 'ocr', 'ocr', 'Question', '[]',
                          'approved', '2026-01-01', '2026-01-01')"""
            )
            for doc, message in (
                ("failed", pdf_error),
                ("ocr", image_error),
                ("runtime", RUNTIME_TEXT),
                ("speech", RUNTIME_TEXT),
                ("interrupted", INTERRUPTED_TEXT),
                ("silent", RUNTIME_TEXT),
                ("retried", RUNTIME_TEXT),
                ("requirements", REQUIREMENTS_TEXT),
                ("assets", ASSETS_TEXT),
            ):
                connection.execute(
                    """INSERT INTO document_operations(
                        id, project_id, document_id, status, phase, cancellable, error,
                        created_at, updated_at
                    ) VALUES (?, 'p', ?, 'failed', 'failed', 0, ?, '2026-01-01', '2026-01-01')""",
                    (doc, doc, message),
                )
            # The failure writer stored one timestamp as the operation's and the document's
            # updated_at. A retry took its created_at before it waited for the write lock, so
            # the run without text ('notext') is not the newest by created_at.
            for doc, settled_at in (
                ("notext", "2026-01-03"),
                ("notext-ambiguous", "2026-01-03"),
                ("notext-unmatched", "2026-01-04"),
            ):
                connection.execute(
                    "UPDATE documents SET updated_at = ? WHERE id = ?", (settled_at, doc)
                )
            for operation, doc, created_at, updated_at in (
                ("notext", "notext", "2026-01-01", "2026-01-03"),
                ("notext-newer", "notext", "2026-01-02", "2026-01-02"),
                ("notext-ambiguous", "notext-ambiguous", "2026-01-01", "2026-01-03"),
                ("notext-ambiguous-retry", "notext-ambiguous", "2026-01-02", "2026-01-03"),
                ("notext-unmatched", "notext-unmatched", "2026-01-01", "2026-01-02"),
                ("notext-unmatched-retry", "notext-unmatched", "2026-01-02", "2026-01-03"),
            ):
                connection.execute(
                    """INSERT INTO document_operations(
                        id, project_id, document_id, status, phase, cancellable, error,
                        created_at, updated_at
                    ) VALUES (?, 'p', ?, 'failed', 'failed', 0, ?, ?, ?)""",
                    (operation, doc, RUNTIME_TEXT, created_at, updated_at),
                )
            # A canceled run that settled at the same time as the run without text is not a
            # second candidate: only failed runs count.
            connection.execute(
                """INSERT INTO document_operations(
                    id, project_id, document_id, status, phase, cancellable, error,
                    created_at, updated_at
                ) VALUES ('notext-canceled', 'p', 'notext', 'canceled', 'canceled', 0, NULL,
                          '2026-01-01', '2026-01-03')"""
            )
            outline_before = _extraction_schema_outline(connection)
            counts_before = _row_counts(connection)

    def snapshot(
        db: Database,
    ) -> tuple[list[tuple[object, ...]], list[tuple[object, ...]], list[tuple[object, ...]], str]:
        with db.connect() as connection:
            assert connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1
            assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
            question = connection.execute(
                "SELECT document_id, chunk_id FROM question_drafts WHERE id = 'q'"
            ).fetchone()
            assert question is not None
            assert tuple(question) == ("ocr", "ocr")
            documents = connection.execute(
                """SELECT id, status, extraction_method, ocr_device, extraction_warnings,
                          failure_message, sha256, source_kind
                   FROM documents ORDER BY id"""
            )
            chunks = connection.execute(
                """SELECT document_id, extraction_method, text, locator_kind, start_ms, end_ms
                   FROM document_chunks ORDER BY document_id"""
            )
            operations = connection.execute(
                "SELECT document_id, error FROM document_operations ORDER BY document_id, id"
            )
            applied = connection.execute(
                "SELECT applied_at FROM schema_migrations WHERE version = 30"
            ).fetchone()[0]
            return (
                [tuple(row) for row in documents],
                [tuple(row) for row in chunks],
                [tuple(row) for row in operations],
                str(applied),
            )

    pdf_failure = (
        "This PDF requires text recognition, which is unavailable in the installed "
        "Capture Runtime."
    )
    image_warning = (
        "Text recognition is unavailable. "
        "No downloadable model is published for this runtime release."
    )
    image_unavailable = "Text recognition is unavailable in the installed Capture Runtime."
    no_text = "No reviewable text was found in this source."
    unreadable = "Text recognition could not read this source."
    untranscribed = "Speech recognition could not transcribe this recording."
    # This test is about migration 30 alone: later migrations would add their own columns
    # and schema_migrations rows to the comparison below.
    monkeypatch.setattr(
        database_module,
        "MIGRATIONS",
        tuple(migration for migration in MIGRATIONS if migration[0] <= 30),
    )
    first = snapshot(Database(settings))
    assert first[0] == [
        ("assets", "extraction_failed", "none", None, None, ASSETS_TEXT, "digest", "document"),
        ("audio", "ready", "transcription", None, None, None, "digest", "audio"),
        ("embedded", "ready", "text_layer", "directml", None, None, "digest", "document"),
        ("exam", "no_text_detected", "none", "directml", None, no_text, "digest", "document"),
        ("failed", "extraction_failed", "none", "cpu", None, pdf_failure, "digest", "document"),
        (
            "interrupted", "extraction_failed", "none", None, None, INTERRUPTED_TEXT,
            "digest", "document",
        ),
        ("mixed", "ready", "text_layer", "directml", None, None, "digest", "document"),
        ("notext", "no_text_detected", "none", None, None, no_text, "digest", "document"),
        (
            "notext-ambiguous", "no_text_detected", "none", None, None, no_text,
            "digest", "document",
        ),
        (
            "notext-unmatched", "no_text_detected", "none", None, None, no_text,
            "digest", "document",
        ),
        ("ocr", "ready", "text_recognition", "directml", image_warning, None, "digest", "document"),
        (
            "requirements", "extraction_failed", "none", None, None, REQUIREMENTS_TEXT,
            "digest", "document",
        ),
        ("retried", "ready", "text_recognition", None, None, None, "digest", "document"),
        ("runtime", "extraction_failed", "none", None, None, unreadable, "digest", "document"),
        ("silent", "transcription_failed", "none", None, None, untranscribed, "digest", "audio"),
        ("speech", "transcription_failed", "none", None, None, untranscribed, "digest", "audio"),
    ]
    assert first[1] == [
        ("assets", "none", "kept text", "page", None, None),
        ("audio", "transcription", "kept text", "time", 12, 30),
        ("embedded", "text_layer", "kept text", "page", None, None),
        ("exam", "none", "kept text", "page", None, None),
        ("failed", "none", "kept text", "page", None, None),
        ("interrupted", "none", "kept text", "page", None, None),
        ("mixed", "text_layer", "kept text", "page", None, None),
        ("notext", "none", "kept text", "page", None, None),
        ("notext-ambiguous", "none", "kept text", "page", None, None),
        ("notext-unmatched", "none", "kept text", "page", None, None),
        ("ocr", "text_recognition", "kept text", "page", None, None),
        ("requirements", "none", "kept text", "page", None, None),
        ("retried", "text_recognition", "kept text", "page", None, None),
        ("runtime", "none", "kept text", "page", None, None),
        ("silent", "none", "kept text", "time", 12, 30),
        ("speech", "none", "kept text", "time", 12, 30),
    ]
    assert first[2] == [
        ("assets", ASSETS_TEXT),
        ("failed", pdf_failure),
        ("interrupted", INTERRUPTED_TEXT),
        # Only the run that settled at the document's updated_at found no text, although
        # 'notext-newer' was created later; the canceled run that settled at the same time
        # stays as it was.
        ("notext", no_text),
        ("notext", None),
        ("notext", unreadable),
        # Two runs settled at the document's updated_at, or none did: no run is known to be
        # the run without text.
        ("notext-ambiguous", unreadable),
        ("notext-ambiguous", unreadable),
        ("notext-unmatched", unreadable),
        ("notext-unmatched", unreadable),
        ("ocr", image_unavailable),
        ("requirements", REQUIREMENTS_TEXT),
        ("retried", unreadable),
        ("runtime", unreadable),
        ("silent", untranscribed),
        ("speech", untranscribed),
    ]
    assert RUNTIME_TEXT not in repr(first)

    with Database(settings).connect() as connection:
        outline_after = _extraction_schema_outline(connection)
        counts_after = _row_counts(connection)
    # The rebuild keeps every row, index, trigger and foreign key; only the
    # retired columns go, the two message columns arrive and the default
    # extraction method stops naming a retired value.
    assert counts_after == {
        **counts_before,
        "schema_migrations": counts_before["schema_migrations"] + 1,
    }
    assert outline_after["objects"] == outline_before["objects"]
    assert outline_after["foreign_keys"] == outline_before["foreign_keys"]
    for table, dropped, added in (
        ("documents", RETIRED_DOCUMENT_COLUMNS, {"extraction_warnings", "failure_message"}),
        ("document_chunks", set(), set()),
    ):
        before_columns = outline_before["columns"][table]
        after_columns = outline_after["columns"][table]
        assert set(after_columns) == (set(before_columns) - dropped) | added
        # Every kept column keeps its type, NOT NULL and default; only the default of the
        # extraction method changes from the retired value to none.
        type_, not_null, default, primary_key = before_columns["extraction_method"]
        assert default == "'embedded'"
        expected = {
            name: definition
            for name, definition in before_columns.items()
            if name in after_columns
        }
        expected["extraction_method"] = (type_, not_null, "'none'", primary_key)
        assert {
            name: definition
            for name, definition in after_columns.items()
            if name in before_columns
        } == expected

    assert snapshot(Database(settings)) == first

    # The triggers that name document_chunks and the cascades into the rebuilt tables still
    # work on the rebuilt tables.
    with Database(settings).connect() as connection:
        insert_job = """INSERT INTO draft_generation_jobs(
                id, project_id, document_id, chunk_id, source_chunk_id, page_number,
                strategy, status, provider, model, created_at, updated_at
            ) VALUES (?, 'p', ?, ?, ?, 1, 'hybrid_reasoning', 'pending', 'provider',
                      'model', '2026-01-01', '2026-01-01')"""
        connection.execute(insert_job, ("job", "embedded", "embedded", "embedded"))
        with pytest.raises(sqlite3.IntegrityError, match="must belong to its document"):
            connection.execute(insert_job, ("foreign-job", "embedded", "mixed", "mixed"))
        with pytest.raises(sqlite3.IntegrityError, match="must belong to its document"):
            connection.execute(
                "UPDATE draft_generation_jobs SET chunk_id = 'mixed' WHERE id = 'job'"
            )
        connection.execute(
            """INSERT INTO question_drafts(
                id, project_id, document_id, chunk_id, question, choices_json,
                status, created_at, updated_at
            ) VALUES ('audio-q', 'p', 'audio', 'audio', 'Question', '[]',
                      'approved', '2026-01-01', '2026-01-01')"""
        )
        citation = connection.execute(
            """SELECT citation_locator_kind, citation_start_ms, citation_end_ms
               FROM question_drafts WHERE id = 'audio-q'"""
        ).fetchone()
        assert tuple(citation) == ("time", 12, 30)

        connection.execute("DELETE FROM documents WHERE id IN ('failed', 'embedded')")
        for table, column in (
            ("document_chunks", "document_id"),
            ("document_operations", "document_id"),
            ("draft_generation_jobs", "document_id"),
        ):
            remaining = connection.execute(
                f"SELECT COUNT(*) FROM {table} WHERE {column} IN ('failed', 'embedded')"
            ).fetchone()[0]
            assert remaining == 0, table
        assert connection.execute("SELECT COUNT(*) FROM document_chunks").fetchone()[0] == 14


def test_a_table_rebuild_names_the_foreign_keys_it_broke() -> None:
    connection = sqlite3.connect(":memory:")
    try:
        connection.execute("CREATE TABLE parent(id TEXT PRIMARY KEY)")
        connection.execute("CREATE TABLE child(id TEXT, parent_id TEXT REFERENCES parent(id))")
        connection.execute("INSERT INTO child VALUES ('a', 'gone'), ('b', 'gone')")

        with pytest.raises(sqlite3.IntegrityError, match=r"child -> parent \(2 rows\)"):
            database_module._run_table_rebuild(connection, "DELETE FROM parent;")
    finally:
        connection.close()


def _schema(connection: sqlite3.Connection) -> list[tuple[Any, ...]]:
    return sorted(
        tuple(row) for row in connection.execute("SELECT type, name, sql FROM sqlite_master")
    )


def _row_counts(connection: sqlite3.Connection) -> dict[str, int]:
    tables = [
        str(row[0])
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        )
    ]
    return {
        table: int(connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])
        for table in tables
    }


def _extraction_schema_outline(connection: sqlite3.Connection) -> dict[str, Any]:
    tables = ("documents", "document_chunks")
    return {
        "columns": {
            table: {
                str(row[1]): (row[2], row[3], row[4], row[5])
                for row in connection.execute(f"PRAGMA table_info({table})")
            }
            for table in tables
        },
        "foreign_keys": {
            table: sorted(
                tuple(row)[2:] for row in connection.execute(f"PRAGMA foreign_key_list({table})")
            )
            for table in tables
        },
        "objects": sorted(
            tuple(row)
            for row in connection.execute(
                "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type != 'table'"
            )
        ),
    }


def test_migration_31_preserves_existing_source_without_provenance(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = Settings(data_dir=tmp_path, api_token="test-token")
    with monkeypatch.context() as patch:
        patch.setattr(
            database_module,
            "MIGRATIONS",
            tuple(migration for migration in MIGRATIONS if migration[0] <= 30),
        )
        with Database(settings).connect() as connection:
            assert "extraction_provenance" not in _columns(connection, "documents")
            assert "runtime_ingestion_id" not in _columns(
                connection, "capture_review_sessions"
            )
            connection.execute(
                """INSERT INTO projects(id, name, description, created_at, updated_at)
                   VALUES ('p', 'Project', '', '2026-01-01', '2026-01-01')"""
            )
            connection.execute(
                """INSERT INTO documents(
                       id, project_id, filename, sha256, storage_path, page_count,
                       has_text, status, created_at, extraction_method
                   ) VALUES (
                       'd', 'p', 'source.pdf', 'digest', 'path', 1, 1,
                       'ready', '2026-01-01', 'text_recognition'
                   )"""
            )
            connection.execute(
                """INSERT INTO document_operations(
                       id, project_id, document_id, status, phase, cancellable,
                       created_at, updated_at
                   ) VALUES (
                       'o', 'p', 'd', 'succeeded', 'completed', 0,
                       '2026-01-01', '2026-01-01'
                   )"""
            )
            connection.execute(
                """INSERT INTO capture_review_sessions(
                       id, project_id, document_id, operation_id, runtime_capture_id,
                       status, review_revision, expires_at, created_at, updated_at
                   ) VALUES (
                       'r', 'p', 'd', 'o', 'runtime-capture', 'completed', 2,
                       '2026-01-02', '2026-01-01', '2026-01-01'
                   )"""
            )

    with Database(settings).connect() as connection:
        row = connection.execute(
            "SELECT filename, extraction_provenance FROM documents WHERE id = 'd'"
        ).fetchone()
        assert tuple(row) == ("source.pdf", None)
        review = connection.execute(
            """SELECT runtime_capture_id, status, review_revision, runtime_ingestion_id
               FROM capture_review_sessions WHERE id = 'r'"""
        ).fetchone()
        assert tuple(review) == ("runtime-capture", "completed", 2, None)
        applied = connection.execute(
            "SELECT applied_at FROM schema_migrations WHERE version = 31"
        ).fetchone()
        assert applied is not None
        schema = _schema(connection)

        connection.execute(
            "UPDATE schema_migrations SET applied_at = 'kept' WHERE version = 31"
        )

    # A second open is a no-op: migration 31 does not run again and the schema is unchanged.
    with Database(settings).connect() as connection:
        assert connection.execute(
            "SELECT applied_at FROM schema_migrations WHERE version = 31"
        ).fetchone()[0] == "kept"
        assert _schema(connection) == schema

    # A fresh database gets both columns from the migrations alone.
    fresh = Settings(data_dir=tmp_path / "fresh", api_token="test-token")
    with Database(fresh).connect() as connection:
        assert "extraction_provenance" in _columns(connection, "documents")
        assert "runtime_ingestion_id" in _columns(connection, "capture_review_sessions")
