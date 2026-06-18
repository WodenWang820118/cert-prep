from __future__ import annotations

import json
from sqlite3 import Row
from uuid import uuid4

from exam_prep_backend.database import Database, utc_now
from exam_prep_backend.domains.mock_exams.models import DraftSuggestion
from exam_prep_backend.domains.mock_exams.models import SourceChunk
from exam_prep_backend.domains.mock_exams.policies import (
    grounding_errors_for_draft as grounding_error_codes,
)
from exam_prep_backend.domains.mock_exams.policies import (
    missing_approval_fields as missing_approval_field_codes,
)
from exam_prep_backend.domains.mock_exams.schemas import QuestionDraftCreate, QuestionDraftUpdate
from exam_prep_backend.domains.source_documents import repository as documents_repository
from exam_prep_backend.domains.projects.repository import ensure_project_exists
from exam_prep_backend.errors import NotFoundError, ValidationError


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
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, NULL, ?, ?)
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
        connection.execute(
            """
            DELETE FROM question_drafts
            WHERE project_id = ?
              AND document_id = ?
              AND status <> 'approved'
            """,
            (project_id, document_id),
        )
        for index, suggestion in enumerate(suggestions, start=1):
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
    """Return the user-facing approval blockers in the existing API order."""

    return list(missing_approval_field_codes(draft))


def grounding_errors_for_draft(db: Database, draft: dict) -> list[str]:
    try:
        chunk = documents_repository.get_chunk(
            db,
            draft["project_id"],
            draft["document_id"],
            draft["chunk_id"],
        )
    except NotFoundError:
        return ["document_chunk"]

    source_chunk = SourceChunk(
        id=chunk["id"],
        page_number=chunk["page_number"],
        text=chunk["text"],
        raw_text=chunk["raw_text"],
        source_excerpt=chunk["source_excerpt"],
    )
    return list(grounding_error_codes(draft, source_chunk))


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
