"""Question reads practice asks for: approved questions, one draft, and drafts by id."""

from __future__ import annotations

from collections.abc import Sequence

from cert_prep_backend.authoring.application import use_cases
from cert_prep_backend.authoring.domain.draft import QuestionDraft


def _draft(draft_id: str, *, source_order: int | None = None) -> QuestionDraft:
    return QuestionDraft(
        id=draft_id,
        project_id="project",
        document_id="document",
        chunk_id=None,
        question=f"Question {draft_id}?",
        choices=("A", "B"),
        answer="A",
        answer_key_source="manual",
        rationale="Because",
        citation_page=1,
        citation_locator_kind="page",
        citation_start_ms=None,
        citation_end_ms=None,
        source_excerpt="Excerpt",
        confidence=None,
        source_order=source_order,
        source_question_number=None,
        item_kind="unknown",
        group_key=None,
        group_prompt=None,
        status="approved",
        rejection_reason=None,
        created_at="t1",
        updated_at="t1",
    )


class RecordingDrafts:
    def __init__(self, drafts: list[QuestionDraft]) -> None:
        self.drafts = {draft.id: draft for draft in drafts}
        self.approved_calls: list[tuple[str, str | None]] = []
        self.find_calls: list[tuple[str, str]] = []
        self.find_many_calls: list[tuple[str, tuple[str, ...]]] = []

    def approved(self, project_id: str, *, document_id: str | None) -> list[QuestionDraft]:
        self.approved_calls.append((project_id, document_id))
        return list(self.drafts.values())

    def find(self, project_id: str, draft_id: str) -> QuestionDraft | None:
        self.find_calls.append((project_id, draft_id))
        draft = self.drafts.get(draft_id)
        return draft if draft is not None and draft.project_id == project_id else None

    def find_many(self, project_id: str, draft_ids: Sequence[str]) -> list[QuestionDraft]:
        self.find_many_calls.append((project_id, tuple(draft_ids)))
        return [
            draft
            for draft_id in draft_ids
            if (draft := self.drafts.get(draft_id)) is not None and draft.project_id == project_id
        ]


def test_approved_questions_returns_the_repository_order() -> None:
    first, second = _draft("a", source_order=2), _draft("b", source_order=1)
    drafts = RecordingDrafts([first, second])

    assert use_cases.approved_questions(drafts, "project", document_id="document") == [
        first,
        second,
    ]
    assert drafts.approved_calls == [("project", "document")]


def test_find_question_draft_is_none_when_the_draft_is_gone() -> None:
    drafts = RecordingDrafts([_draft("kept")])

    assert use_cases.find_question_draft(drafts, "project", "kept") == drafts.drafts["kept"]
    assert use_cases.find_question_draft(drafts, "project", "missing") is None
    assert drafts.find_calls == [("project", "kept"), ("project", "missing")]


def test_question_drafts_for_skips_ids_with_no_draft() -> None:
    kept = _draft("kept")
    drafts = RecordingDrafts([kept])

    assert use_cases.question_drafts_for(drafts, "project", ["missing", "kept"]) == [kept]
    assert drafts.find_many_calls == [("project", ("missing", "kept"))]
