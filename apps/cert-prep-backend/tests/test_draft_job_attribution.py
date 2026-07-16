from __future__ import annotations

import sqlite3

import pytest

from conftest import minimal_pdf
from cert_prep_backend.domains.mock_exams import draft_jobs
from cert_prep_backend.domains.mock_exams import repository as drafts_repository
from cert_prep_backend.domains.mock_exams.models import DraftSuggestion


def test_draft_insert_and_success_attribution_commit_together(client, auth_headers) -> None:
    project_id, document_id, chunk = _source_chunk(client, auth_headers)
    job = draft_jobs.enqueue_chunk_job(
        client.app.state.database,
        project_id=project_id,
        document_id=document_id,
        chunk_id=chunk["id"],
        page_number=chunk["page_number"],
        strategy="hybrid_reasoning",
        provider="future-provider",
        model="qwen3.5:4b",
    )
    draft_jobs.mark_running(client.app.state.database, job["id"])
    draft_jobs.begin_commit(client.app.state.database, job["id"])

    drafts_repository.append_generated_drafts_and_complete_job(
        client.app.state.database,
        job_id=job["id"],
        project_id=project_id,
        document_id=document_id,
        suggestions=[_suggestion(chunk)],
        effective_provider="future-provider",
        effective_model="qwen3.5:2b",
        fallback_reason="primary model required more memory",
    )

    completed = draft_jobs.get_job(client.app.state.database, job["id"])
    assert completed["status"] == "succeeded"
    assert completed["effective_provider"] == "future-provider"
    assert completed["effective_model"] == "qwen3.5:2b"
    assert completed["fallback_reason"] == "primary model required more memory"
    assert completed["phase"] == "completed"
    assert completed["cancellable"] is False
    assert len(drafts_repository.list_drafts(client.app.state.database, project_id)) == 1


def test_draft_insert_rolls_back_when_success_attribution_cannot_commit(
    client,
    auth_headers,
) -> None:
    project_id, document_id, chunk = _source_chunk(client, auth_headers)
    job = draft_jobs.enqueue_chunk_job(
        client.app.state.database,
        project_id=project_id,
        document_id=document_id,
        chunk_id=chunk["id"],
        page_number=chunk["page_number"],
        strategy="hybrid_reasoning",
        provider="future-provider",
        model="qwen3.5:4b",
    )
    draft_jobs.mark_running(client.app.state.database, job["id"])
    draft_jobs.begin_commit(client.app.state.database, job["id"])
    with client.app.state.database.connect() as connection:
        connection.execute(
            """
            CREATE TRIGGER reject_draft_job_success
            BEFORE UPDATE OF status ON draft_generation_jobs
            WHEN NEW.status = 'succeeded'
            BEGIN
                SELECT RAISE(ABORT, 'success attribution rejected');
            END;
            """
        )

    with pytest.raises(sqlite3.IntegrityError, match="success attribution rejected"):
        drafts_repository.append_generated_drafts_and_complete_job(
            client.app.state.database,
            job_id=job["id"],
            project_id=project_id,
            document_id=document_id,
            suggestions=[_suggestion(chunk)],
            effective_provider="future-provider",
            effective_model="qwen3.5:4b",
            fallback_reason=None,
        )

    assert drafts_repository.list_drafts(client.app.state.database, project_id) == []
    persisted = draft_jobs.get_job(client.app.state.database, job["id"])
    assert persisted["status"] == "running"
    assert persisted["phase"] == "committing"


def _source_chunk(client, auth_headers) -> tuple[str, str, dict]:
    project_id = client.post(
        "/projects",
        headers=auth_headers,
        json={"name": "Attribution project"},
    ).json()["id"]
    document = client.post(
        f"/projects/{project_id}/documents",
        headers=auth_headers,
        files={
            "file": (
                "source.pdf",
                minimal_pdf("JLPT question 1 choose the correct word A correct B wrong"),
                "application/pdf",
            )
        },
    ).json()
    chunk = client.get(
        f"/projects/{project_id}/documents/{document['id']}/chunks",
        headers=auth_headers,
    ).json()["items"][0]
    return project_id, document["id"], chunk


def _suggestion(chunk: dict) -> DraftSuggestion:
    return DraftSuggestion(
        chunk_id=chunk["id"],
        question="Choose the correct word.",
        choices=["A correct", "B wrong"],
        answer="A correct",
        answer_key_source="ai_inferred",
        rationale="The cited source identifies A.",
        citation_page=chunk["page_number"],
        source_excerpt="JLPT question 1",
    )
