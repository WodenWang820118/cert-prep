from __future__ import annotations

from pathlib import Path
import sqlite3

import pytest

from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.mock_exams import draft_jobs
from cert_prep_backend.persistence.database import Database


def test_detached_terminal_job_keeps_public_attribution_and_is_not_retried(
    tmp_path: Path,
) -> None:
    db = _database(tmp_path)
    _seed_project_document_chunk(db, document_id="document", chunk_id="chunk")
    job = draft_jobs.enqueue_chunk_job(
        db,
        project_id="project",
        document_id="document",
        chunk_id="chunk",
        page_number=1,
        strategy="hybrid_reasoning",
        provider="future-provider",
        model="qwen3.5:4b",
    )
    terminal_before = draft_jobs.mark_failed(db, job["id"], detail="generation failed")

    with db.connect() as connection:
        connection.execute("DELETE FROM document_chunks WHERE id = 'chunk'")
        raw = connection.execute(
            "SELECT * FROM draft_generation_jobs WHERE id = ?",
            (job["id"],),
        ).fetchone()

    assert raw is not None
    assert raw["chunk_id"] is None
    assert raw["source_chunk_id"] == "chunk"
    assert draft_jobs.get_job(db, job["id"]) == terminal_before
    assert draft_jobs.retry_document_jobs(
        db,
        project_id="project",
        document_id="document",
        provider="ollama",
        model="qwen3.5:2b",
    ) == []
    assert draft_jobs.get_job(db, job["id"]) == terminal_before


@pytest.mark.parametrize("detached_status", ["pending", "running"])
def test_recovery_terminalizes_detached_nonterminal_jobs(
    tmp_path: Path,
    detached_status: str,
) -> None:
    db = _database(tmp_path)
    _seed_project_document_chunk(db, document_id="document", chunk_id="chunk")
    job = draft_jobs.enqueue_chunk_job(
        db,
        project_id="project",
        document_id="document",
        chunk_id="chunk",
        page_number=1,
        strategy="deterministic_only",
        provider="future-provider",
        model="qwen3.5:4b",
    )
    with db.connect() as connection:
        connection.execute(
            """
            UPDATE draft_generation_jobs
            SET status = ?, phase = ?, cancellable = 1
            WHERE id = ?
            """,
            (
                detached_status,
                "generating" if detached_status == "running" else "queued",
                job["id"],
            ),
        )
        connection.execute("DELETE FROM document_chunks WHERE id = 'chunk'")

    assert draft_jobs.recover_runnable_jobs(db) == []
    with db.connect() as connection:
        recovered = connection.execute(
            "SELECT * FROM draft_generation_jobs WHERE id = ?",
            (job["id"],),
        ).fetchone()
    assert recovered is not None
    assert (recovered["status"], recovered["phase"], recovered["cancellable"]) == (
        "failed",
        "failed",
        0,
    )
    assert recovered["chunk_id"] is None
    assert recovered["source_chunk_id"] == "chunk"


def test_draft_job_attribution_constraints_reject_cross_document_drift(
    tmp_path: Path,
) -> None:
    db = _database(tmp_path)
    _seed_project_document_chunk(db, document_id="document-a", chunk_id="chunk-a")
    _seed_document_chunk(db, document_id="document-b", chunk_id="chunk-b")

    with db.connect() as connection:
        with pytest.raises(sqlite3.IntegrityError):
            _insert_raw_job(
                connection,
                job_id="cross-document",
                document_id="document-a",
                chunk_id="chunk-b",
                source_chunk_id="chunk-b",
            )
        with pytest.raises(sqlite3.IntegrityError):
            _insert_raw_job(
                connection,
                job_id="mismatched-source",
                document_id="document-b",
                chunk_id="chunk-b",
                source_chunk_id="different-source",
            )

    job = draft_jobs.enqueue_chunk_job(
        db,
        project_id="project",
        document_id="document-b",
        chunk_id="chunk-b",
        page_number=1,
        strategy="deterministic_only",
        provider="future-provider",
        model="qwen3.5:4b",
    )
    with db.connect() as connection:
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "UPDATE draft_generation_jobs SET source_chunk_id = 'chunk-a' WHERE id = ?",
                (job["id"],),
            )
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []


def _database(tmp_path: Path) -> Database:
    db = Database(Settings(data_dir=tmp_path, api_token="test-token"))
    db.migrate()
    return db


def _seed_project_document_chunk(
    db: Database,
    *,
    document_id: str,
    chunk_id: str,
) -> None:
    with db.connect() as connection:
        connection.execute(
            """
            INSERT INTO projects(id, name, description, created_at, updated_at)
            VALUES ('project', 'Project', '', '2026-07-14', '2026-07-14')
            """
        )
    _seed_document_chunk(db, document_id=document_id, chunk_id=chunk_id)


def _seed_document_chunk(
    db: Database,
    *,
    document_id: str,
    chunk_id: str,
) -> None:
    with db.connect() as connection:
        connection.execute(
            """
            INSERT INTO documents(
                id, project_id, filename, sha256, storage_path, page_count,
                has_text, status, created_at, updated_at
            )
            VALUES (?, 'project', ?, ?, ?, 1, 1, 'ready', '2026-07-14', '2026-07-14')
            """,
            (document_id, f"{document_id}.pdf", document_id, f"C:/{document_id}.pdf"),
        )
        connection.execute(
            """
            INSERT INTO document_chunks(
                id, project_id, document_id, page_number, chunk_index,
                text, source_excerpt, created_at
            )
            VALUES (?, 'project', ?, 1, 0, 'source text', 'source text', '2026-07-14')
            """,
            (chunk_id, document_id),
        )


def _insert_raw_job(
    connection: sqlite3.Connection,
    *,
    job_id: str,
    document_id: str,
    chunk_id: str,
    source_chunk_id: str,
) -> None:
    connection.execute(
        """
        INSERT INTO draft_generation_jobs(
            id, project_id, document_id, chunk_id, source_chunk_id,
            page_number, strategy, status, provider, model, created_at, updated_at
        )
        VALUES (
            ?, 'project', ?, ?, ?, 1, 'deterministic_only', 'pending',
            'future-provider', 'qwen3.5:4b', '2026-07-14', '2026-07-14'
        )
        """,
        (job_id, document_id, chunk_id, source_chunk_id),
    )
