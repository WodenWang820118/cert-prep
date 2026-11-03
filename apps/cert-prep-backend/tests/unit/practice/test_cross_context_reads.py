"""Practice's ports over Study Projects, Source Library and Question Authoring."""

from __future__ import annotations

from collections.abc import Sequence

import pytest

from cert_prep_backend.authoring.domain.draft import QuestionDraft
from cert_prep_backend.bootstrap.practice_reads import (
    DocumentMembership,
    DraftsAsPracticeQuestions,
    ProjectExistence,
)
from cert_prep_backend.platform.errors import NotFoundError
from cert_prep_backend.practice.application.ports import DraftedQuestion
from cert_prep_backend.practice.domain.session import QuestionDraftStatus
from cert_prep_backend.projects.domain.project import Project, ProjectName


def _draft(
    draft_id: str, *, status: str = "approved", answer_key_source: object = "manual"
) -> QuestionDraft:
    return QuestionDraft(
        id=draft_id,
        project_id="project",
        document_id="document",
        chunk_id=None,
        question="Which access model?",
        choices=("Least privilege", "Open access"),
        answer="Least privilege",
        answer_key_source=answer_key_source,
        rationale="Keep permissions scoped.",
        citation_page=2,
        citation_locator_kind="page",
        citation_start_ms=None,
        citation_end_ms=None,
        source_excerpt="Least privilege.",
        confidence=None,
        source_order=4,
        source_question_number=None,
        item_kind="unknown",
        group_key=None,
        group_prompt=None,
        status=status,
        rejection_reason=None,
        created_at="t1",
        updated_at="t1",
    )


class DraftRepository:
    def __init__(self, drafts: list[QuestionDraft]) -> None:
        self.drafts = drafts
        self.approved_document_id: str | None = None

    def approved(self, project_id: str, *, document_id: str | None) -> list[QuestionDraft]:
        assert project_id == "project"
        self.approved_document_id = document_id
        return self.drafts

    def find(self, project_id: str, draft_id: str) -> QuestionDraft | None:
        assert project_id == "project"
        return next((draft for draft in self.drafts if draft.id == draft_id), None)

    def find_many(self, project_id: str, draft_ids: Sequence[str]) -> list[QuestionDraft]:
        assert project_id == "project"
        by_id = {draft.id: draft for draft in self.drafts}
        return [by_id[draft_id] for draft_id in draft_ids if draft_id in by_id]


class Projects:
    def __init__(self, project_id: str | None) -> None:
        self.project_id = project_id

    def get(self, project_id: str) -> Project | None:
        if project_id != self.project_id:
            return None
        return Project(
            id=project_id,
            name=ProjectName("JLPT"),
            description="",
            created_at="t0",
            updated_at="t0",
        )


class Documents:
    def __init__(self, found: bool) -> None:
        self.found = found
        self.calls: list[tuple[str, str]] = []

    def document(self, project_id: str, document_id: str) -> object:
        self.calls.append((project_id, document_id))
        if not self.found:
            raise NotFoundError("Document not found.")
        return object()


def test_project_existence_uses_the_study_project() -> None:
    assert ProjectExistence(Projects("project")).exists("project") is True
    assert ProjectExistence(Projects("project")).exists("other") is False


def test_document_membership_requires_the_source_document() -> None:
    missing = Documents(found=False)
    with pytest.raises(NotFoundError, match="^Document not found.$"):
        DocumentMembership(missing).require("project", "document")
    assert missing.calls == [("project", "document")]

    DocumentMembership(Documents(found=True)).require("project", "document")


def test_drafts_are_read_as_practice_questions_without_reordering() -> None:
    first, second = _draft("second"), _draft("first")
    repository = DraftRepository([first, second])
    questions = DraftsAsPracticeQuestions(repository)

    approved = questions.approved("project", document_id="document")
    assert [draft.id for draft in approved] == ["second", "first"]
    assert repository.approved_document_id == "document"
    assert questions.current("project", "missing") is None
    assert questions.current_many("project", ["missing", "first"])[0].id == "first"


def test_a_draft_standing_in_for_a_snapshot_stays_approved() -> None:
    drafted = DraftedQuestion(
        id="draft",
        choices=("A", "B"),
        correct_answer="A",
        question="Q?",
        status="retired",
        rationale=None,
        citation_page=1,
        source_excerpt=None,
        document_id="document",
        answer_key_source="pdf",
    )

    shown = drafted.as_question(keep_status=False)
    current = DraftsAsPracticeQuestions(DraftRepository([_draft("draft")])).current(
        "project", "draft"
    )

    assert shown.status is QuestionDraftStatus.APPROVED
    assert shown.answer_key_source == "pdf"
    assert current is not None and current.status == "approved"
    assert current.as_question(keep_status=True).document_id == "document"


def test_a_non_text_answer_key_source_is_left_out() -> None:
    drafted = DraftsAsPracticeQuestions(
        DraftRepository([_draft("draft", answer_key_source=None)])
    ).current("project", "draft")

    assert drafted is not None
    assert drafted.answer_key_source is None
