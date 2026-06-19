from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Final

from exam_prep_backend.config import Settings


MIGRATIONS: Final[tuple[tuple[int, str], ...]] = (
    (
        1,
        """
        CREATE TABLE projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        """,
    ),
    (
        2,
        """
        CREATE TABLE documents (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            filename TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            storage_path TEXT NOT NULL,
            page_count INTEGER NOT NULL,
            has_text INTEGER NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX idx_documents_project ON documents(project_id);

        CREATE TABLE document_chunks (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            page_number INTEGER NOT NULL,
            chunk_index INTEGER NOT NULL,
            text TEXT NOT NULL,
            source_excerpt TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX idx_chunks_document ON document_chunks(document_id, page_number);
        """,
    ),
    (
        3,
        """
        CREATE TABLE question_drafts (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
            chunk_id TEXT REFERENCES document_chunks(id) ON DELETE SET NULL,
            question TEXT NOT NULL,
            choices_json TEXT NOT NULL,
            answer TEXT,
            rationale TEXT,
            citation_page INTEGER,
            source_excerpt TEXT,
            status TEXT NOT NULL,
            rejection_reason TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_question_drafts_project_status
            ON question_drafts(project_id, status, created_at);
        """,
    ),
    (
        4,
        """
        CREATE TABLE practice_sessions (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            question_ids_json TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            completed_at TEXT
        );

        CREATE TABLE practice_attempts (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            question_id TEXT NOT NULL REFERENCES question_drafts(id) ON DELETE CASCADE,
            selected_answer TEXT NOT NULL,
            is_correct INTEGER NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX idx_practice_attempts_wrong
            ON practice_attempts(project_id, is_correct, created_at);
        """,
    ),
    (
        5,
        """
        CREATE TABLE app_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        INSERT INTO app_metadata(key, value, updated_at)
        VALUES ('schema_name', 'exam-prep-backend', CURRENT_TIMESTAMP);
        """,
    ),
    (
        6,
        """
        ALTER TABLE documents
            ADD COLUMN extraction_method TEXT NOT NULL DEFAULT 'embedded';
        ALTER TABLE documents
            ADD COLUMN exam_item_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE document_chunks
            ADD COLUMN extraction_method TEXT NOT NULL DEFAULT 'embedded';
        ALTER TABLE question_drafts
            ADD COLUMN answer_key_source TEXT NOT NULL DEFAULT 'manual';
        """,
    ),
    (
        7,
        """
        ALTER TABLE documents
            ADD COLUMN ocr_device TEXT;
        ALTER TABLE documents
            ADD COLUMN ocr_fallback_reason TEXT;
        ALTER TABLE documents
            ADD COLUMN ocr_duration_ms INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE documents
            ADD COLUMN processed_page_count INTEGER NOT NULL DEFAULT 0;
        """,
    ),
    (
        8,
        """
        ALTER TABLE documents
            ADD COLUMN language_hint TEXT NOT NULL DEFAULT 'auto';
        ALTER TABLE documents
            ADD COLUMN updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP;
        """,
    ),
    (
        9,
        """
        ALTER TABLE documents
            ADD COLUMN content_profile TEXT NOT NULL DEFAULT 'unknown';
        ALTER TABLE documents
            ADD COLUMN classification_detail TEXT NOT NULL DEFAULT '';

        ALTER TABLE document_chunks
            ADD COLUMN raw_text TEXT NOT NULL DEFAULT '';
        ALTER TABLE document_chunks
            ADD COLUMN line_start INTEGER;
        ALTER TABLE document_chunks
            ADD COLUMN line_end INTEGER;
        ALTER TABLE document_chunks
            ADD COLUMN line_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE document_chunks
            ADD COLUMN content_profile TEXT NOT NULL DEFAULT 'unknown';
        UPDATE document_chunks
        SET raw_text = text,
            line_start = CASE WHEN text = '' THEN NULL ELSE 1 END,
            line_end = CASE WHEN text = '' THEN NULL ELSE 1 END,
            line_count = CASE WHEN text = '' THEN 0 ELSE 1 END
        WHERE raw_text = '';

        ALTER TABLE question_drafts
            ADD COLUMN source_order INTEGER;
        ALTER TABLE question_drafts
            ADD COLUMN source_question_number TEXT;
        ALTER TABLE question_drafts
            ADD COLUMN item_kind TEXT NOT NULL DEFAULT 'unknown';
        ALTER TABLE question_drafts
            ADD COLUMN group_key TEXT;
        ALTER TABLE question_drafts
            ADD COLUMN group_prompt TEXT;

        ALTER TABLE practice_sessions
            ADD COLUMN mode TEXT NOT NULL DEFAULT 'random_draw';
        ALTER TABLE practice_sessions
            ADD COLUMN source_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL;
        ALTER TABLE practice_sessions
            ADD COLUMN requested_question_count INTEGER NOT NULL DEFAULT 10;
        ALTER TABLE practice_sessions
            ADD COLUMN random_seed INTEGER;
        """,
    ),
    (
        10,
        """
        ALTER TABLE documents
            ADD COLUMN parse_wall_duration_ms INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE documents
            ADD COLUMN render_duration_ms INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE documents
            ADD COLUMN ocr_engine_duration_ms INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE documents
            ADD COLUMN ocr_worker_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE documents
            ADD COLUMN first_chunk_ms INTEGER NOT NULL DEFAULT 0;
        """,
    ),
    (
        11,
        """
        ALTER TABLE question_drafts
            ADD COLUMN confidence REAL;
        """,
    ),
    (
        12,
        """
        CREATE TABLE draft_generation_jobs (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            chunk_id TEXT NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
            page_number INTEGER NOT NULL,
            strategy TEXT NOT NULL,
            status TEXT NOT NULL,
            provider TEXT NOT NULL DEFAULT '',
            model TEXT NOT NULL DEFAULT '',
            generated_count INTEGER NOT NULL DEFAULT 0,
            retry_count INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(document_id, chunk_id, strategy)
        );
        CREATE INDEX idx_draft_generation_jobs_document
            ON draft_generation_jobs(project_id, document_id, created_at);
        CREATE INDEX idx_draft_generation_jobs_status
            ON draft_generation_jobs(status, updated_at);
        """,
    ),
)


class Database:
    def __init__(self, settings: Settings) -> None:
        self.path = settings.database_path
        self._lock = threading.Lock()
        self._migrated = False

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        self.migrate()
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def migrate(self) -> None:
        with self._lock:
            if self._migrated:
                return
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with sqlite3.connect(self.path) as connection:
                connection.execute("PRAGMA foreign_keys = ON")
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS schema_migrations (
                        version INTEGER PRIMARY KEY,
                        applied_at TEXT NOT NULL
                    );
                    """
                )
                applied = {
                    row[0] for row in connection.execute("SELECT version FROM schema_migrations")
                }
                for version, sql in MIGRATIONS:
                    if version in applied:
                        continue
                    connection.executescript(sql)
                    connection.execute(
                        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                        (version, utc_now()),
                    )
                connection.commit()
            self._migrated = True


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
