from __future__ import annotations

import json
from sqlite3 import Row
from uuid import uuid4

from exam_prep_backend import documents_store
from exam_prep_backend.database import Database, utc_now
from exam_prep_backend.errors import NotFoundError, ValidationError
from exam_prep_backend.llm import DraftSuggestion
from exam_prep_backend.projects_store import ensure_project_exists
from exam_prep_backend.schemas import QuestionDraftCreate, QuestionDraftUpdate


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
                rejection_reason, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, ?, ?)
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
        for suggestion in suggestions:
            draft_id = str(uuid4())
            draft_ids.append(draft_id)
            connection.execute(
                """
                INSERT INTO question_drafts(
                    id, project_id, document_id, chunk_id, question, choices_json,
                    answer, answer_key_source, rationale, citation_page, source_excerpt, status,
                    rejection_reason, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', NULL, ?, ?)
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
                citation_page = ?, source_excerpt = ?, updated_at = ?
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
                now,
                project_id,
                draft_id,
            ),
        )
        row = _draft_query(connection, project_id, draft_id)
    if row is None:
        raise NotFoundError("Question draft not found.")
    return _draft_from_row(row)


def approve_draft(db: Database, project_id: str, draft_id: str) -> dict:
    draft = get_draft(db, project_id, draft_id)
    missing = missing_approval_fields(draft)
    if missing:
        return {"blocked": True, "missing": missing}
    grounding_errors = grounding_errors_for_draft(db, draft)
    if grounding_errors:
        return {"blocked": True, "missing": grounding_errors}

    now = utc_now()
    with db.connect() as connection:
        connection.execute(
            """
            UPDATE question_drafts
            SET status = 'approved', rejection_reason = NULL, updated_at = ?
            WHERE project_id = ? AND id = ?
            """,
            (now, project_id, draft_id),
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


def missing_approval_fields(draft: dict) -> list[str]:
    missing: list[str] = []
    if not draft["document_id"]:
        missing.append("document_id")
    if not draft["chunk_id"]:
        missing.append("chunk_id")
    if draft["citation_page"] is None:
        missing.append("citation_page")
    if not draft["source_excerpt"]:
        missing.append("source_excerpt")
    if len(draft["choices"]) < 2:
        missing.append("choices")
    if not draft["answer"] or draft["answer"] not in draft["choices"]:
        missing.append("answer")
    if not draft["rationale"]:
        missing.append("rationale")
    return missing


def grounding_errors_for_draft(db: Database, draft: dict) -> list[str]:
    try:
        chunk = documents_store.get_chunk(
            db,
            draft["project_id"],
            draft["document_id"],
            draft["chunk_id"],
        )
    except NotFoundError:
        return ["document_chunk"]

    errors: list[str] = []
    if draft["citation_page"] != chunk["page_number"]:
        errors.append("citation_page")

    source_excerpt = (draft["source_excerpt"] or "").strip()
    if source_excerpt and source_excerpt not in chunk["text"]:
        errors.append("source_excerpt")
    return errors


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
    documents_store.get_chunk(db, project_id, document_id, chunk_id)


def _draft_query(connection, project_id: str, draft_id: str) -> Row | None:
    return connection.execute(
        "SELECT * FROM question_drafts WHERE project_id = ? AND id = ?",
        (project_id, draft_id),
    ).fetchone()


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
        "source_excerpt": row["source_excerpt"],
        "status": row["status"],
        "rejection_reason": row["rejection_reason"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
