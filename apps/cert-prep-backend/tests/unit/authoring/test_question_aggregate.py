"""Question: a learner's correction changes only what they give, and a cited source names
both its document and its chunk."""

from __future__ import annotations

import pytest

from cert_prep_backend.authoring.domain.question import QuestionEdit, NewQuestion, Question
from cert_prep_backend.platform.errors import ValidationError

CREATED = "2026-10-27T00:00:00+00:00"
EDITED = "2026-10-27T01:00:00+00:00"


def _question() -> Question:
    return Question(
        id="authored_question",
        project_id="project",
        document_id="document",
        chunk_id="chunk",
        question="Which control limits access?",
        choices=("Least privilege", "Open shares"),
        answer="Least privilege",
        answer_key_source="source",
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
        created_at=CREATED,
        updated_at=CREATED,
    )


def test_an_edit_changes_only_the_fields_given() -> None:
    edited = _question().edited(QuestionEdit(question="Which control?", choices=["A", "B"]), now=EDITED)

    assert (edited.question, edited.choices) == ("Which control?", ("A", "B"))
    assert edited.answer == "Least privilege"
    assert edited.rationale == "Only needed access."
    assert edited.updated_at == EDITED


def test_an_edit_may_clear_text_with_an_empty_string_but_not_with_none() -> None:
    edited = _question().edited(QuestionEdit(rationale="", group_key=None), now=EDITED)

    assert edited.rationale == ""
    assert edited.group_key is None


def test_an_edit_keeps_the_source_status_and_creation_time() -> None:
    authored_question = _question()

    edited = authored_question.edited(QuestionEdit(answer="Open shares", answer_key_source="manual"), now=EDITED)

    assert (edited.document_id, edited.chunk_id, edited.citation_locator_kind) == (
        "document",
        "chunk",
        "page",
    )
    assert edited.created_at == CREATED
    assert authored_question.answer == "Least privilege"


def test_an_empty_edit_only_touches_the_update_time() -> None:
    authored_question = _question()

    assert authored_question.edited(QuestionEdit(), now=EDITED) == Question(
        **{**{field: getattr(authored_question, field) for field in authored_question.__slots__}, "updated_at": EDITED}
    )


@pytest.mark.parametrize(
    ("document_id", "chunk_id"),
    [("document", None), (None, "chunk")],
)
def test_a_cited_source_names_both_document_and_chunk(
    document_id: str | None, chunk_id: str | None
) -> None:
    authored_question = NewQuestion(question="Q?", document_id=document_id, chunk_id=chunk_id)

    assert authored_question.cites_a_source
    with pytest.raises(ValidationError, match="must be provided together"):
        authored_question.ensure_source_is_complete()


@pytest.mark.parametrize(
    ("document_id", "chunk_id", "cites"),
    [(None, None, False), ("document", "chunk", True)],
)
def test_a_question_without_or_with_a_whole_source_is_complete(
    document_id: str | None, chunk_id: str | None, cites: bool
) -> None:
    authored_question = NewQuestion(question="Q?", document_id=document_id, chunk_id=chunk_id)

    authored_question.ensure_source_is_complete()
    assert authored_question.cites_a_source is cites


def test_a_new_question_defaults_to_a_manual_answer_key() -> None:
    authored_question = NewQuestion(choices=["A", "B"])

    assert authored_question.answer_key_source == "manual"
    assert authored_question.choices == ("A", "B")
