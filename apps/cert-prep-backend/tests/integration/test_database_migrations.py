from __future__ import annotations

import re
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any

import pytest

from cert_prep_backend.platform.config import Settings
from cert_prep_backend.source_library.infrastructure import chunks as chunk_repository
from cert_prep_backend.platform import database as database_module
from cert_prep_backend.platform.database import MIGRATIONS, Database
from cert_prep_backend.source_library.infrastructure.sources import insert_processing_source


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
        source_columns = _columns(connection, "sources")
        chunk_columns = _columns(connection, "source_chunks")
        question_columns = _columns(connection, "questions")
        question_job_columns = _columns(connection, "question_generation_jobs")
        manual_generation_columns = _columns(connection, "manual_question_generations")
        session_columns = _columns(connection, "practice_sessions")
        session_question_columns = _columns(connection, "practice_session_questions")
        source_operation_columns = _columns(connection, "source_operations")
        llm_installation_columns = _columns(connection, "llm_installation_jobs")
        capture_review_columns = _columns(connection, "capture_review_sessions")

    assert source_columns["extraction_provenance"] is None
    assert capture_review_columns["runtime_ingestion_id"] is None
    assert source_columns["content_profile"] == "'unknown'"
    assert "classification_detail" in source_columns
    assert {"extraction_warnings", "failure_message"} <= set(source_columns)
    assert RETIRED_DOCUMENT_COLUMNS.isdisjoint(source_columns)
    assert source_columns["extraction_method"] == "'none'"
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
    } <= set(question_columns)
    assert session_columns["mode"] == "'random_draw'"
    assert {
        "source_id",
        "requested_question_count",
        "random_seed",
        "abandoned_at",
    } <= set(session_columns)
    assert {
        "project_id",
        "source_id",
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
    } <= set(question_job_columns)
    assert {
        "project_id",
        "source_id",
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
    } <= set(manual_generation_columns)
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
        "source_id",
    } <= set(session_question_columns)
    assert {
        "id",
        "project_id",
        "source_id",
        "status",
        "phase",
        "cancellable",
        "error",
        "created_at",
        "updated_at",
    } <= set(source_operation_columns)
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
    } <= set(llm_installation_columns)
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
                "SELECT * FROM source_operations ORDER BY id"
            ).fetchall()
        }
        indexes = {
            row["name"]: row
            for row in connection.execute(
                "PRAGMA index_list(source_operations)"
            ).fetchall()
        }
        applied = connection.execute(
            "SELECT COUNT(*) FROM schema_migrations WHERE version = 20"
        ).fetchone()[0]
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO source_operations(
                    id, project_id, source_id, status, phase, cancellable,
                    created_at, updated_at
                )
                VALUES (
                    'post-migration-conflict', 'project', 'document', 'queued',
                    'queued', 1, '2026-01-06', '2026-01-06'
                )
                """
            )

    assert applied == 1
    active_index = indexes["idx_source_operations_one_active_source"]
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
        manual_columns = _columns(connection, "manual_question_generations")
        runtime_columns = _columns(connection, "llm_installation_jobs")
        manual = connection.execute(
            "SELECT * FROM manual_question_generations WHERE id = 'manual-job'"
        ).fetchone()
        runtime = connection.execute(
            "SELECT * FROM llm_installation_jobs WHERE id = 'runtime-job'"
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
            "SELECT * FROM sources WHERE id = 'pdf-document'"
        ).fetchone()
        pdf_chunk = connection.execute(
            "SELECT * FROM source_chunks WHERE id = 'pdf-chunk'"
        ).fetchone()
        assert pdf_document is not None
        assert pdf_chunk is not None
        connection.execute(
            """
            INSERT INTO sources(
                id, project_id, filename, sha256, storage_path, page_count,
                has_text, status, created_at, updated_at, source_kind,
                duration_ms, transcription_status, translation_status
            )
            VALUES (
                'audio-document', 'project', 'source.wav', 'audio-sha',
                'source.wav', 0, 1, 'ready', '2026-07-19', '2026-07-19',
                'recording', 1000, 'succeeded', 'succeeded'
            )
            """
        )
        connection.execute(
            """
            INSERT INTO source_chunks(
                id, project_id, source_id, page_number, chunk_index,
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
            INSERT INTO questions(
                id, project_id, source_id, chunk_id, question,
                choices_json, citation_page, created_at, updated_at
            )
            VALUES (
                'audio-question', 'project', 'audio-document', 'audio-chunk',
                'Question?', '["A", "B"]', 0,
                '2026-07-19', '2026-07-19'
            )
            """
        )
        audio_question = connection.execute(
            "SELECT * FROM questions WHERE id = 'audio-question'"
        ).fetchone()
        applied = connection.execute(
            "SELECT version FROM schema_migrations WHERE version IN (23, 24) ORDER BY version"
        ).fetchall()

    assert pdf_document["source_kind"] == "pdf"
    assert pdf_document["transcription_status"] == "not_applicable"
    assert pdf_chunk["locator_kind"] == "page"
    assert pdf_chunk["source_revision"] == 1
    assert pdf_chunk["translation_source_revision"] is None
    assert chunk_repository.chunk_from_row(pdf_chunk).translation_stale is False
    assert audio_question is not None
    assert audio_question["citation_locator_kind"] == "time"
    assert audio_question["citation_start_ms"] == 100
    assert audio_question["citation_end_ms"] == 900
    assert audio_question["citation_page"] is None
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


def _stop_at(monkeypatch: pytest.MonkeyPatch, version: int) -> None:
    """Later opens in this test apply the migrations up to `version` only, so a test of one
    migration reads the schema that migration leaves, not the names later ones give it."""

    monkeypatch.setattr(
        database_module,
        "MIGRATIONS",
        tuple(migration for migration in MIGRATIONS if migration[0] <= version),
    )


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

    _stop_at(monkeypatch, 31)
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


def test_migration_32_classifies_sources_and_preserves_references(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = Settings(data_dir=tmp_path, api_token="test-token")
    upload_dir = tmp_path / "uploads" / "p"
    upload_dir.mkdir(parents=True)
    pdf_content = upload_dir / "scan.bin"
    pdf_content.write_bytes(b"%PDF-1.7\n")
    cases = [
        (f"scan{suffix}", "document", str(upload_dir / "missing"), expected)
        for suffix, expected in [
            (".pdf", "pdf"),
            (".PDF", "pdf"),
            (".jpg", "image"),
            (".JPG", "image"),
            (".jpeg", "image"),
            (".JPEG", "image"),
            (".png", "image"),
            (".PNG", "image"),
            (".webp", "image"),
            (".WEBP", "image"),
        ]
    ] + [
        # The stored file's suffix decided PDF versus image before migration 32 (upload
        # preparation derives it from the content), so it wins over the uploaded name.
        ("scan.png", "document", str(upload_dir / "stored.pdf"), "pdf"),
        ("scan.pdf", "document", str(upload_dir / "stored.webp"), "image"),
        ("notes", "document", str(upload_dir / "stored.JPG"), "image"),
        ("unknown.bin", "document", str(upload_dir / "stored.pdf"), "pdf"),
        # Neither name has a known suffix: only PDF bytes make it a PDF.
        ("scan.bin", "document", str(pdf_content), "pdf"),
        ("unknown.bin", "document", str(upload_dir / "missing"), "image"),
        ("listen.wav", "audio", str(upload_dir / "missing"), "recording"),
        ("listen.WAV", "audio", str(upload_dir / "missing"), "recording"),
        ("listen.mp3", "audio", str(upload_dir / "missing"), "recording"),
        ("listen.MP3", "audio", str(upload_dir / "missing"), "recording"),
        ("listen.m4a", "audio", str(upload_dir / "missing"), "recording"),
        ("listen.M4A", "audio", str(upload_dir / "missing"), "recording"),
    ]

    with monkeypatch.context() as patch:
        patch.setattr(
            database_module,
            "MIGRATIONS",
            tuple(migration for migration in MIGRATIONS if migration[0] <= 31),
        )
        with Database(settings).connect() as connection:
            connection.execute(
                """INSERT INTO projects(id, name, created_at, updated_at)
                   VALUES ('p', 'Project', '2026-01-01', '2026-01-01')"""
            )
            connection.executemany(
                """INSERT INTO documents(
                       id, project_id, filename, sha256, storage_path, page_count,
                       has_text, status, created_at, source_kind
                   ) VALUES (?, 'p', ?, 'digest', ?, 1, 1, 'ready', '2026-01-01', ?)""",
                [
                    (str(index), filename, path, old_kind)
                    for index, (filename, old_kind, path, _) in enumerate(cases)
                ],
            )
            connection.executemany(
                """INSERT INTO document_chunks(
                       id, project_id, document_id, page_number, chunk_index, text,
                       source_excerpt, created_at, extraction_method
                   ) VALUES (?, 'p', ?, 1, 0, 'text', '', '2026-01-01', 'none')""",
                [(str(index), str(index)) for index in range(len(cases))],
            )

    _stop_at(monkeypatch, 32)

    def snapshot() -> tuple[dict[str, str], tuple[str, ...], str]:
        with Database(settings).connect() as connection:
            assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
            assert connection.execute("SELECT count(*) FROM projects").fetchone()[0] == 1
            kinds: dict[str, str] = dict(connection.execute("SELECT id, source_kind FROM documents"))
            chunk_documents = tuple(
                row[0] for row in connection.execute(
                    "SELECT document_id FROM document_chunks ORDER BY CAST(id AS INTEGER)"
                )
            )
            applied_at = connection.execute(
                "SELECT applied_at FROM schema_migrations WHERE version = 32"
            ).fetchone()[0]
        return kinds, chunk_documents, applied_at

    migrated = snapshot()
    assert migrated[0] == {str(index): case[3] for index, case in enumerate(cases)}
    assert migrated[1] == tuple(str(index) for index in range(len(cases)))
    assert snapshot() == migrated


def test_fresh_database_persists_new_source_kinds(tmp_path: Path) -> None:
    settings = Settings(data_dir=tmp_path, api_token="test-token")
    with Database(settings).connect() as connection:
        connection.execute(
            """INSERT INTO projects(id, name, created_at, updated_at)
               VALUES ('p', 'Project', '2026-01-01', '2026-01-01')"""
        )
        for kind in ("pdf", "image", "recording"):
            source = insert_processing_source(
                connection,
                source_id=kind,
                project_id="p",
                filename="upload",
                sha256="digest",
                storage_path="path",
                language_hint="auto",
                page_count=0 if kind == "recording" else 1,
                now="2026-01-01",
                source_kind=kind,
            )
            assert source.source_kind == kind

        assert {row[0] for row in connection.execute("SELECT source_kind FROM sources")} == {
            "pdf", "image", "recording",
        }
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []


# Migration 33 renames these tables; the values are their names afterwards.
MIGRATION_33_TABLES = {
    "question_drafts": "questions",
    "draft_generation_jobs": "question_generation_jobs",
    "manual_draft_generation_operations": "manual_question_generations",
    "runtime_installation_jobs": "llm_installation_jobs",
}


def _version_32_settings(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, populate: Any
) -> Settings:
    """A database migrated to version 32 by the real migrations, then filled by `populate`."""

    settings = Settings(data_dir=tmp_path, api_token="test-token")
    with monkeypatch.context() as patch:
        patch.setattr(
            database_module,
            "MIGRATIONS",
            tuple(migration for migration in MIGRATIONS if migration[0] <= 32),
        )
        with Database(settings).connect() as connection:
            assert "status" in _columns(connection, "question_drafts")
            populate(connection)
    return settings


def _populate_version_32_questions(connection: sqlite3.Connection) -> None:
    connection.execute(
        """INSERT INTO projects(id, name, description, created_at, updated_at)
           VALUES ('p', 'Project', '', '2026-01-01', '2026-01-01')"""
    )
    # Each count is wrong on purpose: a writer stored the number it added, or nothing.
    for document_id, kind, count in (
        ("pages", "pdf", 1),
        ("talk", "recording", 0),
        ("empty", "image", 5),
    ):
        connection.execute(
            """INSERT INTO documents(
                   id, project_id, filename, sha256, storage_path, page_count, has_text,
                   status, created_at, extraction_method, exam_item_count, source_kind
               ) VALUES (?, 'p', ?, 'digest', ?, 1, 1, 'ready', '2026-01-01',
                         'text_layer', ?, ?)""",
            (document_id, f"{document_id}.src", f"{document_id}.src", count, kind),
        )
    for chunk_id, document_id, locator, start_ms, end_ms in (
        ("page-1", "pages", "page", None, None),
        ("page-2", "pages", "page", None, None),
        ("talk-1", "talk", "time", 1000, 4000),
    ):
        connection.execute(
            """INSERT INTO document_chunks(
                   id, project_id, document_id, page_number, chunk_index, text,
                   source_excerpt, created_at, locator_kind, start_ms, end_ms
               ) VALUES (?, 'p', ?, 1, 0, 'text', 'excerpt', '2026-01-01', ?, ?, ?)""",
            (chunk_id, document_id, locator, start_ms, end_ms),
        )
    for question_id, document_id, chunk_id, answer_key_source in (
        ("from-key", "pages", "page-1", "pdf"),
        ("inferred", "pages", "page-2", "ai_inferred"),
        ("typed", "pages", None, "manual"),
        ("spoken", "talk", "talk-1", "ai_inferred"),
        ("loose", None, None, "manual"),
    ):
        connection.execute(
            """INSERT INTO question_drafts(
                   id, project_id, document_id, chunk_id, question, choices_json, answer,
                   rationale, citation_page, source_excerpt, status, rejection_reason,
                   created_at, updated_at, answer_key_source, source_order,
                   source_question_number, item_kind, group_key, group_prompt, confidence
               ) VALUES (?, 'p', ?, ?, ?, '["A", "B"]', 'A', 'Because A.', 2, 'excerpt',
                         'approved', NULL, '2026-01-02', '2026-01-03', ?, 1, '1',
                         'single_choice', 'group', 'Read the passage.', 0.75)""",
            (question_id, document_id, chunk_id, f"Question {question_id}?", answer_key_source),
        )
    for job_id, chunk_id, strategy, status, phase, error in (
        ("job-done", "page-1", "deterministic_only", "succeeded", "completed", None),
        ("job-failed", "page-2", "deterministic_only", "failed", "completed", "model stopped"),
        ("job-running", "page-1", "hybrid_reasoning", "running", "writing", None),
        ("job-waiting", "talk-1", "deterministic_only", "pending", "queued", None),
    ):
        document_id = "talk" if chunk_id == "talk-1" else "pages"
        connection.execute(
            """INSERT INTO draft_generation_jobs(
                   id, project_id, document_id, chunk_id, source_chunk_id, page_number,
                   strategy, status, provider, model, generated_count, retry_count, last_error,
                   created_at, updated_at, effective_provider, effective_model,
                   fallback_reason, phase, cancellable
               ) VALUES (?, 'p', ?, ?, ?, 1, ?, ?, 'ollama', 'model', 2, 1, ?, '2026-01-02',
                         '2026-01-03', 'ollama', 'model', NULL, ?, 0)""",
            (job_id, document_id, chunk_id, chunk_id, strategy, status, error, phase),
        )
    for operation_id, status, blocks in (
        ("manual-done", "succeeded", '[{"page_number": 2, "reason": "unreadable"}]'),
        ("manual-canceled", "canceled", "[]"),
    ):
        connection.execute(
            """INSERT INTO manual_draft_generation_operations(
                   id, project_id, document_id, limit_count, strategy, status, phase,
                   cancellable, provider, model, effective_provider, effective_model,
                   fallback_reason, generated_count, error, created_at, updated_at,
                   commit_started_at, unavailable_blocks_json
               ) VALUES (?, 'p', 'pages', 10, 'hybrid_reasoning', ?, 'completed', 0,
                         'ollama', 'model', NULL, NULL, 'fallback', 3, NULL, '2026-01-02',
                         '2026-01-03', '2026-01-03', ?)""",
            (operation_id, status, blocks),
        )
    connection.execute(
        """INSERT INTO practice_sessions(
               id, project_id, question_ids_json, status, created_at, completed_at, mode,
               source_document_id, requested_question_count
           ) VALUES ('session', 'p', '["from-key", "inferred"]', 'completed', '2026-01-04',
                     '2026-01-05', 'random_draw', 'pages', 2)"""
    )
    connection.execute(
        """INSERT INTO practice_session_questions(
               session_id, project_id, question_id, question_order, question, choices_json,
               correct_answer, rationale, citation_page, source_excerpt, created_at,
               document_id
           ) VALUES ('session', 'p', 'from-key', 0, 'Question from-key?', '["A", "B"]', 'A',
                     'Because A.', 2, 'excerpt', '2026-01-04', 'pages')"""
    )
    for attempt_id, question_id, answer, correct in (
        ("right", "from-key", "A", 1),
        ("wrong", "inferred", "B", 0),
    ):
        connection.execute(
            """INSERT INTO practice_attempts(
                   id, session_id, project_id, question_id, selected_answer, is_correct,
                   created_at
               ) VALUES (?, 'session', 'p', ?, ?, ?, '2026-01-05')""",
            (attempt_id, question_id, answer, correct),
        )
    connection.execute(
        """INSERT INTO runtime_installation_jobs(
               id, kind, provider, model, status, phase, cancellable, detail, completed,
               total, error, created_at, updated_at, commit_started_at
           ) VALUES ('install', 'model', 'ollama', 'model', 'waiting_for_user', 'consent', 1,
                     'Waiting for consent.', 10, 100, NULL, '2026-01-02', '2026-01-03', NULL)"""
    )


def _rows(connection: sqlite3.Connection, table: str) -> dict[str, dict[str, Any]]:
    cursor = connection.execute(f"SELECT * FROM {table}")
    names = [column[0] for column in cursor.description]
    return {str(row[0]): dict(zip(names, row)) for row in cursor.fetchall()}


def _normalised_schema(connection: sqlite3.Connection) -> list[tuple[str, str, str, str]]:
    """sqlite_master without the whitespace a statement's layout or an ALTER left behind."""

    return sorted(
        (str(kind), str(name), str(table), " ".join(str(sql).split()))
        for kind, name, table, sql in connection.execute(
            "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL"
        )
    )


def test_migration_33_renames_questions_and_generation_tables_and_keeps_every_row(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _version_32_settings(tmp_path, monkeypatch, _populate_version_32_questions)
    _stop_at(monkeypatch, 33)
    with closing(sqlite3.connect(settings.database_path)) as connection:
        before_counts = _row_counts(connection)
        before = {table: _rows(connection, table) for table in MIGRATION_33_TABLES}
        before_attempts = _rows(connection, "practice_attempts")
        before_documents = _rows(connection, "documents")
        # The version-32 trigger placed the recording's question at its time span.
        assert before["question_drafts"]["spoken"]["citation_locator_kind"] == "time"

    with Database(settings).connect() as connection:
        after_counts = _row_counts(connection)
        after = {new: _rows(connection, new) for new in MIGRATION_33_TABLES.values()}
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        document_columns = _columns(connection, "documents")
        question_columns = _columns(connection, "questions")
        attempt_keys = [
            tuple(row)[2:5]
            for row in connection.execute("PRAGMA foreign_key_list(practice_attempts)")
        ]
        counts = {
            row[0]: row[1]
            for row in connection.execute("SELECT id, question_count FROM documents")
        }
        objects = {
            (str(row[0]), str(row[1]))
            for row in connection.execute(
                "SELECT type, name FROM sqlite_master WHERE type IN ('index', 'trigger')"
                " AND name NOT LIKE 'sqlite_autoindex_%'"
            )
        }
        after_attempts = _rows(connection, "practice_attempts")
        after_documents = _rows(connection, "documents")

    # Every row is kept: the renamed tables hold what the old ones held, the rest is unchanged.
    renamed_counts = {
        MIGRATION_33_TABLES.get(table, table): count for table, count in before_counts.items()
    }
    renamed_counts["schema_migrations"] += 1
    assert after_counts == renamed_counts
    assert set(MIGRATION_33_TABLES).isdisjoint(after_counts)

    expected_questions = {}
    for question_id, row in before["question_drafts"].items():
        kept = {
            name: value
            for name, value in row.items()
            if name not in {"status", "rejection_reason"}
        }
        if kept["answer_key_source"] == "pdf":
            kept["answer_key_source"] = "source"
        expected_questions[question_id] = kept
    assert after["questions"] == expected_questions
    assert after["questions"]["from-key"]["answer_key_source"] == "source"
    for old, new in MIGRATION_33_TABLES.items():
        if old != "question_drafts":
            assert after[new] == before[old], new
    assert after_attempts == before_attempts

    # Only the count column changes in documents, and it counts every question of the source.
    assert {"status", "rejection_reason"}.isdisjoint(question_columns)
    assert "exam_item_count" not in document_columns
    assert document_columns["question_count"] == "0"
    assert counts == {"pages": 3, "talk": 1, "empty": 0}
    for document_id, row in before_documents.items():
        expected = {name: value for name, value in row.items() if name != "exam_item_count"}
        expected["question_count"] = counts[document_id]
        assert after_documents[document_id] == expected

    # The practice attempts now reference questions; no index or trigger keeps an old name.
    assert ("questions", "question_id", "id") in attempt_keys
    assert objects >= {
        ("index", "idx_questions_project_created"),
        ("index", "idx_practice_attempts_wrong"),
        ("index", "idx_question_generation_jobs_document"),
        ("index", "idx_question_generation_jobs_status"),
        ("index", "idx_manual_question_generations_document"),
        ("index", "idx_manual_question_generations_one_active"),
        ("index", "idx_llm_installation_jobs_updated"),
        ("index", "idx_llm_installation_jobs_one_active_kind"),
        ("trigger", "trg_questions_audio_locator_insert"),
        ("trigger", "trg_question_generation_jobs_validate_chunk_insert"),
        ("trigger", "trg_question_generation_jobs_validate_chunk_update"),
        ("trigger", "trg_question_generation_jobs_immutable_attribution"),
    }
    old_words = ("draft", "runtime_installation", "exam_item")
    assert [name for _kind, name in objects if any(word in name for word in old_words)] == []
    with closing(sqlite3.connect(settings.database_path)) as connection:
        schema_sql = " ".join(row[0] for row in connection.execute(
            "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL"
        ))
    assert [word for word in old_words if word in schema_sql] == []


def test_migration_33_triggers_and_keys_still_hold_on_the_renamed_tables(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _version_32_settings(tmp_path, monkeypatch, _populate_version_32_questions)
    _stop_at(monkeypatch, 33)
    with Database(settings).connect() as connection:
        # A question written from a recording's chunk cites the chunk's time span.
        connection.execute(
            """INSERT INTO questions(
                   id, project_id, document_id, chunk_id, question, choices_json,
                   citation_page, created_at, updated_at
               ) VALUES ('new', 'p', 'talk', 'talk-1', 'New?', '["A", "B"]', 3,
                         '2026-02-01', '2026-02-01')"""
        )
        cited = connection.execute(
            """SELECT citation_locator_kind, citation_start_ms, citation_end_ms, citation_page
               FROM questions WHERE id = 'new'"""
        ).fetchone()
        assert tuple(cited) == ("time", 1000, 4000, None)

        # A job's chunk must belong to its document, on insert and on update.
        with pytest.raises(sqlite3.IntegrityError, match="question job chunk must belong"):
            connection.execute(
                """INSERT INTO question_generation_jobs(
                       id, project_id, document_id, chunk_id, source_chunk_id, page_number,
                       strategy, status, created_at, updated_at
                   ) VALUES ('stray', 'p', 'pages', 'talk-1', 'talk-1', 1,
                             'deterministic_only', 'pending', '2026-02-01', '2026-02-01')"""
            )
        with pytest.raises(sqlite3.IntegrityError, match="question job chunk must belong"):
            connection.execute(
                "UPDATE question_generation_jobs SET chunk_id = 'talk-1' WHERE id = 'job-done'"
            )
        # Its attribution never changes.
        with pytest.raises(sqlite3.IntegrityError, match="question job attribution is immutable"):
            connection.execute(
                "UPDATE question_generation_jobs SET document_id = 'talk' WHERE id = 'job-done'"
            )
        # One active manual generation per source, one active installation per kind.
        connection.execute(
            """INSERT INTO manual_question_generations(
                   id, project_id, document_id, limit_count, strategy, status, phase,
                   cancellable, provider, model, created_at, updated_at
               ) VALUES ('active', 'p', 'pages', 5, 'hybrid_reasoning', 'running', 'writing',
                         1, 'ollama', 'model', '2026-02-01', '2026-02-01')"""
        )
        with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"):
            connection.execute(
                """INSERT INTO manual_question_generations(
                       id, project_id, document_id, limit_count, strategy, status, phase,
                       cancellable, provider, model, created_at, updated_at
                   ) VALUES ('second', 'p', 'pages', 5, 'hybrid_reasoning', 'queued',
                             'queued', 1, 'ollama', 'model', '2026-02-01', '2026-02-01')"""
            )
        with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"):
            connection.execute(
                """INSERT INTO llm_installation_jobs(
                       id, kind, provider, model, status, phase, cancellable, detail,
                       created_at, updated_at
                   ) VALUES ('again', 'model', 'ollama', 'model', 'queued', 'queued', 1, '',
                             '2026-02-01', '2026-02-01')"""
            )
        # Deleting a question deletes its attempts; an attempt needs an existing question.
        connection.execute("DELETE FROM questions WHERE id = 'inferred'")
        assert [
            row[0] for row in connection.execute("SELECT id FROM practice_attempts ORDER BY id")
        ] == ["right"]
        with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY"):
            connection.execute(
                """INSERT INTO practice_attempts(
                       id, session_id, project_id, question_id, selected_answer, is_correct,
                       created_at
                   ) VALUES ('orphan', 'session', 'p', 'gone', 'A', 1, '2026-02-01')"""
            )
        connection.rollback()


def test_migration_33_runs_once_and_a_fresh_database_has_the_same_schema(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _version_32_settings(
        tmp_path / "upgraded", monkeypatch, _populate_version_32_questions
    )
    _stop_at(monkeypatch, 33)
    with Database(settings).connect() as connection:
        schema = _normalised_schema(connection)
        rows = {table: _rows(connection, table) for table in MIGRATION_33_TABLES.values()}
        connection.execute("UPDATE schema_migrations SET applied_at = 'kept' WHERE version = 33")

    # A second open is a no-op: migration 33 does not run again and nothing changes.
    with Database(settings).connect() as connection:
        assert connection.execute(
            "SELECT applied_at FROM schema_migrations WHERE version = 33"
        ).fetchone()[0] == "kept"
        assert _normalised_schema(connection) == schema
        assert {table: _rows(connection, table) for table in rows} == rows

    fresh = Settings(data_dir=tmp_path / "fresh", api_token="test-token")
    with Database(fresh).connect() as connection:
        assert _normalised_schema(connection) == schema


# Every name migration 33 changes, old to new. Besides the tables: their indexes and triggers,
# the column it renames, and the words of the trigger messages that named drafts.
_MIGRATION_33_NAMES = {
    **MIGRATION_33_TABLES,
    "exam_item_count": "question_count",
    "idx_question_drafts_project_status": "idx_questions_project_created",
    "idx_draft_generation_jobs_document": "idx_question_generation_jobs_document",
    "idx_draft_generation_jobs_status": "idx_question_generation_jobs_status",
    "idx_manual_draft_operations_document": "idx_manual_question_generations_document",
    "idx_manual_draft_operations_one_active": "idx_manual_question_generations_one_active",
    "idx_runtime_installation_jobs_updated": "idx_llm_installation_jobs_updated",
    "idx_runtime_installation_jobs_one_active_kind": "idx_llm_installation_jobs_one_active_kind",
    "trg_question_drafts_audio_locator_insert": "trg_questions_audio_locator_insert",
    "trg_draft_generation_jobs_validate_chunk_insert": (
        "trg_question_generation_jobs_validate_chunk_insert"
    ),
    "trg_draft_generation_jobs_validate_chunk_update": (
        "trg_question_generation_jobs_validate_chunk_update"
    ),
    "trg_draft_generation_jobs_immutable_attribution": (
        "trg_question_generation_jobs_immutable_attribution"
    ),
    "draft job": "question job",
}
# The only columns migration 33 drops, with the table that had them.
_MIGRATION_33_DROPPED = {("questions", "status"), ("questions", "rejection_reason")}


def _sql_text(sql: str | None, names: dict[str, str]) -> str:
    """One statement's text without layout or identifier quotes, with old names mapped."""

    text = " ".join(str(sql or "").replace('"', "").split())
    for old in sorted(names, key=len, reverse=True):
        text = re.sub(rf"\b{re.escape(old)}\b", names[old], text)
    return text


def _checks(table_sql: str) -> list[str]:
    """Every CHECK expression of a CREATE TABLE statement, column or table level."""

    found = []
    for match in re.finditer(r"\bCHECK\s*\(", table_sql, flags=re.IGNORECASE):
        depth, start = 0, match.end() - 1
        for position in range(start, len(table_sql)):
            depth += {"(": 1, ")": -1}.get(table_sql[position], 0)
            if depth == 0:
                found.append(table_sql[start : position + 1])
                break
    return sorted(found)


def _schema_meaning(
    connection: sqlite3.Connection, names: dict[str, str], dropped: set[tuple[str, str]]
) -> dict[str, Any]:
    """What the schema enforces, independent of column order and of ALTER-added columns.

    Columns with type, NOT NULL, default and key; foreign keys with their actions; CHECKs;
    every index (UNIQUE constraints and keys included) with its columns, order, uniqueness and
    partial predicate; trigger statements. Old names are mapped to new ones and the dropped
    columns are removed, so a database before migration 33 and after it must compare equal.
    """

    def name(value: str) -> str:
        return _sql_text(value, names)

    objects = connection.execute(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
    ).fetchall()
    meaning: dict[str, Any] = {}
    for kind, object_name, table_name, sql in objects:
        table = name(table_name)
        if kind == "table":
            columns = {
                (row[1], row[2], row[3], row[4], row[5], row[6])
                for row in connection.execute(f'PRAGMA table_xinfo("{object_name}")')
                if (table, name(row[1])) not in dropped
            }
            indexes = set()
            for _seq, index, unique, origin, partial in connection.execute(
                f'PRAGMA index_list("{object_name}")'
            ):
                indexed = tuple(
                    (name(str(row[2])), row[3], row[4], row[5])
                    for row in connection.execute(f'PRAGMA index_xinfo("{index}")')
                    if row[5] and (table, name(str(row[2]))) not in dropped
                )
                index_sql = connection.execute(
                    "SELECT sql FROM sqlite_master WHERE name = ?", (index,)
                ).fetchone()[0]
                predicate = (
                    _sql_text(index_sql, names).split(" WHERE ", 1)[1] if partial else None
                )
                # A constraint's index has a generated name; a created index keeps its own.
                label = name(index) if index_sql is not None else f"({origin})"
                indexes.add((label, unique, origin, partial, indexed, predicate))
            meaning[f"table {table}"] = {
                "columns": {(name(column[0]), *column[1:]) for column in columns},
                "foreign_keys": {
                    (name(row[2]), name(row[3]), row[4], row[5], row[6], row[7])
                    for row in connection.execute(f'PRAGMA foreign_key_list("{object_name}")')
                },
                "checks": [_sql_text(check, names) for check in _checks(sql)],
                "indexes": indexes,
            }
        elif kind == "trigger":
            meaning[f"trigger {name(object_name)}"] = (table, _sql_text(sql, names))
        elif kind == "view":
            meaning[f"view {name(object_name)}"] = _sql_text(sql, names)
    return meaning


def test_migration_33_keeps_every_constraint_index_and_trigger_of_the_tables_it_rebuilds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Independent of the fresh-database comparison, which goes through migration 33 twice
    # and so cannot see a constraint it drops: the schema before migration 33, renamed and
    # without the two dropped columns, must be what the schema after it enforces.
    settings = _version_32_settings(tmp_path, monkeypatch, _populate_version_32_questions)
    _stop_at(monkeypatch, 33)
    with closing(sqlite3.connect(settings.database_path)) as connection:
        before = _schema_meaning(connection, _MIGRATION_33_NAMES, _MIGRATION_33_DROPPED)
    with Database(settings).connect() as connection:
        after = _schema_meaning(connection, {}, set())

    # The index that sorted questions by status loses that column with the column itself.
    assert before["table questions"]["indexes"] >= {
        ("idx_questions_project_created", 0, "c", 0,
         (("project_id", 0, "BINARY", 1), ("created_at", 0, "BINARY", 1)), None),
    }
    # What the generation queue and the one-active rules depend on, spelled out.
    jobs = after["table question_generation_jobs"]
    assert ("chunk_id", "TEXT", 0, None, 0, 0) in jobs["columns"]
    assert ("source_chunk_id", "TEXT", 1, None, 0, 0) in jobs["columns"]
    assert ("document_chunks", "chunk_id", "id", "NO ACTION", "SET NULL", "NONE") in jobs[
        "foreign_keys"
    ]
    assert jobs["checks"] == ["(chunk_id IS NULL OR chunk_id = source_chunk_id)"]
    assert any(
        index[2] == "u" and [column[0] for column in index[4]] == [
            "document_id", "chunk_id", "strategy",
        ]
        for index in jobs["indexes"]
    )
    assert {
        index[0]: index[5]
        for table in ("manual_question_generations", "llm_installation_jobs")
        for index in after[f"table {table}"]["indexes"]
        if index[3]
    } == {
        "idx_manual_question_generations_one_active": (
            "status IN ('queued', 'running', 'cancel_requested')"
        ),
        "idx_llm_installation_jobs_one_active_kind": (
            "status IN ( 'queued', 'running', 'cancel_requested', 'waiting_for_user' )"
        ),
    }
    assert after == before


def test_migration_33_keeps_the_queue_and_one_active_rules_working(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from cert_prep_backend.authoring.infrastructure.question_generation_jobs import (
        enqueue_chunk_job,
    )

    # Live code writes the jobs, so the database is migrated to the end: the rules
    # migration 33 created must hold under the names the later migrations give them.
    settings = _version_32_settings(tmp_path, monkeypatch, _populate_version_32_questions)
    database = Database(settings)

    class Projects:
        def exists(self, project_id: str) -> bool:
            return project_id == "p"

    class Sources:
        def chunk(self, project_id: str, source_id: str, chunk_id: str) -> None:
            return None

    # Enqueueing a chunk that already has a job of that strategy returns that job.
    job = enqueue_chunk_job(
        database, project_id="p", source_id="pages", chunk_id="page-1", page_number=1,
        strategy="deterministic_only", provider="ollama", model="model",
        projects=Projects(), sources=Sources(),
    )
    assert job.id == "job-done"
    with database.connect() as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM question_generation_jobs WHERE chunk_id = 'page-1'"
        ).fetchone()[0] == 2

    def manual(connection: sqlite3.Connection, operation_id: str, status: str) -> None:
        connection.execute(
            """INSERT INTO manual_question_generations(
                   id, project_id, source_id, limit_count, strategy, status, phase,
                   cancellable, provider, model, created_at, updated_at
               ) VALUES (?, 'p', 'pages', 5, 'hybrid_reasoning', ?, 'completed', 0,
                         'ollama', 'model', '2026-02-01', '2026-02-01')""",
            (operation_id, status),
        )

    def installation(connection: sqlite3.Connection, job_id: str, status: str) -> None:
        connection.execute(
            """INSERT INTO llm_installation_jobs(
                   id, kind, provider, model, status, phase, cancellable, detail,
                   created_at, updated_at
               ) VALUES (?, 'model', 'ollama', 'model', ?, 'completed', 0, '',
                         '2026-02-01', '2026-02-01')""",
            (job_id, status),
        )

    with database.connect() as connection:
        # The source already has a succeeded and a canceled generation: ended ones add up.
        manual(connection, "done-again", "succeeded")
        manual(connection, "failed", "failed")
        manual(connection, "active", "queued")
        with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"):
            manual(connection, "second-active", "running")
        # The migrated installation job is waiting for consent, so it is the active one.
        installation(connection, "ended", "succeeded")
        installation(connection, "ended-too", "failed")
        with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"):
            installation(connection, "second-active", "queued")
        assert connection.execute(
            "SELECT COUNT(*) FROM manual_question_generations WHERE source_id = 'pages'"
        ).fetchone()[0] == 5
        assert connection.execute(
            "SELECT COUNT(*) FROM llm_installation_jobs WHERE kind = 'model'"
        ).fetchone()[0] == 3


def test_migration_33_deletes_rejected_questions_and_keeps_every_other_status(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def populate(connection: sqlite3.Connection) -> None:
        _populate_version_32_questions(connection)
        # Statuses only releases before Cert Prep wrote: awaiting approval, rejected with a
        # reason, and a value no release defined. All on the source the approved ones share.
        connection.execute("UPDATE question_drafts SET status = 'draft' WHERE id = 'typed'")
        connection.execute(
            "UPDATE question_drafts SET status = 'needs_review' WHERE id = 'inferred'"
        )
        connection.execute(
            """INSERT INTO question_drafts(
                   id, project_id, document_id, chunk_id, question, choices_json, answer,
                   rationale, citation_page, source_excerpt, status, rejection_reason,
                   created_at, updated_at, answer_key_source
               ) VALUES ('refused', 'p', 'pages', 'page-1', 'Refused?', '["A", "B"]', 'B',
                         NULL, 1, 'excerpt', 'rejected', 'No supported answer.',
                         '2026-01-02', '2026-01-03', 'ai_inferred')"""
        )
        connection.execute(
            """INSERT INTO practice_attempts(
                   id, session_id, project_id, question_id, selected_answer, is_correct,
                   created_at
               ) VALUES ('on-refused', 'session', 'p', 'refused', 'A', 0, '2026-01-05')"""
        )

    settings = _version_32_settings(tmp_path, monkeypatch, populate)
    _stop_at(monkeypatch, 33)
    with closing(sqlite3.connect(settings.database_path)) as connection:
        before = _rows(connection, "question_drafts")
        before_attempts = _rows(connection, "practice_attempts")
        assert before["from-key"]["status"] == "approved"
        assert before["refused"]["rejection_reason"] == "No supported answer."

    with Database(settings).connect() as connection:
        questions = _rows(connection, "questions")
        attempts = _rows(connection, "practice_attempts")
        counts = {
            row[0]: row[1]
            for row in connection.execute("SELECT id, question_count FROM documents")
        }
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        connection.execute("UPDATE schema_migrations SET applied_at = 'kept' WHERE version = 33")

    # The rejected question is gone, with the attempt that pointed at it.
    assert "refused" not in questions
    assert attempts == {
        attempt_id: row for attempt_id, row in before_attempts.items()
        if attempt_id != "on-refused"
    }
    assert set(attempts) == {"right", "wrong"}
    # Approved, awaiting-approval and unknown statuses are questions with all their fields.
    expected = {}
    for question_id, row in before.items():
        if question_id == "refused":
            continue
        kept = {
            name: value for name, value in row.items()
            if name not in {"status", "rejection_reason"}
        }
        if kept["answer_key_source"] == "pdf":
            kept["answer_key_source"] = "source"
        expected[question_id] = kept
    assert questions == expected
    assert {"from-key", "inferred", "typed"} <= set(questions)
    # Each source counts the questions it has left.
    assert counts == {"pages": 3, "talk": 1, "empty": 0}

    # A second open is a no-op.
    with Database(settings).connect() as connection:
        assert connection.execute(
            "SELECT applied_at FROM schema_migrations WHERE version = 33"
        ).fetchone()[0] == "kept"
        assert _rows(connection, "questions") == questions
        assert _rows(connection, "practice_attempts") == attempts


# Migration 34 renames these tables; the values are their names afterwards.
MIGRATION_34_TABLES = {
    "documents": "sources",
    "document_chunks": "source_chunks",
    "document_operations": "source_operations",
}
# Every name migration 34 changes, old to new: tables, the columns that referred to a
# document, and the indexes that said document. Triggers keep their names.
_MIGRATION_34_NAMES = {
    **MIGRATION_34_TABLES,
    "document_id": "source_id",
    "source_document_id": "source_id",
    "idx_documents_project": "idx_sources_project",
    "idx_chunks_document": "idx_chunks_source",
    "idx_document_operations_project": "idx_source_operations_project",
    "idx_document_operations_document": "idx_source_operations_source",
    "idx_document_operations_one_active_document": "idx_source_operations_one_active_source",
    "idx_question_generation_jobs_document": "idx_question_generation_jobs_source",
    "idx_manual_question_generations_document": "idx_manual_question_generations_source",
}
# The tables whose rows migration 34 copies into a rebuilt table, under their old names.
_MIGRATION_34_COPIED = (
    "documents", "document_chunks", "document_operations", "capture_review_sessions",
    "questions", "question_generation_jobs", "manual_question_generations",
    "practice_sessions", "practice_session_questions", "practice_attempts",
)


def _version_33_settings(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, populate: Any
) -> Settings:
    """A database migrated to version 33 by the real migrations, then filled by `populate`."""

    settings = Settings(data_dir=tmp_path, api_token="test-token")
    with monkeypatch.context() as patch:
        patch.setattr(
            database_module,
            "MIGRATIONS",
            tuple(migration for migration in MIGRATIONS if migration[0] <= 33),
        )
        with Database(settings).connect() as connection:
            assert "documents" in _row_counts(connection)
            populate(connection)
    return settings


def _populate_version_33_sources(connection: sqlite3.Connection) -> None:
    """Rows in every table migration 34 rebuilds: a PDF, an image and a recording with their
    chunks, operations ended and active, questions, jobs, generations, a capture review, and
    practice sessions of each mode with their questions and attempts."""

    connection.execute(
        """INSERT INTO projects(id, name, description, created_at, updated_at)
           VALUES ('p', 'Project', '', '2026-01-01', '2026-01-01')"""
    )
    for document_id, kind, pages, processed, duration in (
        ("pages", "pdf", 2, 2, None),
        ("photo", "image", 1, 1, None),
        ("talk", "recording", 0, 2, 6000),
    ):
        connection.execute(
            """INSERT INTO documents(
                   id, project_id, filename, sha256, storage_path, page_count, has_text,
                   status, created_at, extraction_method, question_count, ocr_device,
                   processed_page_count, language_hint, updated_at, content_profile,
                   classification_detail, source_kind, duration_ms, transcription_status,
                   translation_status, extraction_provenance
               ) VALUES (?, 'p', ?, 'digest', ?, ?, 1, 'ready', '2026-01-01', 'text_layer', 2,
                         'cpu', ?, 'ja', '2026-01-02', 'study_material', 'detail', ?, ?,
                         'not_applicable', 'not_applicable', '{"status": "recorded"}')""",
            (document_id, f"{document_id}.src", f"{document_id}.src", pages, processed, kind,
             duration),
        )
    for chunk_id, document_id, page, locator, start_ms, end_ms in (
        ("page-1", "pages", 1, "page", None, None),
        ("page-2", "pages", 2, "page", None, None),
        ("photo-1", "photo", 1, "page", None, None),
        ("talk-1", "talk", 0, "time", 0, 3000),
        ("talk-2", "talk", 0, "time", 3000, 6000),
    ):
        connection.execute(
            """INSERT INTO document_chunks(
                   id, project_id, document_id, page_number, chunk_index, text, raw_text,
                   source_excerpt, created_at, locator_kind, start_ms, end_ms,
                   translated_text, translation_source_revision
               ) VALUES (?, 'p', ?, ?, 0, 'text', 'raw', 'excerpt', '2026-01-01', ?, ?, ?,
                         'translated', 1)""",
            (chunk_id, document_id, page, locator, start_ms, end_ms),
        )
    for operation_id, document_id, status, phase, error in (
        ("op-pages-done", "pages", "succeeded", "completed", None),
        ("op-pages-failed", "pages", "failed", "failed", "Document processing failed."),
        ("op-pages-active", "pages", "running", "extracting", None),
        ("op-photo-done", "photo", "succeeded", "completed", None),
        ("op-talk-canceled", "talk", "canceled", "canceled", None),
        ("op-talk-active", "talk", "cancel_requested", "canceling", None),
        ("op-unattached", None, "queued", "queued", None),
    ):
        connection.execute(
            """INSERT INTO document_operations(
                   id, project_id, document_id, status, phase, cancellable, error,
                   created_at, updated_at
               ) VALUES (?, 'p', ?, ?, ?, 0, ?, '2026-01-02', '2026-01-03')""",
            (operation_id, document_id, status, phase, error),
        )
    connection.execute(
        """INSERT INTO capture_review_sessions(
               id, project_id, document_id, operation_id, runtime_capture_id, status,
               review_revision, expires_at, created_at, updated_at, confirm_request_id,
               confirm_review_digest, last_event_sequence, runtime_ingestion_id
           ) VALUES ('review', 'p', 'photo', 'op-photo-done', 'capture', 'completed', 3,
                     '2026-01-09', '2026-01-02', '2026-01-03', 'request', 'digest', 7,
                     'ingestion')"""
    )
    for question_id, document_id, chunk_id in (
        ("q-page", "pages", "page-1"),
        ("q-page-2", "pages", "page-2"),
        ("q-talk", "talk", "talk-1"),
        ("q-typed", "pages", None),
        ("q-loose", None, None),
    ):
        connection.execute(
            """INSERT INTO questions(
                   id, project_id, document_id, chunk_id, question, choices_json, answer,
                   answer_key_source, rationale, citation_page, source_excerpt, confidence,
                   source_order, source_question_number, item_kind, group_key, group_prompt,
                   created_at, updated_at
               ) VALUES (?, 'p', ?, ?, ?, '["A", "B"]', 'A', 'source', 'Because A.', 1,
                         'excerpt', 0.5, 1, '1', 'single_choice', 'group', 'Read.',
                         '2026-01-02', '2026-01-03')""",
            (question_id, document_id, chunk_id, f"Question {question_id}?"),
        )
    for job_id, document_id, chunk_id, page, status in (
        ("job-page", "pages", "page-1", 1, "succeeded"),
        ("job-page-running", "pages", "page-2", 2, "running"),
        ("job-talk", "talk", "talk-1", 0, "pending"),
    ):
        connection.execute(
            """INSERT INTO question_generation_jobs(
                   id, project_id, document_id, chunk_id, source_chunk_id, page_number,
                   strategy, status, phase, cancellable, provider, model, generated_count,
                   retry_count, last_error, created_at, updated_at
               ) VALUES (?, 'p', ?, ?, ?, ?, 'deterministic_only', ?, 'queued', 1, 'ollama',
                         'model', 1, 0, NULL, '2026-01-02', '2026-01-03')""",
            (job_id, document_id, chunk_id, chunk_id, page, status),
        )
    for generation_id, document_id, status in (
        ("manual-done", "pages", "succeeded"),
        ("manual-active", "pages", "running"),
        ("manual-talk", "talk", "canceled"),
    ):
        connection.execute(
            """INSERT INTO manual_question_generations(
                   id, project_id, document_id, limit_count, strategy, status, phase,
                   cancellable, provider, model, generated_count, unavailable_blocks_json,
                   created_at, updated_at
               ) VALUES (?, 'p', ?, 5, 'hybrid_reasoning', ?, 'writing', 1, 'ollama',
                         'model', 2, '[{"page_number": 2, "reason": "unreadable"}]',
                         '2026-01-02', '2026-01-03')""",
            (generation_id, document_id, status),
        )
    for session_id, status, mode, document_id in (
        ("drawn", "completed", "random_draw", None),
        ("whole", "abandoned", "full_document", "pages"),
        ("whole-talk", "active", "full_document", "talk"),
        ("retry", "completed", "review_retry", None),
    ):
        connection.execute(
            """INSERT INTO practice_sessions(
                   id, project_id, question_ids_json, status, created_at, completed_at, mode,
                   source_document_id, requested_question_count, random_seed, abandoned_at
               ) VALUES (?, 'p', '["q-page", "q-talk"]', ?, '2026-01-04', NULL, ?, ?, 2, 7,
                         NULL)""",
            (session_id, status, mode, document_id),
        )
        for order, question_id, question_document in (
            (0, "q-page", "pages"),
            (1, "q-talk", "talk"),
        ):
            connection.execute(
                """INSERT INTO practice_session_questions(
                       session_id, project_id, question_id, question_order, question,
                       choices_json, correct_answer, rationale, citation_page, source_excerpt,
                       created_at, document_id
                   ) VALUES (?, 'p', ?, ?, 'Question?', '["A", "B"]', 'A', 'Because A.', 1,
                             'excerpt', '2026-01-04', ?)""",
                (session_id, question_id, order, question_document),
            )
        connection.execute(
            """INSERT INTO practice_attempts(
                   id, session_id, project_id, question_id, selected_answer, is_correct,
                   created_at
               ) VALUES (?, ?, 'p', 'q-page', 'B', 0, '2026-01-05')""",
            (f"attempt-{session_id}", session_id),
        )


def _keyed_rows(
    connection: sqlite3.Connection, table: str, names: dict[str, str]
) -> dict[str, dict[str, Any]]:
    """A table's rows by primary key, with each column name mapped through `names`."""

    cursor = connection.execute(f"SELECT * FROM {table}")
    columns = [names.get(column[0], column[0]) for column in cursor.description]
    rows = [dict(zip(columns, row)) for row in cursor.fetchall()]
    if "question_order" in columns:
        # practice_session_questions: the session and the question.
        return {f"{row['session_id']}/{row['question_id']}": row for row in rows}
    return {str(row["id"]): row for row in rows}


def _source_rows(connection: sqlite3.Connection, migrated: bool) -> dict[str, Any]:
    """Every row migration 34 copies, under the names it has after migration 34."""

    return {
        MIGRATION_34_TABLES.get(table, table): _keyed_rows(
            connection,
            MIGRATION_34_TABLES.get(table, table) if migrated else table,
            {} if migrated else _MIGRATION_34_NAMES,
        )
        for table in _MIGRATION_34_COPIED
    }


def test_migration_34_renames_the_source_tables_and_keeps_every_row(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _version_33_settings(tmp_path, monkeypatch, _populate_version_33_sources)
    with closing(sqlite3.connect(settings.database_path)) as connection:
        before_counts = _row_counts(connection)
        before = _source_rows(connection, migrated=False)

    with Database(settings).connect() as connection:
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        after_counts = _row_counts(connection)
        after = _source_rows(connection, migrated=True)
        schema_sql = " ".join(
            str(row[0])
            for row in connection.execute("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL")
        )
        objects = {str(row[0]) for row in connection.execute("SELECT name FROM sqlite_master")}

    # Every row is kept under the new table names; nothing else is added or lost.
    renamed_counts = {
        MIGRATION_34_TABLES.get(table, table): count for table, count in before_counts.items()
    }
    renamed_counts["schema_migrations"] += 1
    assert after_counts == renamed_counts
    assert set(MIGRATION_34_TABLES).isdisjoint(after_counts)
    assert after_counts["source_operations"] == 7
    assert after_counts["practice_session_questions"] == 8

    # Each value is kept; the only rewritten value is the whole-source practice mode.
    expected = {table: {key: dict(row) for key, row in rows.items()} for table, rows in before.items()}
    for row in expected["practice_sessions"].values():
        if row["mode"] == "full_document":
            row["mode"] = "full_source"
    assert after == expected
    assert {row["mode"] for row in after["practice_sessions"].values()} == {
        "random_draw", "full_source", "review_retry",
    }
    assert after["practice_sessions"]["whole-talk"]["source_id"] == "talk"
    assert after["practice_session_questions"]["whole/q-talk"]["source_id"] == "talk"
    assert after["sources"]["talk"]["source_kind"] == "recording"

    # No table, column, index or trigger keeps a name of the old aggregate. The word is left
    # only in the two chunk triggers' unchanged error text ("... belong to its document").
    for old in ("documents", "document_chunks", "document_operations", "document_id"):
        assert re.search(rf"\b{old}\b", schema_sql) is None, old
    assert [name for name in objects if "document" in name] == []
    assert schema_sql.count("document") == 2


def test_migration_34_keeps_every_constraint_index_and_trigger_of_the_tables_it_rebuilds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Independent of the fresh-database comparison, which goes through migration 34 twice:
    # the version-33 schema with the old names mapped to the new ones must be what the
    # schema after migration 34 enforces, apart from the one difference allowed here.
    settings = _version_33_settings(tmp_path, monkeypatch, _populate_version_33_sources)
    with closing(sqlite3.connect(settings.database_path)) as connection:
        before = _schema_meaning(connection, _MIGRATION_34_NAMES, set())
    with Database(settings).connect() as connection:
        after = _schema_meaning(connection, {}, set())

    # The one allowed difference: source_kind loses the default 'document', which no source
    # has had since migration 32; every writer names the kind.
    old_kind = ("source_kind", "TEXT", 1, "'document'", 0, 0)
    new_kind = ("source_kind", "TEXT", 1, None, 0, 0)
    assert old_kind in before["table sources"]["columns"]
    assert new_kind in after["table sources"]["columns"]
    before["table sources"]["columns"] = (
        before["table sources"]["columns"] - {old_kind}
    ) | {new_kind}

    # What the one-active rules, the cascades and the triggers depend on, spelled out.
    operations = after["table source_operations"]
    assert ("sources", "source_id", "id", "NO ACTION", "CASCADE", "NONE") in operations[
        "foreign_keys"
    ]
    assert (
        "idx_source_operations_one_active_source", 1, "c", 1,
        (("project_id", 0, "BINARY", 1), ("source_id", 0, "BINARY", 1)),
        "source_id IS NOT NULL AND status IN ('queued', 'running', 'cancel_requested')",
    ) in operations["indexes"]
    assert (
        "idx_chunks_source", 0, "c", 0,
        (("source_id", 0, "BINARY", 1), ("page_number", 0, "BINARY", 1)), None,
    ) in after["table source_chunks"]["indexes"]
    reviews = after["table capture_review_sessions"]
    assert {
        ("sources", "source_id", "id", "NO ACTION", "CASCADE", "NONE"),
        ("source_operations", "operation_id", "id", "NO ACTION", "CASCADE", "NONE"),
    } <= reviews["foreign_keys"]
    assert reviews["checks"] == ["(last_event_sequence >= 0)"]
    assert any(
        index[2] == "u" and [column[0] for column in index[4]] == ["project_id", "source_id"]
        for index in reviews["indexes"]
    )
    assert ("sources", "source_id", "id", "NO ACTION", "SET NULL", "NONE") in after[
        "table practice_sessions"
    ]["foreign_keys"]
    assert {
        ("sources", "source_id", "id", "NO ACTION", "SET NULL", "NONE"),
        ("source_chunks", "chunk_id", "id", "NO ACTION", "SET NULL", "NONE"),
    } <= after["table questions"]["foreign_keys"]
    assert any(
        index[2] == "u" and [column[0] for column in index[4]] == [
            "source_id", "chunk_id", "strategy",
        ]
        for index in after["table question_generation_jobs"]["indexes"]
    )
    assert sorted(key for key in after if key.startswith("trigger ")) == [
        "trigger trg_question_generation_jobs_immutable_attribution",
        "trigger trg_question_generation_jobs_validate_chunk_insert",
        "trigger trg_question_generation_jobs_validate_chunk_update",
        "trigger trg_questions_audio_locator_insert",
    ]
    assert after == before


def test_migration_34_keeps_the_one_active_rules_triggers_and_cascades_working(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _version_33_settings(tmp_path, monkeypatch, _populate_version_33_sources)

    def operation(
        connection: sqlite3.Connection, operation_id: str, source_id: str | None, status: str
    ) -> None:
        connection.execute(
            """INSERT INTO source_operations(
                   id, project_id, source_id, status, phase, cancellable, created_at,
                   updated_at
               ) VALUES (?, 'p', ?, ?, 'queued', 1, '2026-02-01', '2026-02-01')""",
            (operation_id, source_id, status),
        )

    with Database(settings).connect() as connection:
        # The migrated running operation is the active one of its source: a second active
        # one is refused, ended ones are not, and neither is an active one with no source.
        with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"):
            operation(connection, "second-active", "pages", "queued")
        operation(connection, "second-ended", "pages", "succeeded")
        operation(connection, "another-ended", "pages", "failed")
        operation(connection, "photo-active", "photo", "running")
        operation(connection, "unattached-too", None, "running")
        # One active manual generation per source still holds.
        with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"):
            connection.execute(
                """INSERT INTO manual_question_generations(
                       id, project_id, source_id, limit_count, strategy, status, phase,
                       cancellable, provider, model, created_at, updated_at
                   ) VALUES ('again', 'p', 'pages', 5, 'hybrid_reasoning', 'queued',
                             'queued', 1, 'ollama', 'model', '2026-02-01', '2026-02-01')"""
            )
        # One capture review per source.
        with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"):
            connection.execute(
                """INSERT INTO capture_review_sessions(
                       id, project_id, source_id, operation_id, status, expires_at,
                       created_at, updated_at
                   ) VALUES ('again', 'p', 'photo', 'photo-active', 'open', '2026-02-09',
                             '2026-02-01', '2026-02-01')"""
            )
        # The triggers read the renamed chunk table and columns.
        connection.execute(
            """INSERT INTO questions(
                   id, project_id, source_id, chunk_id, question, choices_json,
                   citation_page, created_at, updated_at
               ) VALUES ('spoken', 'p', 'talk', 'talk-2', 'Spoken?', '["A", "B"]', 3,
                         '2026-02-01', '2026-02-01')"""
        )
        assert tuple(connection.execute(
            """SELECT citation_locator_kind, citation_start_ms, citation_end_ms, citation_page
               FROM questions WHERE id = 'spoken'"""
        ).fetchone()) == ("time", 3000, 6000, None)
        with pytest.raises(sqlite3.IntegrityError, match="must belong to its document"):
            connection.execute(
                """INSERT INTO question_generation_jobs(
                       id, project_id, source_id, chunk_id, source_chunk_id, page_number,
                       strategy, status, created_at, updated_at
                   ) VALUES ('stray', 'p', 'pages', 'talk-1', 'talk-1', 1,
                             'deterministic_only', 'pending', '2026-02-01', '2026-02-01')"""
            )
        with pytest.raises(sqlite3.IntegrityError, match="must belong to its document"):
            connection.execute(
                "UPDATE question_generation_jobs SET chunk_id = 'talk-1' WHERE id = 'job-page'"
            )
        with pytest.raises(sqlite3.IntegrityError, match="attribution is immutable"):
            connection.execute(
                "UPDATE question_generation_jobs SET source_id = 'talk' WHERE id = 'job-page'"
            )

    with Database(settings).connect() as connection:
        # Deleting a source deletes what belongs to it and unlinks what only cites it.
        connection.execute("DELETE FROM sources WHERE id = 'talk'")
        for table in (
            "source_chunks", "source_operations", "question_generation_jobs",
            "manual_question_generations",
        ):
            assert connection.execute(
                f"SELECT COUNT(*) FROM {table} WHERE source_id = 'talk'"
            ).fetchone()[0] == 0, table
        assert tuple(connection.execute(
            "SELECT source_id, chunk_id FROM questions WHERE id = 'q-talk'"
        ).fetchone()) == (None, None)
        assert connection.execute(
            "SELECT source_id FROM practice_sessions WHERE id = 'whole-talk'"
        ).fetchone()[0] is None
        # The practice snapshot keeps the id it recorded: that column has no foreign key.
        assert connection.execute(
            """SELECT source_id FROM practice_session_questions
               WHERE session_id = 'whole' AND question_id = 'q-talk'"""
        ).fetchone()[0] == "talk"
        # Deleting the photo's operation deletes its capture review.
        connection.execute("DELETE FROM source_operations WHERE id = 'op-photo-done'")
        assert connection.execute(
            "SELECT COUNT(*) FROM capture_review_sessions"
        ).fetchone()[0] == 0
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []

        # Deleting the project deletes every row that belongs to it.
        connection.execute("DELETE FROM projects WHERE id = 'p'")
        for table in (
            "sources", "source_chunks", "source_operations", "questions",
            "question_generation_jobs", "manual_question_generations", "practice_sessions",
            "practice_session_questions", "practice_attempts",
        ):
            assert connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0, table


def test_migration_34_runs_once_and_a_fresh_database_has_the_same_schema(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _version_33_settings(
        tmp_path / "upgraded", monkeypatch, _populate_version_33_sources
    )
    with Database(settings).connect() as connection:
        schema = _normalised_schema(connection)
        rows = _source_rows(connection, migrated=True)
        connection.execute("UPDATE schema_migrations SET applied_at = 'kept' WHERE version = 34")

    # A second open is a no-op: migration 34 does not run again and nothing changes.
    with Database(settings).connect() as connection:
        assert connection.execute(
            "SELECT applied_at FROM schema_migrations WHERE version = 34"
        ).fetchone()[0] == "kept"
        assert _normalised_schema(connection) == schema
        assert _source_rows(connection, migrated=True) == rows

    fresh = Settings(data_dir=tmp_path / "fresh", api_token="test-token")
    with Database(fresh).connect() as connection:
        assert _normalised_schema(connection) == schema
