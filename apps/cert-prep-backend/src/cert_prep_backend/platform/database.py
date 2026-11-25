from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterator
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from typing import Final

from cert_prep_backend.platform.config import Settings
from cert_prep_backend.platform.change_notifications import DatabaseChangeNotifier


# The failure texts Cert itself has stored as a document's old fallback reason or in
# document_operations.error, in this release and earlier ones (each has a writer in the
# history of the backend). Migration 30 keeps a stored reason or operation error that is
# exactly one of these, because it is true and already Cert's own text; any other text came
# from Capture Runtime and is replaced by Cert's message for the status and source. A frozen
# copy: later changes to the live messages must not change the migration.
_CERT_FAILURE_TEXTS: Final[tuple[str, ...]] = (
    "Document upload did not pass validation.",
    "Source validation failed.",
    "PDF validation failed.",
    "Document upload failed.",
    "Document processing failed.",
    "Document worker could not accept processing.",
    "Document processing worker could not start.",
    "Document processing was canceled but cleanup failed.",
    "Document processing was interrupted by an app restart.",
    "Parsing was interrupted before completion.",
    "Superseded while repairing duplicate active document operations.",
    "Capture review creation failed.",
    "Capture Runtime extraction failed.",
    "Capture commit could not be queued.",
    "Capture review confirmation could not be queued.",
    "Capture host structuring failed.",
    "Capture review confirmation failed.",
    "Capture review session was recovered after host shutdown.",
    "OCR runtime is unavailable.",
    "OCR provider unavailable.",
    "Capture Runtime extraction requirements are unavailable.",
    (
        "Capture Runtime extraction assets are unavailable. Install the required WindowsML or "
        "Whisper asset in Runtime setup, then retry."
    ),
    "This PDF requires text recognition, which is unavailable in the installed Capture Runtime.",
    "Text recognition is unavailable in the installed Capture Runtime.",
    "Speech recognition is unavailable in the installed Capture Runtime.",
    "Text recognition could not read this source.",
    "Speech recognition could not transcribe this recording.",
    "No reviewable text was found in this source.",
)
_CERT_FAILURE_TEXTS_SQL: Final = ", ".join(
    "'" + text.replace("'", "''") + "'" for text in _CERT_FAILURE_TEXTS
)


# Migration strategy: keep these local SQLite migrations append-only for now so
# desktop installs do not need a separate migration CLI. Revisit Alembic when
# downgrade support, branching migrations, or multi-process migration ownership
# become product requirements.
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
        VALUES ('schema_name', 'cert-prep-backend', CURRENT_TIMESTAMP);
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
    (
        13,
        """
        CREATE TABLE practice_session_questions (
            session_id TEXT NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            question_id TEXT NOT NULL,
            question_order INTEGER NOT NULL,
            question TEXT NOT NULL,
            choices_json TEXT NOT NULL,
            correct_answer TEXT,
            rationale TEXT,
            citation_page INTEGER,
            source_excerpt TEXT,
            created_at TEXT NOT NULL,
            PRIMARY KEY (session_id, question_id)
        );
        CREATE INDEX idx_practice_session_questions_project
            ON practice_session_questions(project_id, session_id, question_order);
        """,
    ),
    (
        14,
        """
        ALTER TABLE practice_session_questions
            ADD COLUMN document_id TEXT;
        """,
    ),
    (
        15,
        """
        ALTER TABLE practice_sessions
            ADD COLUMN abandoned_at TEXT;

        UPDATE practice_sessions AS sessions
        SET status = 'completed',
            completed_at = COALESCE(
                completed_at,
                (
                    SELECT MAX(first_answered_at)
                    FROM (
                        SELECT MIN(attempts.created_at) AS first_answered_at
                        FROM practice_attempts AS attempts
                        WHERE attempts.session_id = sessions.id
                            AND attempts.project_id = sessions.project_id
                            AND attempts.question_id IN (
                                SELECT value FROM json_each(sessions.question_ids_json)
                            )
                        GROUP BY attempts.question_id
                    ) AS first_answers
                ),
                created_at
            ),
            abandoned_at = NULL
        WHERE (
                SELECT COUNT(DISTINCT value)
                FROM json_each(sessions.question_ids_json)
            ) > 0
            AND (
                SELECT COUNT(DISTINCT attempts.question_id)
                FROM practice_attempts AS attempts
                WHERE attempts.session_id = sessions.id
                    AND attempts.project_id = sessions.project_id
                    AND attempts.question_id IN (
                        SELECT value FROM json_each(sessions.question_ids_json)
                    )
            ) = (
                SELECT COUNT(DISTINCT value)
                FROM json_each(sessions.question_ids_json)
            );

        UPDATE practice_sessions AS sessions
        SET completed_at = COALESCE(
                completed_at,
                (
                    SELECT MAX(first_answered_at)
                    FROM (
                        SELECT MIN(attempts.created_at) AS first_answered_at
                        FROM practice_attempts AS attempts
                        WHERE attempts.session_id = sessions.id
                            AND attempts.project_id = sessions.project_id
                            AND attempts.question_id IN (
                                SELECT value FROM json_each(sessions.question_ids_json)
                            )
                        GROUP BY attempts.question_id
                    ) AS first_answers
                ),
                created_at
            ),
            abandoned_at = NULL
        WHERE status = 'completed';

        UPDATE practice_sessions AS sessions
        SET status = 'abandoned',
            completed_at = NULL,
            abandoned_at = COALESCE(
                abandoned_at,
                (
                    SELECT MAX(attempts.created_at)
                    FROM practice_attempts AS attempts
                    WHERE attempts.session_id = sessions.id
                        AND attempts.project_id = sessions.project_id
                ),
                created_at
            )
        WHERE status <> 'completed';

        WITH incomplete_activity AS (
            SELECT
                sessions.id,
                sessions.project_id,
                sessions.created_at,
                COALESCE(
                    (
                        SELECT MAX(attempts.created_at)
                        FROM practice_attempts AS attempts
                        WHERE attempts.session_id = sessions.id
                            AND attempts.project_id = sessions.project_id
                    ),
                    sessions.created_at
                ) AS last_activity_at
            FROM practice_sessions AS sessions
            WHERE sessions.status = 'abandoned'
        ),
        ranked_incomplete AS (
            SELECT
                id,
                ROW_NUMBER() OVER (
                    PARTITION BY project_id
                    ORDER BY last_activity_at DESC, created_at DESC, id DESC
                ) AS session_rank
            FROM incomplete_activity
        )
        UPDATE practice_sessions
        SET status = 'active',
            abandoned_at = NULL
        WHERE id IN (
            SELECT id
            FROM ranked_incomplete
            WHERE session_rank = 1
        );

        CREATE UNIQUE INDEX idx_practice_sessions_one_active_per_project
            ON practice_sessions(project_id)
            WHERE status = 'active';
        """,
    ),
    (
        16,
        """
        ALTER TABLE draft_generation_jobs
            ADD COLUMN effective_provider TEXT;
        ALTER TABLE draft_generation_jobs
            ADD COLUMN effective_model TEXT;
        ALTER TABLE draft_generation_jobs
            ADD COLUMN fallback_reason TEXT;
        """,
    ),
    (
        17,
        """
        CREATE TABLE document_operations (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
            status TEXT NOT NULL,
            phase TEXT NOT NULL,
            cancellable INTEGER NOT NULL,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_document_operations_project
            ON document_operations(project_id, created_at);
        CREATE INDEX idx_document_operations_document
            ON document_operations(project_id, document_id, updated_at);
        """,
    ),
    (
        18,
        """
        ALTER TABLE draft_generation_jobs
            ADD COLUMN phase TEXT NOT NULL DEFAULT 'queued';
        ALTER TABLE draft_generation_jobs
            ADD COLUMN cancellable INTEGER NOT NULL DEFAULT 1;

        UPDATE draft_generation_jobs
        SET phase = CASE status
                WHEN 'pending' THEN 'queued'
                WHEN 'running' THEN 'generating'
                WHEN 'succeeded' THEN 'completed'
                WHEN 'failed' THEN 'failed'
                WHEN 'skipped_provider_unavailable' THEN 'failed'
                WHEN 'skipped_missing_model' THEN 'failed'
                ELSE phase
            END,
            cancellable = CASE
                WHEN status IN (
                    'succeeded',
                    'failed',
                    'skipped_provider_unavailable',
                    'skipped_missing_model'
                ) THEN 0
                ELSE 1
            END;

        CREATE TABLE manual_draft_generation_operations (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            limit_count INTEGER NOT NULL,
            strategy TEXT NOT NULL,
            status TEXT NOT NULL,
            phase TEXT NOT NULL,
            cancellable INTEGER NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            effective_provider TEXT,
            effective_model TEXT,
            fallback_reason TEXT,
            generated_count INTEGER NOT NULL DEFAULT 0,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_manual_draft_operations_document
            ON manual_draft_generation_operations(project_id, document_id, created_at);
        CREATE UNIQUE INDEX idx_manual_draft_operations_one_active
            ON manual_draft_generation_operations(project_id, document_id)
            WHERE status IN ('queued', 'running', 'cancel_requested');
        """,
    ),
    (
        19,
        """
        CREATE TABLE runtime_installation_jobs (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            status TEXT NOT NULL,
            phase TEXT NOT NULL,
            cancellable INTEGER NOT NULL,
            detail TEXT NOT NULL,
            completed INTEGER,
            total INTEGER,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_runtime_installation_jobs_updated
            ON runtime_installation_jobs(updated_at DESC);
        CREATE UNIQUE INDEX idx_runtime_installation_jobs_one_active_kind
            ON runtime_installation_jobs(kind)
            WHERE status IN (
                'queued', 'running', 'cancel_requested', 'waiting_for_user'
            );
        """,
    ),
    (
        20,
        """
        WITH ranked_active AS (
            SELECT
                id,
                ROW_NUMBER() OVER (
                    PARTITION BY project_id, document_id
                    ORDER BY
                        CASE status
                            WHEN 'cancel_requested' THEN 0
                            WHEN 'running' THEN 1
                            ELSE 2
                        END,
                        updated_at DESC,
                        created_at DESC,
                        id DESC
                ) AS operation_rank
            FROM document_operations
            WHERE document_id IS NOT NULL
                AND status IN ('queued', 'running', 'cancel_requested')
        )
        UPDATE document_operations
        SET status = 'failed',
            phase = 'failed',
            cancellable = 0,
            error = COALESCE(
                error,
                'Superseded while repairing duplicate active document operations.'
            )
        WHERE id IN (
            SELECT id
            FROM ranked_active
            WHERE operation_rank > 1
        );

        CREATE UNIQUE INDEX idx_document_operations_one_active_document
            ON document_operations(project_id, document_id)
            WHERE document_id IS NOT NULL
                AND status IN ('queued', 'running', 'cancel_requested');
        """,
    ),
    (
        21,
        """
        CREATE TABLE draft_generation_jobs_v21 (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            chunk_id TEXT REFERENCES document_chunks(id) ON DELETE SET NULL,
            source_chunk_id TEXT NOT NULL,
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
            effective_provider TEXT,
            effective_model TEXT,
            fallback_reason TEXT,
            phase TEXT NOT NULL DEFAULT 'queued',
            cancellable INTEGER NOT NULL DEFAULT 1,
            CHECK(chunk_id IS NULL OR chunk_id = source_chunk_id),
            UNIQUE(document_id, chunk_id, strategy)
        );

        CREATE TRIGGER trg_draft_generation_jobs_validate_chunk_insert
        BEFORE INSERT ON draft_generation_jobs_v21
        WHEN NEW.chunk_id IS NULL
            OR NOT EXISTS (
                SELECT 1
                FROM document_chunks
                WHERE id = NEW.chunk_id
                    AND project_id = NEW.project_id
                    AND document_id = NEW.document_id
            )
        BEGIN
            SELECT RAISE(ABORT, 'draft job chunk must belong to its document');
        END;

        INSERT INTO draft_generation_jobs_v21(
            id, project_id, document_id, chunk_id, source_chunk_id,
            page_number, strategy,
            status, provider, model, generated_count, retry_count, last_error,
            created_at, updated_at, effective_provider, effective_model,
            fallback_reason, phase, cancellable
        )
        SELECT
            id, project_id, document_id, chunk_id, chunk_id,
            page_number, strategy,
            status, provider, model, generated_count, retry_count, last_error,
            created_at, updated_at, effective_provider, effective_model,
            fallback_reason, phase, cancellable
        FROM draft_generation_jobs;

        DROP TABLE draft_generation_jobs;
        ALTER TABLE draft_generation_jobs_v21 RENAME TO draft_generation_jobs;

        CREATE INDEX idx_draft_generation_jobs_document
            ON draft_generation_jobs(project_id, document_id, created_at);
        CREATE INDEX idx_draft_generation_jobs_status
            ON draft_generation_jobs(status, updated_at);

        CREATE TRIGGER trg_draft_generation_jobs_validate_chunk_update
        BEFORE UPDATE OF chunk_id ON draft_generation_jobs
        WHEN NEW.chunk_id IS NOT NULL
            AND NOT EXISTS (
                SELECT 1
                FROM document_chunks
                WHERE id = NEW.chunk_id
                    AND project_id = NEW.project_id
                    AND document_id = NEW.document_id
            )
        BEGIN
            SELECT RAISE(ABORT, 'draft job chunk must belong to its document');
        END;

        CREATE TRIGGER trg_draft_generation_jobs_immutable_attribution
        BEFORE UPDATE OF project_id, document_id, source_chunk_id
            ON draft_generation_jobs
        WHEN NEW.project_id IS NOT OLD.project_id
            OR NEW.document_id IS NOT OLD.document_id
            OR NEW.source_chunk_id IS NOT OLD.source_chunk_id
        BEGIN
            SELECT RAISE(ABORT, 'draft job attribution is immutable');
        END;
        """,
    ),
    (
        22,
        """
        ALTER TABLE manual_draft_generation_operations
            ADD COLUMN commit_started_at TEXT;
        ALTER TABLE runtime_installation_jobs
            ADD COLUMN commit_started_at TEXT;
        """,
    ),
    (
        23,
        """
        ALTER TABLE documents ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'document';
        ALTER TABLE documents ADD COLUMN duration_ms INTEGER;
        ALTER TABLE documents ADD COLUMN transcription_status TEXT NOT NULL DEFAULT 'not_applicable';
        ALTER TABLE documents ADD COLUMN translation_status TEXT NOT NULL DEFAULT 'not_applicable';
        ALTER TABLE documents ADD COLUMN configured_transcription_model TEXT;
        ALTER TABLE documents ADD COLUMN effective_transcription_model TEXT;
        ALTER TABLE documents ADD COLUMN transcription_device TEXT;
        ALTER TABLE documents ADD COLUMN transcription_warning TEXT;

        ALTER TABLE document_chunks ADD COLUMN locator_kind TEXT NOT NULL DEFAULT 'page';
        ALTER TABLE document_chunks ADD COLUMN start_ms INTEGER;
        ALTER TABLE document_chunks ADD COLUMN end_ms INTEGER;
        ALTER TABLE document_chunks ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE document_chunks ADD COLUMN translated_text TEXT;
        ALTER TABLE document_chunks ADD COLUMN translation_source_revision INTEGER;

        ALTER TABLE question_drafts ADD COLUMN citation_locator_kind TEXT NOT NULL DEFAULT 'page';
        ALTER TABLE question_drafts ADD COLUMN citation_start_ms INTEGER;
        ALTER TABLE question_drafts ADD COLUMN citation_end_ms INTEGER;
        """,
    ),
    (
        24,
        """
        CREATE TRIGGER trg_question_drafts_audio_locator_insert
        AFTER INSERT ON question_drafts
        WHEN NEW.chunk_id IS NOT NULL
        BEGIN
            UPDATE question_drafts
            SET citation_locator_kind = COALESCE(
                    (SELECT locator_kind FROM document_chunks WHERE id = NEW.chunk_id), 'page'),
                citation_start_ms = (
                    SELECT start_ms FROM document_chunks WHERE id = NEW.chunk_id),
                citation_end_ms = (
                    SELECT end_ms FROM document_chunks WHERE id = NEW.chunk_id),
                citation_page = CASE
                    WHEN (SELECT locator_kind FROM document_chunks WHERE id = NEW.chunk_id) = 'time'
                    THEN NULL ELSE citation_page END
            WHERE id = NEW.id;
        END;
        """,
    ),
    (
        25,
        """
        CREATE TABLE capture_review_sessions (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            operation_id TEXT NOT NULL REFERENCES document_operations(id) ON DELETE CASCADE,
            runtime_capture_id TEXT,
            status TEXT NOT NULL,
            review_revision INTEGER NOT NULL DEFAULT 0,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(project_id, document_id),
            UNIQUE(operation_id)
        );
        CREATE INDEX idx_capture_review_sessions_expiry
            ON capture_review_sessions(status, expires_at);
        CREATE INDEX idx_capture_review_sessions_runtime
            ON capture_review_sessions(project_id, runtime_capture_id);
        """,
    ),
    (
        26,
        """
        ALTER TABLE capture_review_sessions ADD COLUMN confirm_request_id TEXT;
        ALTER TABLE capture_review_sessions ADD COLUMN confirm_review_digest TEXT;
        """,
    ),
    (
        27,
        """
        ALTER TABLE manual_draft_generation_operations
            ADD COLUMN unavailable_blocks_json TEXT NOT NULL DEFAULT '[]';
        """,
    ),
    (
        28,
        """
        ALTER TABLE capture_review_sessions
            ADD COLUMN last_event_sequence INTEGER NOT NULL DEFAULT 0
            CHECK(last_event_sequence >= 0);
        """,
    ),
    (
        29,
        """
        CREATE TABLE ollama_device_preference (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            mode TEXT NOT NULL CHECK (mode IN ('auto', 'cpu', 'adapter')),
            adapter_key TEXT,
            adapter_name TEXT,
            pci_vendor_id TEXT,
            pci_device_id TEXT,
            updated_at TEXT NOT NULL
        );
        """,
    ),
    (
        30,
        """
        CREATE TABLE documents_new (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            filename TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            storage_path TEXT NOT NULL,
            page_count INTEGER NOT NULL,
            has_text INTEGER NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            extraction_method TEXT NOT NULL DEFAULT 'none',
            exam_item_count INTEGER NOT NULL DEFAULT 0,
            ocr_device TEXT,
            processed_page_count INTEGER NOT NULL DEFAULT 0,
            language_hint TEXT NOT NULL DEFAULT 'auto',
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            content_profile TEXT NOT NULL DEFAULT 'unknown',
            classification_detail TEXT NOT NULL DEFAULT '',
            source_kind TEXT NOT NULL DEFAULT 'document',
            duration_ms INTEGER,
            transcription_status TEXT NOT NULL DEFAULT 'not_applicable',
            translation_status TEXT NOT NULL DEFAULT 'not_applicable',
            configured_transcription_model TEXT,
            effective_transcription_model TEXT,
            transcription_device TEXT,
            transcription_warning TEXT,
            extraction_warnings TEXT,
            failure_message TEXT
        );
        INSERT INTO documents_new (
            id, project_id, filename, sha256,
            storage_path, page_count, has_text, status,
            created_at, extraction_method, exam_item_count, ocr_device,
            processed_page_count, language_hint, updated_at, content_profile,
            classification_detail, source_kind, duration_ms, transcription_status,
            translation_status, configured_transcription_model, effective_transcription_model,
            transcription_device, transcription_warning, extraction_warnings, failure_message
        )
        SELECT
            id,
            project_id,
            filename,
            sha256,
            storage_path,
            page_count,
            has_text,
            CASE status
                WHEN 'ocr_failed' THEN 'extraction_failed'
                WHEN 'exam_failed' THEN 'no_text_detected'
                ELSE status
            END,
            created_at,
            CASE extraction_method
                WHEN 'windowsml_ocr' THEN 'text_recognition'
                WHEN 'embedded' THEN 'text_layer'
                WHEN 'mixed' THEN 'text_layer'
                WHEN 'ocr_failed' THEN 'none'
                ELSE extraction_method
            END,
            exam_item_count,
            -- Every stored device name that names WindowsML (windowsml-dml, amd_windowsml:0,
            -- windowsml) was the DirectML device.
            CASE WHEN lower(ocr_device) LIKE '%windowsml%' THEN 'directml' ELSE ocr_device END,
            processed_page_count,
            language_hint,
            updated_at,
            content_profile,
            classification_detail,
            source_kind,
            duration_ms,
            transcription_status,
            translation_status,
            configured_transcription_model,
            effective_transcription_model,
            transcription_device,
            transcription_warning,
            CASE WHEN NOT (status IN (
                    'ocr_failed', 'exam_failed', 'no_text_detected',
                    'transcription_failed'
                )) THEN ocr_fallback_reason END,
            CASE WHEN status IN (
                    'ocr_failed', 'exam_failed', 'no_text_detected',
                    'transcription_failed'
                ) THEN ocr_fallback_reason END
        FROM documents;

        CREATE TABLE document_chunks_new (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            page_number INTEGER NOT NULL,
            chunk_index INTEGER NOT NULL,
            text TEXT NOT NULL,
            source_excerpt TEXT NOT NULL,
            created_at TEXT NOT NULL,
            extraction_method TEXT NOT NULL DEFAULT 'none',
            raw_text TEXT NOT NULL DEFAULT '',
            line_start INTEGER,
            line_end INTEGER,
            line_count INTEGER NOT NULL DEFAULT 0,
            content_profile TEXT NOT NULL DEFAULT 'unknown',
            locator_kind TEXT NOT NULL DEFAULT 'page',
            start_ms INTEGER,
            end_ms INTEGER,
            source_revision INTEGER NOT NULL DEFAULT 1,
            translated_text TEXT,
            translation_source_revision INTEGER
        );
        INSERT INTO document_chunks_new (
            id, project_id, document_id, page_number,
            chunk_index, text, source_excerpt, created_at,
            extraction_method, raw_text, line_start, line_end,
            line_count, content_profile, locator_kind, start_ms,
            end_ms, source_revision, translated_text, translation_source_revision
        )
        SELECT
            id,
            project_id,
            document_id,
            page_number,
            chunk_index,
            text,
            source_excerpt,
            created_at,
            CASE extraction_method
                WHEN 'windowsml_ocr' THEN 'text_recognition'
                WHEN 'embedded' THEN 'text_layer'
                WHEN 'mixed' THEN 'text_layer'
                WHEN 'ocr_failed' THEN 'none'
                ELSE extraction_method
            END,
            raw_text,
            line_start,
            line_end,
            line_count,
            content_profile,
            locator_kind,
            start_ms,
            end_ms,
            source_revision,
            translated_text,
            translation_source_revision
        FROM document_chunks;

        -- A stored failure reason or operation error may be the error text of Capture
        -- Runtime. The requirement messages of earlier releases become the current ones, a
        -- text in _CERT_FAILURE_TEXTS stays, and any other text becomes the Cert message for
        -- the status and source. Every failed operation of a document is cleaned on its own,
        -- whatever its document holds now (a retry may have replaced the reason, and failed
        -- recordings stored none). This runs before the rebuild, against the old documents
        -- table: an earlier release stored the same runtime text for a run without text and
        -- for any other failed run, so the text cannot tell them apart. The run without text
        -- is the one that set a no_text_detected status. That writer stored one timestamp as
        -- the operation's and the document's updated_at, while a retry took its created_at
        -- before it waited for the write lock, so creation order does not say which run
        -- settled last. The run without text is therefore the only failed operation of the
        -- document whose updated_at equals the document's; when none or several match, no run
        -- gets the no-text message. In every case a known Cert message is kept, a run without
        -- an error is left alone, and the message for the source kind is the fallback for
        -- any other error text.
        UPDATE document_operations
        SET error = CASE
            WHEN document_operations.error LIKE 'This PDF requires WindowsML OCR%' THEN
                'This PDF requires text recognition, which is unavailable in the '
                || 'installed Capture Runtime.'
            WHEN document_operations.error LIKE 'WindowsML OCR is unavailable%'
                OR document_operations.error LIKE 'Speech recognition is unavailable.%'
                THEN CASE
                    WHEN source.source_kind = 'audio' THEN
                        'Speech recognition is unavailable in the installed Capture Runtime.'
                    WHEN lower(source.storage_path) LIKE '%.pdf' THEN
                        'This PDF requires text recognition, which is unavailable in the '
                        || 'installed Capture Runtime.'
                    ELSE 'Text recognition is unavailable in the installed Capture Runtime.'
                END
            WHEN document_operations.error IN (""" + _CERT_FAILURE_TEXTS_SQL + """)
                THEN document_operations.error
            WHEN source.status = 'no_text_detected'
                AND document_operations.updated_at = source.updated_at
                AND (
                    SELECT COUNT(*) FROM document_operations AS settled
                    WHERE settled.document_id = source.id
                        AND settled.status = 'failed'
                        AND settled.updated_at = source.updated_at
                ) = 1
                THEN 'No reviewable text was found in this source.'
            WHEN source.source_kind = 'audio'
                THEN 'Speech recognition could not transcribe this recording.'
            ELSE 'Text recognition could not read this source.'
        END
        FROM documents AS source
        WHERE source.id = document_operations.document_id
            AND document_operations.status = 'failed'
            AND document_operations.error IS NOT NULL;

        DROP TABLE document_chunks;
        DROP TABLE documents;
        ALTER TABLE documents_new RENAME TO documents;
        ALTER TABLE document_chunks_new RENAME TO document_chunks;
        CREATE INDEX idx_documents_project ON documents(project_id);
        CREATE INDEX idx_chunks_document ON document_chunks(document_id, page_number);

        UPDATE documents
        SET extraction_warnings = REPLACE(REPLACE(extraction_warnings,
                'This PDF requires WindowsML OCR', 'This PDF requires text recognition'),
                'WindowsML OCR is unavailable', 'Text recognition is unavailable')
        WHERE extraction_warnings IS NOT NULL;

        UPDATE documents
        SET failure_message = CASE
            WHEN failure_message LIKE 'This PDF requires WindowsML OCR%' THEN
                'This PDF requires text recognition, which is unavailable in the '
                || 'installed Capture Runtime.'
            WHEN failure_message LIKE 'WindowsML OCR is unavailable%'
                OR failure_message LIKE 'Speech recognition is unavailable.%'
                THEN CASE
                    WHEN source_kind = 'audio' THEN
                        'Speech recognition is unavailable in the installed Capture Runtime.'
                    WHEN lower(storage_path) LIKE '%.pdf' THEN
                        'This PDF requires text recognition, which is unavailable in the '
                        || 'installed Capture Runtime.'
                    ELSE 'Text recognition is unavailable in the installed Capture Runtime.'
                END
            WHEN failure_message IN (""" + _CERT_FAILURE_TEXTS_SQL + """)
                THEN failure_message
            WHEN status = 'no_text_detected'
                THEN 'No reviewable text was found in this source.'
            WHEN source_kind = 'audio'
                THEN 'Speech recognition could not transcribe this recording.'
            ELSE 'Text recognition could not read this source.'
        END
        WHERE failure_message IS NOT NULL;
        -- Failed recordings stored no reason; they take the error of their last failed run.
        UPDATE documents
        SET failure_message = COALESCE(
            (
                SELECT run.error FROM document_operations AS run
                WHERE run.document_id = documents.id
                    AND run.status = 'failed'
                    AND run.error IS NOT NULL
                ORDER BY run.updated_at DESC, run.created_at DESC
                LIMIT 1
            ),
            'Speech recognition could not transcribe this recording.'
        )
        WHERE status = 'transcription_failed' AND failure_message IS NULL;
        """,
    ),
)


# Migrations that rebuild a parent table (create, copy, drop, rename) run with foreign keys off,
# so dropping the old table cascades into nothing, and statement by statement in one
# transaction, so the version recheck and the rebuild commit together.
_TABLE_REBUILD_MIGRATIONS: Final[frozenset[int]] = frozenset({30})


class Database:
    def __init__(
        self,
        settings: Settings,
        *,
        change_notifier: DatabaseChangeNotifier | None = None,
    ) -> None:
        self.path = settings.database_path
        self.change_notifier = change_notifier
        self._lock = threading.Lock()
        self._migrated = False

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        self.migrate()
        connection = sqlite3.connect(self.path, timeout=30.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        initial_changes = connection.total_changes
        try:
            yield connection
            connection.commit()
            if (
                self.change_notifier is not None
                and connection.total_changes != initial_changes
            ):
                self.change_notifier.publish()
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
            # closing(): sqlite3's own context manager commits but leaves the
            # connection open, which keeps the file locked on Windows.
            with closing(sqlite3.connect(self.path)) as connection:
                connection.execute("PRAGMA foreign_keys = ON")
                connection.execute("PRAGMA journal_mode = WAL")
                connection.execute("PRAGMA busy_timeout = 30000")
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS schema_migrations (
                        version INTEGER PRIMARY KEY,
                        applied_at TEXT NOT NULL
                    );
                    """
                )
                connection.commit()
                applied = {
                    row[0] for row in connection.execute("SELECT version FROM schema_migrations")
                }
                for version, sql in MIGRATIONS:
                    if version in applied:
                        continue
                    rebuilds_tables = version in _TABLE_REBUILD_MIGRATIONS
                    if rebuilds_tables:
                        # Prevent cascades while replacing the parent tables. The existing
                        # triggers keep referencing their final names throughout the rebuild.
                        connection.execute("PRAGMA foreign_keys = OFF")
                        connection.execute("PRAGMA legacy_alter_table = ON")
                    try:
                        if rebuilds_tables:
                            connection.execute("BEGIN IMMEDIATE")
                            # A second Database instance may have migrated while we waited.
                            if connection.execute(
                                "SELECT 1 FROM schema_migrations WHERE version = ?", (version,)
                            ).fetchone() is not None:
                                connection.commit()
                                continue
                            _run_table_rebuild(connection, sql)
                        else:
                            connection.executescript(f"BEGIN IMMEDIATE;\n{sql}")
                        connection.execute(
                            "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                            (version, utc_now()),
                        )
                        connection.commit()
                    except BaseException:
                        connection.rollback()
                        raise
                    finally:
                        if rebuilds_tables:
                            connection.execute("PRAGMA legacy_alter_table = OFF")
                            connection.execute("PRAGMA foreign_keys = ON")
            self._migrated = True


def _run_table_rebuild(connection: sqlite3.Connection, sql: str) -> None:
    # executescript would commit the transaction used for the version recheck.
    statement = ""
    for line in sql.splitlines(keepends=True):
        statement += line
        if sqlite3.complete_statement(statement):
            connection.execute(statement)
            statement = ""
    if statement.strip():
        raise sqlite3.OperationalError("Incomplete table rebuild statement.")
    broken: dict[str, int] = {}
    for table, _rowid, parent, _key in connection.execute("PRAGMA foreign_key_check"):
        reference = f"{table} -> {parent}"
        broken[reference] = broken.get(reference, 0) + 1
    if broken:
        details = ", ".join(
            f"{reference} ({count} rows)" for reference, count in sorted(broken.items())
        )
        raise sqlite3.IntegrityError(f"Table rebuild broke foreign keys: {details}.")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
