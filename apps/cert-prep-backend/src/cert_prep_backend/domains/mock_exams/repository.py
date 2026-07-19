from __future__ import annotations

import json
from sqlite3 import Row
from uuid import uuid4

from cert_prep_backend.persistence.database import Database, utc_now
from cert_prep_backend.domains.mock_exams.models import DraftSuggestion
from cert_prep_backend.domains.mock_exams.draft_jobs import DraftJobCanceledError
from cert_prep_backend.domains.mock_exams.schemas import QuestionDraftCreate, QuestionDraftUpdate
from cert_prep_backend.domains.source_documents import repository as documents_repository
from cert_prep_backend.domains.projects.repository import ensure_project_exists
from cert_prep_backend.api.errors import NotFoundError, ValidationError


def create_draft(db: Database, project_id: str, payload: QuestionDraftCreate) -> dict:
    ensure_project_exists(db, project_id)
    _validate_optional_source(db, project_id, payload.document_id, payload.chunk_id)
    draft_id = str(uuid4())
    now = utc_now()
    with db.connect() as connection:
        connection.execute(
            """
            INSERT INTO question_drafts(
                id, project_id, document_id, chunk_id, question, choices_json,
                answer, answer_key_source, rationale, citation_page, source_excerpt, status,
                confidence, source_order, source_question_number, item_kind, group_key, group_prompt,
                rejection_reason, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, NULL, ?, ?)
            """,
            (
                draft_id,
                project_id,
                payload.document_id,
                payload.chunk_id,
                payload.question,
                json.dumps(payload.choices),
                payload.answer,
                payload.answer_key_source,
                payload.rationale,
                payload.citation_page,
                payload.source_excerpt,
                payload.confidence,
                payload.source_order,
                payload.source_question_number,
                payload.item_kind,
                payload.group_key,
                payload.group_prompt,
                now,
                now,
            ),
        )
        row = _draft_query(connection, project_id, draft_id)
    if row is None:
        raise NotFoundError("Question draft not found.")
    return _draft_from_row(row)


def create_generated_drafts(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    suggestions: list[DraftSuggestion],
) -> list[dict]:
    ensure_project_exists(db, project_id)
    now = utc_now()
    draft_ids: list[str] = []
    with db.connect() as connection:
        for index, suggestion in enumerate(suggestions, start=1):
            if _matching_generated_draft_exists(
                connection,
                project_id=project_id,
                document_id=document_id,
                suggestion=suggestion,
            ):
                continue
            draft_id = str(uuid4())
            draft_ids.append(draft_id)
            connection.execute(
                """
                INSERT INTO question_drafts(
                    id, project_id, document_id, chunk_id, question, choices_json,
                    answer, answer_key_source, rationale, citation_page, source_excerpt, status,
                    confidence, source_order, source_question_number, item_kind, group_key, group_prompt,
                    rejection_reason, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
                """,
                (
                    draft_id,
                    project_id,
                    document_id,
                    suggestion.chunk_id,
                    suggestion.question,
                    json.dumps(suggestion.choices),
                    suggestion.answer,
                    suggestion.answer_key_source,
                    suggestion.rationale,
                    suggestion.citation_page,
                    suggestion.source_excerpt,
                    suggestion.status.value,
                    suggestion.confidence,
                    suggestion.source_order or index,
                    suggestion.source_question_number,
                    suggestion.item_kind.value,
                    suggestion.group_key,
                    suggestion.group_prompt,
                    now,
                    now,
                ),
            )
        rows = [
            row
            for draft_id in draft_ids
            if (row := _draft_query(connection, project_id, draft_id)) is not None
        ]
    return [_draft_from_row(row) for row in rows]


def append_generated_drafts(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    suggestions: list[DraftSuggestion],
) -> list[dict]:
    """Append streaming draft suggestions without deleting in-review work."""

    ensure_project_exists(db, project_id)
    with db.connect() as connection:
        rows = _append_generated_drafts(
            connection,
            project_id=project_id,
            document_id=document_id,
            suggestions=suggestions,
        )
    return [_draft_from_row(row) for row in rows]


def append_generated_drafts_and_complete_job(
    db: Database,
    *,
    job_id: str,
    project_id: str,
    document_id: str,
    suggestions: list[DraftSuggestion],
    effective_provider: str | None,
    effective_model: str | None,
    fallback_reason: str | None,
) -> list[dict]:
    """Commit generated drafts and their exact successful job attribution atomically."""

    ensure_project_exists(db, project_id)
    with db.connect() as connection:
        rows = _append_generated_drafts(
            connection,
            project_id=project_id,
            document_id=document_id,
            suggestions=suggestions,
        )
        now = utc_now()
        connection.execute(
            """
            UPDATE documents
            SET status = CASE
                    WHEN status = 'processing' THEN 'processing'
                    WHEN has_text = 1 AND EXISTS (
                        SELECT 1
                        FROM document_chunks
                        WHERE document_chunks.project_id = documents.project_id
                          AND document_chunks.document_id = documents.id
                    ) THEN 'ready'
                    ELSE 'exam_failed'
                END,
                exam_item_count = (
                    SELECT COUNT(*)
                    FROM question_drafts
                    WHERE question_drafts.project_id = documents.project_id
                      AND question_drafts.document_id = documents.id
                ),
                updated_at = ?
            WHERE project_id = ? AND id = ?
            """,
            (now, project_id, document_id),
        )
        updated_job = connection.execute(
            """
            UPDATE draft_generation_jobs
            SET status = 'succeeded',
                phase = 'completed',
                cancellable = 0,
                generated_count = ?,
                last_error = NULL,
                effective_provider = ?,
                effective_model = ?,
                fallback_reason = ?,
                updated_at = ?
            WHERE id = ? AND project_id = ? AND document_id = ?
                AND status = 'running'
                AND phase = 'committing'
                AND cancellable = 0
            """,
            (
                len(rows),
                effective_provider,
                effective_model,
                fallback_reason,
                now,
                job_id,
                project_id,
                document_id,
            ),
        )
        if updated_job.rowcount != 1:
            job = connection.execute(
                """
                SELECT status
                FROM draft_generation_jobs
                WHERE id = ? AND project_id = ? AND document_id = ?
                """,
                (job_id, project_id, document_id),
            ).fetchone()
            if job is not None and job["status"] in {"cancel_requested", "canceled"}:
                raise DraftJobCanceledError("Draft generation was canceled before commit.")
            raise NotFoundError(
                "Draft generation job was not in its atomic commit phase."
            )
    return [_draft_from_row(row) for row in rows]


def append_generated_drafts_and_complete_manual_operation(
    db: Database,
    *,
    operation_id: str,
    project_id: str,
    document_id: str,
    suggestions: list[DraftSuggestion],
    effective_provider: str | None,
    effective_model: str | None,
    fallback_reason: str | None,
) -> list[dict]:
    """Atomically publish manual drafts and the operation's final attribution."""

    ensure_project_exists(db, project_id)
    with db.connect() as connection:
        rows = _append_generated_drafts(
            connection,
            project_id=project_id,
            document_id=document_id,
            suggestions=suggestions,
        )
        now = utc_now()
        connection.execute(
            """
            UPDATE documents
            SET status = CASE WHEN status = 'processing' THEN 'processing' ELSE 'ready' END,
                exam_item_count = (
                    SELECT COUNT(*)
                    FROM question_drafts
                    WHERE question_drafts.project_id = documents.project_id
                      AND question_drafts.document_id = documents.id
                ),
                updated_at = ?
            WHERE project_id = ? AND id = ?
            """,
            (now, project_id, document_id),
        )
        updated = connection.execute(
            """
            UPDATE manual_draft_generation_operations
            SET status = 'succeeded', phase = 'completed', cancellable = 0,
                generated_count = ?, error = NULL,
                effective_provider = ?, effective_model = ?, fallback_reason = ?,
                updated_at = ?
            WHERE id = ? AND project_id = ? AND document_id = ?
              AND status = 'running' AND phase = 'committing' AND cancellable = 0
            """,
            (
                len(rows),
                effective_provider,
                effective_model,
                fallback_reason,
                now,
                operation_id,
                project_id,
                document_id,
            ),
        )
        if updated.rowcount != 1:
            operation = connection.execute(
                """
                SELECT status
                FROM manual_draft_generation_operations
                WHERE id = ? AND project_id = ? AND document_id = ?
                """,
                (operation_id, project_id, document_id),
            ).fetchone()
            if operation is not None and operation["status"] in {
                "cancel_requested",
                "canceled",
            }:
                raise DraftJobCanceledError(
                    "Manual draft generation was canceled before commit."
                )
            raise NotFoundError(
                "Manual draft generation was not in its atomic commit phase."
            )
    return [_draft_from_row(row) for row in rows]


def _append_generated_drafts(
    connection,
    *,
    project_id: str,
    document_id: str,
    suggestions: list[DraftSuggestion],
) -> list[Row]:
    now = utc_now()
    draft_ids: list[str] = []
    for index, suggestion in enumerate(suggestions, start=1):
        if _matching_generated_draft_exists(
            connection,
            project_id=project_id,
            document_id=document_id,
            suggestion=suggestion,
        ):
            continue
        draft_id = str(uuid4())
        draft_ids.append(draft_id)
        connection.execute(
            """
            INSERT INTO question_drafts(
                id, project_id, document_id, chunk_id, question, choices_json,
                answer, answer_key_source, rationale, citation_page, source_excerpt, status,
                confidence, source_order, source_question_number, item_kind, group_key, group_prompt,
                rejection_reason, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
            """,
            (
                draft_id,
                project_id,
                document_id,
                suggestion.chunk_id,
                suggestion.question,
                json.dumps(suggestion.choices),
                suggestion.answer,
                suggestion.answer_key_source,
                suggestion.rationale,
                suggestion.citation_page,
                suggestion.source_excerpt,
                suggestion.status.value,
                suggestion.confidence,
                suggestion.source_order or index,
                suggestion.source_question_number,
                suggestion.item_kind.value,
                suggestion.group_key,
                suggestion.group_prompt,
                now,
                now,
            ),
        )
    return [
        row
        for draft_id in draft_ids
        if (row := _draft_query(connection, project_id, draft_id)) is not None
    ]


def list_drafts(db: Database, project_id: str) -> list[dict]:
    ensure_project_exists(db, project_id)
    with db.connect() as connection:
        rows = connection.execute(
            """
            SELECT *
            FROM question_drafts
            WHERE project_id = ?
            ORDER BY created_at DESC
            """,
            (project_id,),
        ).fetchall()
    return [_draft_from_row(row) for row in rows]


def update_draft(
    db: Database, project_id: str, draft_id: str, payload: QuestionDraftUpdate
) -> dict:
    existing = get_draft(db, project_id, draft_id)
    now = utc_now()
    choices = payload.choices if payload.choices is not None else existing["choices"]
    with db.connect() as connection:
        connection.execute(
            """
            UPDATE question_drafts
            SET question = ?, choices_json = ?, answer = ?, answer_key_source = ?, rationale = ?,
                citation_page = ?, source_excerpt = ?, confidence = ?, source_order = ?,
                source_question_number = ?, item_kind = ?, group_key = ?, group_prompt = ?,
                updated_at = ?
            WHERE project_id = ? AND id = ?
            """,
            (
                payload.question if payload.question is not None else existing["question"],
                json.dumps(choices),
                payload.answer if payload.answer is not None else existing["answer"],
                (
                    payload.answer_key_source
                    if payload.answer_key_source is not None
                    else existing["answer_key_source"]
                ),
                payload.rationale if payload.rationale is not None else existing["rationale"],
                (
                    payload.citation_page
                    if payload.citation_page is not None
                    else existing["citation_page"]
                ),
                (
                    payload.source_excerpt
                    if payload.source_excerpt is not None
                    else existing["source_excerpt"]
                ),
                (
                    payload.confidence
                    if payload.confidence is not None
                    else existing["confidence"]
                ),
                (
                    payload.source_order
                    if payload.source_order is not None
                    else existing["source_order"]
                ),
                (
                    payload.source_question_number
                    if payload.source_question_number is not None
                    else existing["source_question_number"]
                ),
                payload.item_kind if payload.item_kind is not None else existing["item_kind"],
                payload.group_key if payload.group_key is not None else existing["group_key"],
                (
                    payload.group_prompt
                    if payload.group_prompt is not None
                    else existing["group_prompt"]
                ),
                now,
                project_id,
                draft_id,
            ),
        )
        row = _draft_query(connection, project_id, draft_id)
    if row is None:
        raise NotFoundError("Question draft not found.")
    return _draft_from_row(row)


def get_draft(db: Database, project_id: str, draft_id: str) -> dict:
    with db.connect() as connection:
        row = _draft_query(connection, project_id, draft_id)
    if row is None:
        raise NotFoundError("Question draft not found.")
    return _draft_from_row(row)


def _validate_optional_source(
    db: Database,
    project_id: str,
    document_id: str | None,
    chunk_id: str | None,
) -> None:
    if document_id is None and chunk_id is None:
        return
    if document_id is None or chunk_id is None:
        raise ValidationError("Document id and chunk id must be provided together.")
    documents_repository.get_chunk(db, project_id, document_id, chunk_id)


def _draft_query(connection, project_id: str, draft_id: str) -> Row | None:
    return connection.execute(
        "SELECT * FROM question_drafts WHERE project_id = ? AND id = ?",
        (project_id, draft_id),
    ).fetchone()


def _matching_generated_draft_exists(
    connection,
    *,
    project_id: str,
    document_id: str,
    suggestion: DraftSuggestion,
) -> bool:
    if suggestion.source_question_number:
        row = connection.execute(
            """
            SELECT id
            FROM question_drafts
            WHERE project_id = ?
              AND document_id = ?
              AND chunk_id = ?
              AND source_question_number = ?
            LIMIT 1
            """,
            (
                project_id,
                document_id,
                suggestion.chunk_id,
                suggestion.source_question_number,
            ),
        ).fetchone()
        if row is not None:
            return True

    row = connection.execute(
        """
        SELECT id
        FROM question_drafts
        WHERE project_id = ?
          AND document_id = ?
          AND chunk_id = ?
          AND lower(trim(question)) = ?
        LIMIT 1
        """,
        (
            project_id,
            document_id,
            suggestion.chunk_id,
            suggestion.question.strip().casefold(),
        ),
    ).fetchone()
    return row is not None


def _draft_from_row(row: Row) -> dict:
    return {
        "id": row["id"],
        "project_id": row["project_id"],
        "document_id": row["document_id"],
        "chunk_id": row["chunk_id"],
        "question": row["question"],
        "choices": json.loads(row["choices_json"]),
        "answer": row["answer"],
        "answer_key_source": row["answer_key_source"],
        "rationale": row["rationale"],
        "citation_page": row["citation_page"],
        "citation_locator_kind": row["citation_locator_kind"],
        "citation_start_ms": row["citation_start_ms"],
        "citation_end_ms": row["citation_end_ms"],
        "source_excerpt": row["source_excerpt"],
        "confidence": row["confidence"],
        "source_order": row["source_order"],
        "source_question_number": row["source_question_number"],
        "item_kind": row["item_kind"],
        "group_key": row["group_key"],
        "group_prompt": row["group_prompt"],
        "status": row["status"],
        "rejection_reason": row["rejection_reason"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
