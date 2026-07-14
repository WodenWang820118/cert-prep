from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from cert_prep_backend.core.config import Settings
from cert_prep_backend.persistence import database as database_module
from cert_prep_backend.persistence.database import MIGRATIONS, Database


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

    assert document_columns["content_profile"] == "'unknown'"
    assert "classification_detail" in document_columns
    assert {
        "parse_wall_duration_ms",
        "render_duration_ms",
        "ocr_engine_duration_ms",
        "ocr_worker_count",
        "first_chunk_ms",
    } <= set(document_columns)
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
        "error",
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
    } <= set(runtime_installation_columns)


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
