from __future__ import annotations

import json

import pytest

from cert_prep_backend.authoring.domain.models import DraftSuggestion
from cert_prep_backend.authoring.infrastructure import draft_jobs
from cert_prep_backend.authoring.infrastructure import repository as drafts_repository

from test_draft_job_attribution import _source_chunk


def _full_suggestion(chunk: dict) -> DraftSuggestion:
    return DraftSuggestion(
        chunk_id=chunk["id"],
        question="Which word fits?",
        choices=["A one", "B two", "C three"],
        answer="B two",
        answer_key_source="pdf",
        rationale="Because B.",
        citation_page=chunk["page_number"],
        source_excerpt="excerpt text",
        status="approved",
        confidence=0.75,
        source_order=7,
        source_question_number="Q7",
        item_kind="grouped_question",
        group_key="group-1",
        group_prompt="Read the passage.",
    )


def _create_via_plain_path(db, project_id, document_id, suggestions):
    return drafts_repository.create_generated_drafts(
        db, project_id=project_id, document_id=document_id, suggestions=suggestions
    )


def _create_via_job_path(db, project_id, document_id, suggestions):
    job = draft_jobs.enqueue_chunk_job(
        db,
        project_id=project_id,
        document_id=document_id,
        chunk_id=suggestions[0].chunk_id,
        page_number=suggestions[0].citation_page,
        strategy="hybrid_reasoning",
        provider="p",
        model="m",
    )
    draft_jobs.mark_running(db, job.id)
    draft_jobs.begin_commit(db, job.id)
    return drafts_repository.append_generated_drafts_and_complete_job(
        db,
        job_id=job.id,
        project_id=project_id,
        document_id=document_id,
        suggestions=suggestions,
        effective_provider="p",
        effective_model="m",
        fallback_reason=None,
    )


@pytest.mark.parametrize("create", [_create_via_plain_path, _create_via_job_path])
def test_generated_draft_insert_persists_every_column(client, auth_headers, create) -> None:
    db = client.app.state.database
    project_id, document_id, chunk = _source_chunk(client, auth_headers)
    full = _full_suggestion(chunk)
    sparse = DraftSuggestion(
        chunk_id=chunk["id"],
        question="Sparse?",
        choices=["A", "B"],
        answer="A",
        answer_key_source="ai_inferred",
        rationale="r",
        citation_page=chunk["page_number"],
        source_excerpt="s",
    )

    created = create(db, project_id, document_id, [full, sparse])
    assert len(created) == 2

    with db.connect() as connection:
        rows = {
            row["question"]: dict(row)
            for row in connection.execute(
                "SELECT * FROM question_drafts WHERE project_id = ?", (project_id,)
            ).fetchall()
        }

    stored = rows["Which word fits?"]
    assert stored["created_at"] and stored["created_at"] == stored["updated_at"]
    assert {key: value for key, value in stored.items() if key not in {"id", "created_at", "updated_at"}} == {
        "project_id": project_id,
        "document_id": document_id,
        "chunk_id": chunk["id"],
        "question": "Which word fits?",
        "choices_json": json.dumps(["A one", "B two", "C three"]),
        "answer": "B two",
        "answer_key_source": "pdf",
        "rationale": "Because B.",
        "citation_page": chunk["page_number"],
        "source_excerpt": "excerpt text",
        "status": "approved",
        "confidence": 0.75,
        "source_order": 7,
        "source_question_number": "Q7",
        "item_kind": "grouped_question",
        "group_key": "group-1",
        "group_prompt": "Read the passage.",
        "rejection_reason": None,
        # Columns the INSERT leaves to their schema defaults.
        "citation_locator_kind": "page",
        "citation_start_ms": None,
        "citation_end_ms": None,
    }
    assert stored["id"] in {draft.id for draft in created}

    default = rows["Sparse?"]
    assert default["source_order"] == 2  # falls back to the 1-based position
    assert default["confidence"] is None
    assert default["source_question_number"] is None
    assert default["group_key"] is None
    assert default["group_prompt"] is None
    assert default["rejection_reason"] is None
    assert default["item_kind"] == "unknown"
