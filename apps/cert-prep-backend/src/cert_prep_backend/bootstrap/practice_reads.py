"""Practice's reads of other contexts, bound to the caller's SQLite connection.

Practice defines the ports. These adapters call the owning context's use cases.
Passing the connection is the existing way to stay inside the caller's transaction
(`insert_processing_document`, `begin_capture_review_commit_in_connection`): practice's
BEGIN IMMEDIATE unit of work hands its connection in, and the read sees that transaction.
Document membership stays on its own connection, as the old `require_document` did.
"""

from __future__ import annotations

from collections.abc import Sequence
from sqlite3 import Connection

from cert_prep_backend.authoring.application import use_cases as authoring
from cert_prep_backend.authoring.application.ports import QuestionDraftRepository
from cert_prep_backend.authoring.domain.draft import QuestionDraft
from cert_prep_backend.authoring.infrastructure.repository import SqliteQuestionDraftRepository
from cert_prep_backend.bootstrap.source_library_links import document_repository
from cert_prep_backend.bootstrap.study_projects import ProjectExistence
from cert_prep_backend.platform.database import Database
from cert_prep_backend.practice.application.ports import (
    DraftedQuestion,
    PracticeQuestions,
    ProjectDocuments,
    StudyProjects,
)
from cert_prep_backend.projects.infrastructure.repository import SqliteProjectRepository
from cert_prep_backend.source_library.application import use_cases as source_library
from cert_prep_backend.source_library.application.ports import DocumentRepository


class DocumentMembership:
    """Source Library's `view_document`: the document belongs to the project, or NotFoundError."""

    def __init__(self, documents: DocumentRepository) -> None:
        self._documents = documents

    def require(self, project_id: str, document_id: str) -> None:
        source_library.view_document(self._documents, project_id, document_id)


class DraftsAsPracticeQuestions:
    """Question Authoring's draft reads, as the questions practice asks about."""

    def __init__(self, drafts: QuestionDraftRepository) -> None:
        self._drafts = drafts

    def approved(self, project_id: str, *, document_id: str | None) -> list[DraftedQuestion]:
        return [
            _drafted_question(draft)
            for draft in authoring.approved_questions(
                self._drafts, project_id, document_id=document_id
            )
        ]

    def current(self, project_id: str, question_id: str) -> DraftedQuestion | None:
        draft = authoring.find_question_draft(self._drafts, project_id, question_id)
        return None if draft is None else _drafted_question(draft)

    def current_many(self, project_id: str, question_ids: Sequence[str]) -> list[DraftedQuestion]:
        return [
            _drafted_question(draft)
            for draft in authoring.question_drafts_for(self._drafts, project_id, question_ids)
        ]


def bind_practice_reads(
    db: Database, connection: Connection
) -> tuple[StudyProjects, PracticeQuestions]:
    """Project and draft reads on `connection`, so they share practice's transaction."""

    return (
        ProjectExistence(SqliteProjectRepository(db, connection)),
        DraftsAsPracticeQuestions(SqliteQuestionDraftRepository(db, connection)),
    )


def practice_documents(db: Database) -> ProjectDocuments:
    """Document membership on its own connection."""

    return DocumentMembership(document_repository(db))


def _drafted_question(draft: QuestionDraft) -> DraftedQuestion:
    answer_key_source = draft.answer_key_source
    if not isinstance(answer_key_source, str):
        answer_key_source = None
    status = draft.status if isinstance(draft.status, str) else str(draft.status)
    return DraftedQuestion(
        id=draft.id,
        choices=tuple(draft.choices),
        correct_answer=draft.answer,
        question=draft.question,
        status=status,
        rationale=draft.rationale,
        citation_page=draft.citation_page,
        source_excerpt=draft.source_excerpt,
        document_id=draft.document_id,
        answer_key_source=answer_key_source,
    )
