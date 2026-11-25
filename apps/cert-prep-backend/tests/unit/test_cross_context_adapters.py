"""Unit tests for cross-context adapters connecting Question Authoring and Capture Integration
to Study Projects and Source Library through ports (DDD step C5, part 3).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from cert_prep_backend.authoring.domain.question import NewQuestion
from cert_prep_backend.authoring.domain.models import SourceChunk
from cert_prep_backend.authoring.infrastructure.sources import SourceLibraryQuestionSources
from cert_prep_backend.bootstrap.authoring_links import (
    authoring_sources,
    question_generation_job_repository,
    question_repository,
)
from cert_prep_backend.bootstrap.capture_links import (
    bind_capture_review_commit,
    capture_operations,
)
from cert_prep_backend.bootstrap.source_library_links import (
    source_operation_repository,
    source_repository,
)
from cert_prep_backend.bootstrap.study_projects import authoring_projects
from cert_prep_backend.platform.config import Settings
from cert_prep_backend.platform.database import Database
from cert_prep_backend.platform.errors import NotFoundError


def _database(tmp_path: Path) -> Database:
    db = Database(Settings(data_dir=tmp_path, api_token="test-token"))
    db.migrate()
    with db.connect() as connection:
        connection.execute(
            """
            INSERT INTO projects(id, name, description, created_at, updated_at)
            VALUES ('proj', 'Study', '', 't0', 't0')
            """
        )
    return db


def _attach_pdf(db: Database, *, operation_id: str) -> str:
    ops = source_operation_repository(db)
    repository = source_repository(db)
    assert ops.claim_upload("proj", operation_id)
    source = repository.attach_source(
        "proj",
        operation_id,
        filename="source.pdf",
        source_kind="pdf",
        sha256="sha",
        language_hint="auto",
        storage_path="C:/data/source.pdf",
        page_count=1,
    )
    return source.id


def test_authoring_projects_adapter(tmp_path: Path) -> None:
    db = _database(tmp_path)
    projects = authoring_projects(db)

    assert projects.exists("proj") is True
    assert projects.exists("non-existent-proj") is False


def test_authoring_sources_adapter(tmp_path: Path) -> None:
    db = _database(tmp_path)
    source_id = _attach_pdf(db, operation_id="upload-1")
    sources = authoring_sources(db)

    sources.require("proj", source_id)

    with pytest.raises(NotFoundError, match="Document not found"):
        sources.require("proj", "non-existent-doc")

    with pytest.raises(NotFoundError, match="Document not found"):
        sources.require("other-proj", source_id)


def test_source_library_question_sources_reads_chunks(tmp_path: Path) -> None:
    db = _database(tmp_path)
    source_id = _attach_pdf(db, operation_id="upload-2")
    repository = source_repository(db)
    sources = SourceLibraryQuestionSources(repository)

    with db.connect() as connection:
        connection.execute(
            """
            INSERT INTO source_chunks(
                id, project_id, source_id, page_number, chunk_index,
                text, source_excerpt, created_at, locator_kind
            )
            VALUES ('chunk-1', 'proj', ?, 1, 0, 'Chunk text', 'Chunk excerpt', 't0', 'page')
            """,
            (source_id,),
        )

    chunks = sources.chunks_of("proj", source_id)
    assert len(chunks) == 1
    assert isinstance(chunks[0], SourceChunk)
    assert chunks[0].id == "chunk-1"
    assert chunks[0].text == "Chunk text"

    chunk = sources.chunk("proj", source_id, "chunk-1")
    assert chunk.id == "chunk-1"

    with pytest.raises(NotFoundError, match="Document chunk not found"):
        sources.chunk("proj", source_id, "missing-chunk")


def test_question_repository_and_question_generation_jobs(tmp_path: Path) -> None:
    db = _database(tmp_path)
    source_id = _attach_pdf(db, operation_id="upload-3")
    with db.connect() as connection:
        connection.execute(
            """
            INSERT INTO source_chunks(
                id, project_id, source_id, page_number, chunk_index,
                text, source_excerpt, created_at, locator_kind
            )
            VALUES ('chunk-1', 'proj', ?, 1, 0, 'Chunk text', 'Chunk excerpt', 't0', 'page')
            """,
            (source_id,),
        )

    questions = question_repository(db)
    authored_question = questions.write(
        "proj",
        NewQuestion(
            question="What is this?",
            choices=("A", "B", "C", "D"),
            answer="A",
            rationale="Because A.",
            citation_page=1,
            source_id=source_id,
            chunk_id="chunk-1",
        ),
    )
    assert authored_question.id is not None
    assert authored_question.question == "What is this?"

    all_questions = questions.questions_of("proj")
    assert len(all_questions) == 1
    assert all_questions[0].id == authored_question.id

    found = questions.find("proj", authored_question.id)
    assert found is not None
    assert found.id == authored_question.id

    found_many = questions.find_many("proj", [authored_question.id, "non-existent"])
    assert len(found_many) == 1

    jobs = question_generation_job_repository(db)
    source_jobs = jobs.jobs_of("proj", source_id)
    assert source_jobs == []

    with pytest.raises(NotFoundError, match="Document not found"):
        jobs.jobs_of("proj", "missing-doc")


def test_capture_operations_and_review_commit(tmp_path: Path) -> None:
    db = _database(tmp_path)
    source_id = _attach_pdf(db, operation_id="upload-4")
    raw_ops = source_operation_repository(db)
    ops = capture_operations(db, raw_ops)

    op = ops.mark_review_pending("proj", source_id, "upload-4")
    assert op.phase.value == "awaiting_review"

    # bind_capture_review_commit transitions in open connection
    binder = bind_capture_review_commit()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        binder(connection).begin_commit("proj", source_id, "upload-4")

    updated_op = raw_ops.operation("proj", "upload-4")
    assert updated_op.status.value == "running"
    assert updated_op.phase.value == "processing"
