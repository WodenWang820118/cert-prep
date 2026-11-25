from __future__ import annotations

import sqlite3

import pytest

from conftest import minimal_pdf
from cert_prep_backend.authoring.infrastructure import question_generation_jobs
from cert_prep_backend.authoring.infrastructure import manual_operations
from cert_prep_backend.authoring.infrastructure import repository as questions_repository
from cert_prep_backend.authoring.domain.models import QuestionSuggestion, UnavailableQuestionBlock
from cert_prep_backend.bootstrap.authoring_links import bind_document_question_count
from cert_prep_backend.bootstrap.study_projects import authoring_projects
from cert_prep_backend.bootstrap.authoring_links import authoring_documents
from cert_prep_backend.authoring.infrastructure.sources import SourceLibraryQuestionSources
from cert_prep_backend.bootstrap.source_library_links import document_repository


def test_question_insert_and_success_attribution_commit_together(client, auth_headers) -> None:
    project_id, document_id, chunk = _source_chunk(client, auth_headers)
    job = question_generation_jobs.enqueue_chunk_job(
        client.app.state.database,
        project_id=project_id,
        document_id=document_id,
        chunk_id=chunk["id"],
        page_number=chunk["page_number"],
        strategy="hybrid_reasoning",
        provider="future-provider",
        model="qwen3.5:4b",
        projects=authoring_projects(client.app.state.database),
        sources=SourceLibraryQuestionSources(document_repository(client.app.state.database)),
    )
    question_generation_jobs.mark_running(client.app.state.database, job.id)
    question_generation_jobs.begin_commit(client.app.state.database, job.id)

    questions_repository.append_generated_questions_and_complete_job(
        client.app.state.database,
        question_count=bind_document_question_count(client.app.state.database),
        job_id=job.id,
        project_id=project_id,
        document_id=document_id,
        suggestions=[_suggestion(chunk)],
        effective_provider="future-provider",
        effective_model="future-model-fallback",
        fallback_reason="primary model required more memory",
        projects=authoring_projects(client.app.state.database),
    )

    completed = question_generation_jobs.get_job(client.app.state.database, job.id)
    assert completed.status == "succeeded"
    assert completed.effective_provider == "future-provider"
    assert completed.effective_model == "future-model-fallback"
    assert completed.fallback_reason == "primary model required more memory"
    assert completed.phase == "completed"
    assert completed.cancellable is False
    assert len(questions_repository.list_questions(client.app.state.database, project_id, projects=authoring_projects(client.app.state.database))) == 1


def test_question_insert_rolls_back_when_success_attribution_cannot_commit(
    client,
    auth_headers,
) -> None:
    project_id, document_id, chunk = _source_chunk(client, auth_headers)
    job = question_generation_jobs.enqueue_chunk_job(
        client.app.state.database,
        project_id=project_id,
        document_id=document_id,
        chunk_id=chunk["id"],
        page_number=chunk["page_number"],
        strategy="hybrid_reasoning",
        provider="future-provider",
        model="qwen3.5:4b",
        projects=authoring_projects(client.app.state.database),
        sources=SourceLibraryQuestionSources(document_repository(client.app.state.database)),
    )
    question_generation_jobs.mark_running(client.app.state.database, job.id)
    question_generation_jobs.begin_commit(client.app.state.database, job.id)
    with client.app.state.database.connect() as connection:
        connection.execute(
            """
            CREATE TRIGGER reject_question_job_success
            BEFORE UPDATE OF status ON question_generation_jobs
            WHEN NEW.status = 'succeeded'
            BEGIN
                SELECT RAISE(ABORT, 'success attribution rejected');
            END;
            """
        )

    with pytest.raises(sqlite3.IntegrityError, match="success attribution rejected"):
        questions_repository.append_generated_questions_and_complete_job(
            client.app.state.database,
            question_count=bind_document_question_count(client.app.state.database),
            job_id=job.id,
            project_id=project_id,
            document_id=document_id,
            suggestions=[_suggestion(chunk)],
            effective_provider="future-provider",
            effective_model="qwen3.5:4b",
            fallback_reason=None,
            projects=authoring_projects(client.app.state.database),
        )

    assert questions_repository.list_questions(client.app.state.database, project_id, projects=authoring_projects(client.app.state.database)) == []
    persisted = question_generation_jobs.get_job(client.app.state.database, job.id)
    assert persisted.status == "running"
    assert persisted.phase == "committing"


def test_manual_operation_persists_unavailable_parsed_blocks_without_playable_rows(
    client,
    auth_headers,
) -> None:
    project_id, document_id, chunk = _source_chunk(client, auth_headers)
    operation = manual_operations.create_operation(
        client.app.state.database,
        project_id=project_id,
        document_id=document_id,
        limit=1,
        strategy="hybrid_reasoning",
        provider="capture-runtime-question-completion",
        model="qwen3.5:4b",
        projects=authoring_projects(client.app.state.database),
        documents=authoring_documents(client.app.state.database),
    )
    manual_operations.mark_running(client.app.state.database, operation.id)
    manual_operations.begin_commit(client.app.state.database, operation.id)

    questions_repository.append_generated_questions_and_complete_manual_operation(
        client.app.state.database,
        question_count=bind_document_question_count(client.app.state.database),
        operation_id=operation.id,
        project_id=project_id,
        document_id=document_id,
        suggestions=[],
        effective_provider=None,
        effective_model=None,
        fallback_reason=None,
        unavailable_blocks=[
            UnavailableQuestionBlock(
                chunk_id=chunk["id"],
                citation_page=chunk["page_number"],
                source_excerpt="JLPT question 1",
                source_order=10001,
                source_question_number="1",
                reason="Capture Runtime question completion returned no playable answer.",
            )
        ],
        projects=authoring_projects(client.app.state.database),
    )

    completed = manual_operations.get_operation(
        client.app.state.database,
        project_id=project_id,
        document_id=document_id,
        operation_id=operation.id,
    )
    assert completed.status == "succeeded"
    assert completed.generated_count == 0
    assert list(completed.unavailable_blocks) == [
        {
            "status": "needs_review",
            "chunk_id": chunk["id"],
            "citation_page": chunk["page_number"],
            "source_excerpt": "JLPT question 1",
            "source_order": 10001,
            "source_question_number": "1",
            "reason": "Capture Runtime question completion returned no playable answer.",
        }
    ]
    assert questions_repository.list_questions(client.app.state.database, project_id, projects=authoring_projects(client.app.state.database)) == []


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


def _suggestion(chunk: dict) -> QuestionSuggestion:
    return QuestionSuggestion(
        chunk_id=chunk["id"],
        question="Choose the correct word.",
        choices=["A correct", "B wrong"],
        answer="A correct",
        answer_key_source="ai_inferred",
        rationale="The cited source identifies A.",
        citation_page=chunk["page_number"],
        source_excerpt="JLPT question 1",
    )
