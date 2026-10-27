"""Question Draft: a learner's correction changes only what they give, and a cited source names
both its document and its chunk."""

from __future__ import annotations

import pytest

from cert_prep_backend.authoring.domain.draft import DraftEdit, NewQuestionDraft, QuestionDraft
from cert_prep_backend.platform.errors import ValidationError

CREATED = "2026-10-27T00:00:00+00:00"
EDITED = "2026-10-27T01:00:00+00:00"


def _draft() -> QuestionDraft:
    return QuestionDraft(
        id="draft",
        project_id="project",
        document_id="document",
        chunk_id="chunk",
        question="Which control limits access?",
        choices=("Least privilege", "Open shares"),
        answer="Least privilege",
        answer_key_source="pdf",
        rationale="Only needed access.",
        citation_page=2,
        citation_locator_kind="page",
        citation_start_ms=None,
        citation_end_ms=None,
        source_excerpt="Least privilege applies.",
        confidence=0.75,
        source_order=3,
        source_question_number="7",
        item_kind="vocabulary_single",
        group_key=None,
        group_prompt=None,
        status="approved",
        rejection_reason=None,
        created_at=CREATED,
        updated_at=CREATED,
    )


def test_an_edit_changes_only_the_fields_given() -> None:
    edited = _draft().edited(DraftEdit(question="Which control?", choices=["A", "B"]), now=EDITED)

    assert (edited.question, edited.choices) == ("Which control?", ("A", "B"))
    assert edited.answer == "Least privilege"
    assert edited.rationale == "Only needed access."
    assert edited.updated_at == EDITED


def test_an_edit_may_clear_text_with_an_empty_string_but_not_with_none() -> None:
    edited = _draft().edited(DraftEdit(rationale="", group_key=None), now=EDITED)

    assert edited.rationale == ""
    assert edited.group_key is None


def test_an_edit_keeps_the_source_status_and_creation_time() -> None:
    draft = _draft()

    edited = draft.edited(DraftEdit(answer="Open shares", answer_key_source="manual"), now=EDITED)

    assert (edited.document_id, edited.chunk_id, edited.citation_locator_kind) == (
        "document",
        "chunk",
        "page",
    )
    assert (edited.status, edited.created_at) == ("approved", CREATED)
    assert draft.answer == "Least privilege"


def test_an_empty_edit_only_touches_the_update_time() -> None:
    draft = _draft()

    assert draft.edited(DraftEdit(), now=EDITED) == QuestionDraft(
        **{**{field: getattr(draft, field) for field in draft.__slots__}, "updated_at": EDITED}
    )


@pytest.mark.parametrize(
    ("document_id", "chunk_id"),
    [("document", None), (None, "chunk")],
)
def test_a_cited_source_names_both_document_and_chunk(
    document_id: str | None, chunk_id: str | None
) -> None:
    draft = NewQuestionDraft(question="Q?", document_id=document_id, chunk_id=chunk_id)

    assert draft.cites_a_source
    with pytest.raises(ValidationError, match="must be provided together"):
        draft.ensure_source_is_complete()


@pytest.mark.parametrize(
    ("document_id", "chunk_id", "cites"),
    [(None, None, False), ("document", "chunk", True)],
)
def test_a_draft_without_or_with_a_whole_source_is_complete(
    document_id: str | None, chunk_id: str | None, cites: bool
) -> None:
    draft = NewQuestionDraft(question="Q?", document_id=document_id, chunk_id=chunk_id)

    draft.ensure_source_is_complete()
    assert draft.cites_a_source is cites


def test_a_new_draft_defaults_to_a_manual_answer_key() -> None:
    draft = NewQuestionDraft(choices=["A", "B"])

    assert draft.answer_key_source == "manual"
    assert draft.choices == ("A", "B")
