from __future__ import annotations

from pathlib import Path
import sqlite3

import pytest

from cert_prep_backend.core.config import Settings
from cert_prep_backend.persistence import database as database_module
from cert_prep_backend.persistence.database import Database, MIGRATIONS


def test_saved_exam_runtime_metadata_columns_are_migrated(tmp_path: Path) -> None:
    db = Database(Settings(data_dir=tmp_path, api_token="test-token"))
    db.migrate()

    with db.connect() as connection:
        document_columns = _columns(connection, "documents")
        chunk_columns = _columns(connection, "document_chunks")
        draft_columns = _columns(connection, "question_drafts")
        draft_job_columns = _columns(connection, "draft_generation_jobs")
        manual_draft_operation_columns = _columns(
            connection, "manual_draft_generation_operations"
        )
        document_operation_columns = _columns(connection, "document_operations")
        runtime_installation_columns = _columns(
            connection, "runtime_installation_jobs"
        )
        session_columns = _columns(connection, "practice_sessions")
        session_question_columns = _columns(connection, "practice_session_questions")

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
        "effective_provider",
        "effective_model",
        "fallback_reason",
        "generated_count",
        "retry_count",
        "last_error",
        "phase",
        "cancellable",
    } <= set(draft_job_columns)
    assert {
        "id",
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


def test_migration_15_backfills_one_latest_active_session_per_project(
    tmp_path: Path,
) -> None:
    settings = Settings(data_dir=tmp_path, api_token="test-token")
    _create_v14_practice_fixture(settings.database_path)

    db = Database(settings)
    db.migrate()

    with db.connect() as connection:
        sessions = {
            row["id"]: row
            for row in connection.execute(
                "SELECT * FROM practice_sessions ORDER BY id"
            ).fetchall()
        }
        attempts = connection.execute(
            "SELECT id FROM practice_attempts ORDER BY id"
        ).fetchall()
        applied = connection.execute(
            "SELECT version FROM schema_migrations WHERE version = 15"
        ).fetchone()

        assert sessions["p1-complete"]["status"] == "completed"
        assert sessions["p1-complete"]["completed_at"] == "2026-01-01T04:00:00Z"
        assert sessions["p1-complete"]["abandoned_at"] is None
        assert sessions["p1-new-incomplete"]["status"] == "active"
        assert sessions["p1-new-incomplete"]["abandoned_at"] is None
        assert sessions["p1-old-incomplete"]["status"] == "abandoned"
        assert sessions["p1-old-incomplete"]["abandoned_at"] == (
            "2026-01-10T00:00:00Z"
        )
        assert sessions["p2-only-incomplete"]["status"] == "active"
        assert len(attempts) == 4
        assert applied is not None

        active_counts = connection.execute(
            """
            SELECT project_id, COUNT(*) AS active_count
            FROM practice_sessions
            WHERE status = 'active'
            GROUP BY project_id
            ORDER BY project_id
            """
        ).fetchall()
        assert [(row["project_id"], row["active_count"]) for row in active_counts] == [
            ("project-1", 1),
            ("project-2", 1),
        ]

        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO practice_sessions(
                    id, project_id, question_ids_json, status, created_at
                )
                VALUES ('second-active', 'project-1', '[]', 'active', ?)
                """,
                ("2026-01-04T00:00:00Z",),
            )


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


def test_migration_16_preserves_configured_job_values_and_backfills_null_attribution(
    tmp_path: Path,
) -> None:
    settings = Settings(data_dir=tmp_path, api_token="test-token")
    _create_v15_draft_job_fixture(settings.database_path)

    Database(settings).migrate()

    with sqlite3.connect(settings.database_path) as connection:
        connection.row_factory = sqlite3.Row
        job = connection.execute(
            "SELECT * FROM draft_generation_jobs WHERE id = 'draft-job'"
        ).fetchone()
        applied = connection.execute(
            "SELECT version FROM schema_migrations WHERE version = 16"
        ).fetchone()

    assert job is not None
    assert job["provider"] == "fastflowlm"
    assert job["model"] == "qwen3.5:4b"
    assert job["effective_provider"] is None
    assert job["effective_model"] is None
    assert job["fallback_reason"] is None
    assert applied is not None


def test_migration_18_backfills_job_phase_and_cancellability(tmp_path: Path) -> None:
    settings = Settings(data_dir=tmp_path, api_token="test-token")
    _create_v16_draft_job_fixture(settings.database_path)

    Database(settings).migrate()
    Database(settings).migrate()

    with sqlite3.connect(settings.database_path) as connection:
        connection.row_factory = sqlite3.Row
        jobs = {
            row["status"]: row
            for row in connection.execute(
                """
                SELECT status, phase, cancellable
                FROM draft_generation_jobs
                ORDER BY status
                """
            ).fetchall()
        }
        applied_versions = [
            row[0]
            for row in connection.execute(
                """
                SELECT version
                FROM schema_migrations
                WHERE version >= 17
                ORDER BY version
                """
            ).fetchall()
        ]

    assert (jobs["pending"]["phase"], jobs["pending"]["cancellable"]) == (
        "queued",
        1,
    )
    assert (jobs["running"]["phase"], jobs["running"]["cancellable"]) == (
        "generating",
        1,
    )
    assert (jobs["succeeded"]["phase"], jobs["succeeded"]["cancellable"]) == (
        "completed",
        0,
    )
    assert (jobs["failed"]["phase"], jobs["failed"]["cancellable"]) == (
        "failed",
        0,
    )
    assert (
        jobs["skipped_provider_unavailable"]["phase"],
        jobs["skipped_provider_unavailable"]["cancellable"],
    ) == ("failed", 0)
    assert (
        jobs["skipped_missing_model"]["phase"],
        jobs["skipped_missing_model"]["cancellable"],
    ) == ("failed", 0)
    assert applied_versions == [17, 18, 19]


def test_active_operation_indexes_reject_duplicate_work(tmp_path: Path) -> None:
    settings = Settings(data_dir=tmp_path, api_token="test-token")
    _create_v16_draft_job_fixture(settings.database_path)
    Database(settings).migrate()

    with sqlite3.connect(settings.database_path) as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute(
            """
            INSERT INTO manual_draft_generation_operations(
                id, project_id, document_id, limit_count, strategy, status,
                phase, cancellable, provider, model, created_at, updated_at
            )
            VALUES (
                'manual-active', 'project', 'document', 1, 'hybrid_reasoning',
                'running', 'generating', 1, 'fastflowlm', 'qwen3.5:4b',
                '2026-01-02', '2026-01-02'
            )
            """
        )
        connection.execute(
            """
            INSERT INTO manual_draft_generation_operations(
                id, project_id, document_id, limit_count, strategy, status,
                phase, cancellable, provider, model, created_at, updated_at
            )
            VALUES (
                'manual-terminal', 'project', 'document', 1,
                'hybrid_reasoning', 'succeeded', 'completed', 0,
                'fastflowlm', 'qwen3.5:4b', '2026-01-03', '2026-01-03'
            )
            """
        )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO manual_draft_generation_operations(
                    id, project_id, document_id, limit_count, strategy, status,
                    phase, cancellable, provider, model, created_at, updated_at
                )
                VALUES (
                    'manual-conflict', 'project', 'document', 1,
                    'hybrid_reasoning', 'queued', 'queued', 1, 'fastflowlm',
                    'qwen3.5:4b', '2026-01-03', '2026-01-03'
                )
                """
            )
        connection.execute(
            """
            INSERT INTO runtime_installation_jobs(
                id, kind, provider, model, status, phase, cancellable, detail,
                created_at, updated_at
            )
            VALUES (
                'runtime-active', 'windowsml_ocr', 'windowsml', '',
                'waiting_for_user', 'waiting_for_user', 1, 'Consent required',
                '2026-01-02', '2026-01-02'
            )
            """
        )
        connection.execute(
            """
            INSERT INTO runtime_installation_jobs(
                id, kind, provider, model, status, phase, cancellable, detail,
                created_at, updated_at
            )
            VALUES (
                'runtime-terminal', 'windowsml_ocr', 'windowsml', '',
                'succeeded', 'completed', 0, 'Ready',
                '2026-01-03', '2026-01-03'
            )
            """
        )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO runtime_installation_jobs(
                    id, kind, provider, model, status, phase, cancellable,
                    detail, created_at, updated_at
                )
                VALUES (
                    'runtime-conflict', 'windowsml_ocr', 'windowsml', '',
                    'cancel_requested', 'canceling', 0, 'Canceling',
                    '2026-01-03', '2026-01-03'
                )
                """
            )


def _columns(connection, table_name: str) -> dict[str, str | None]:
    rows = connection.execute(f"PRAGMA table_info({table_name})").fetchall()
    return {row["name"]: row["dflt_value"] for row in rows}


def _create_v14_practice_fixture(database_path: Path) -> None:
    database_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(database_path) as connection:
        connection.executescript(
            """
            CREATE TABLE schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            );
            """
        )
        for version, sql in MIGRATIONS:
            if version >= 15:
                break
            connection.executescript(sql)
            connection.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                (version, f"migration-{version}"),
            )

        connection.executemany(
            """
            INSERT INTO projects(id, name, description, created_at, updated_at)
            VALUES (?, ?, '', ?, ?)
            """,
            [
                ("project-1", "Project 1", "2026-01-01", "2026-01-01"),
                ("project-2", "Project 2", "2026-01-01", "2026-01-01"),
            ],
        )
        connection.executemany(
            """
            INSERT INTO question_drafts(
                id, project_id, question, choices_json, answer, status,
                created_at, updated_at
            )
            VALUES (?, ?, ?, '["A", "B"]', 'A', 'approved', ?, ?)
            """,
            [
                ("q1", "project-1", "Question 1", "2026-01-01", "2026-01-01"),
                ("q2", "project-1", "Question 2", "2026-01-01", "2026-01-01"),
                ("q3", "project-2", "Question 3", "2026-01-01", "2026-01-01"),
            ],
        )
        connection.executemany(
            """
            INSERT INTO practice_sessions(
                id, project_id, question_ids_json, status, created_at, completed_at
            )
            VALUES (?, ?, ?, 'active', ?, NULL)
            """,
            [
                (
                    "p1-complete",
                    "project-1",
                    '["q1", "q2", "q2"]',
                    "2026-01-01T00:00:00Z",
                ),
                (
                    "p1-old-incomplete",
                    "project-1",
                    '["q1", "q2"]',
                    "2026-01-02T00:00:00Z",
                ),
                (
                    "p1-new-incomplete",
                    "project-1",
                    '["q1", "q2"]',
                    "2026-01-03T00:00:00Z",
                ),
                (
                    "p2-only-incomplete",
                    "project-2",
                    '["q3"]',
                    "2026-01-01T00:00:00Z",
                ),
            ],
        )
        connection.executemany(
            """
            INSERT INTO practice_attempts(
                id, session_id, project_id, question_id, selected_answer,
                is_correct, created_at
            )
            VALUES (?, ?, ?, ?, 'A', 1, ?)
            """,
            [
                (
                    "complete-q1-first",
                    "p1-complete",
                    "project-1",
                    "q1",
                    "2026-01-01T03:00:00Z",
                ),
                (
                    "complete-q1-repeat",
                    "p1-complete",
                    "project-1",
                    "q1",
                    "2026-01-01T05:00:00Z",
                ),
                (
                    "complete-q2-first",
                    "p1-complete",
                    "project-1",
                    "q2",
                    "2026-01-01T04:00:00Z",
                ),
                (
                    "old-incomplete-late-activity",
                    "p1-old-incomplete",
                    "project-1",
                    "q1",
                    "2026-01-10T00:00:00Z",
                ),
            ],
        )


def _create_v15_draft_job_fixture(database_path: Path) -> None:
    database_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(database_path) as connection:
        connection.executescript(
            """
            CREATE TABLE schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            );
            """
        )
        for version, sql in MIGRATIONS:
            if version >= 16:
                break
            connection.executescript(sql)
            connection.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                (version, f"migration-{version}"),
            )

        connection.execute(
            """
            INSERT INTO projects(id, name, description, created_at, updated_at)
            VALUES ('project', 'Project', '', '2026-01-01', '2026-01-01')
            """
        )
        connection.execute(
            """
            INSERT INTO documents(
                id, project_id, filename, sha256, storage_path, page_count,
                has_text, status, created_at
            )
            VALUES (
                'document', 'project', 'source.pdf', 'sha', 'source.pdf', 1,
                1, 'ready', '2026-01-01'
            )
            """
        )
        connection.execute(
            """
            INSERT INTO document_chunks(
                id, project_id, document_id, page_number, chunk_index, text,
                source_excerpt, created_at
            )
            VALUES (
                'chunk', 'project', 'document', 1, 0, 'Source text',
                'Source text', '2026-01-01'
            )
            """
        )
        connection.execute(
            """
            INSERT INTO draft_generation_jobs(
                id, project_id, document_id, chunk_id, page_number, strategy,
                status, provider, model, created_at, updated_at
            )
            VALUES (
                'draft-job', 'project', 'document', 'chunk', 1,
                'hybrid_reasoning', 'succeeded', 'fastflowlm', 'qwen3.5:4b',
                '2026-01-01', '2026-01-01'
            )
            """
        )


def _create_v16_draft_job_fixture(database_path: Path) -> None:
    _create_v15_draft_job_fixture(database_path)
    with sqlite3.connect(database_path) as connection:
        for version, sql in MIGRATIONS:
            if version < 16:
                continue
            if version >= 17:
                break
            connection.executescript(sql)
            connection.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                (version, f"migration-{version}"),
            )
        connection.executemany(
            """
            INSERT INTO draft_generation_jobs(
                id, project_id, document_id, chunk_id, page_number, strategy,
                status, provider, model, created_at, updated_at
            )
            VALUES (?, 'project', 'document', 'chunk', 1, ?, ?,
                'fastflowlm', 'qwen3.5:4b', '2026-01-01', '2026-01-01')
            """,
            [
                ("draft-pending", "pending-strategy", "pending"),
                ("draft-running", "running-strategy", "running"),
                ("draft-failed", "failed-strategy", "failed"),
                (
                    "draft-provider-unavailable",
                    "provider-unavailable-strategy",
                    "skipped_provider_unavailable",
                ),
                (
                    "draft-model-missing",
                    "model-missing-strategy",
                    "skipped_missing_model",
                ),
            ],
        )
