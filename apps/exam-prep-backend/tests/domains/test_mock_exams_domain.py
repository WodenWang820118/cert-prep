from __future__ import annotations

from exam_prep_backend.domains.mock_exams import (
    GENERATED_DRAFT_STATUS,
    AnswerKeySource,
    DraftStatus,
    DraftSuggestion,
    SourceChunk,
    answer_key_source_from_value,
    approval_decision,
    grounding_errors_for_draft,
    missing_approval_fields,
    normalize_answer,
)


def test_contract_values_preserve_current_serialized_strings() -> None:
    assert [status.value for status in DraftStatus] == ["draft", "approved"]
    assert [source.value for source in AnswerKeySource] == ["manual", "pdf", "ai_inferred"]
    assert GENERATED_DRAFT_STATUS is DraftStatus.APPROVED
    assert answer_key_source_from_value("unexpected") is AnswerKeySource.AI_INFERRED


def test_draft_suggestion_serializes_answer_key_source_as_string() -> None:
    suggestion = DraftSuggestion(
        chunk_id="chunk-1",
        question="Which action applies the cited concept?",
        choices=["Apply it", "Ignore it"],
        answer="Apply it",
        answer_key_source="pdf",
        rationale="The source says to apply it.",
        citation_page=2,
        source_excerpt="Apply the cited concept.",
    )

    assert suggestion.to_serialized() == {
        "chunk_id": "chunk-1",
        "question": "Which action applies the cited concept?",
        "choices": ["Apply it", "Ignore it"],
        "answer": "Apply it",
        "answer_key_source": "pdf",
        "rationale": "The source says to apply it.",
        "citation_page": 2,
        "source_excerpt": "Apply the cited concept.",
        "confidence": None,
        "source_order": None,
        "source_question_number": None,
        "item_kind": "unknown",
        "group_key": None,
        "group_prompt": None,
    }


def test_normalize_answer_accepts_choice_labels_and_prefixed_choices() -> None:
    choices = ["Apply the cited concept", "Ignore the cited source"]
    numbered_choices = ["1 Apply the cited concept", "2 Ignore the cited source"]

    assert normalize_answer("B", choices) == "Ignore the cited source"
    assert normalize_answer("2:", numbered_choices) == "2 Ignore the cited source"
    assert normalize_answer("Apply the cited concept", choices) == "Apply the cited concept"


def test_approval_policy_reports_missing_learning_evidence_in_store_order() -> None:
    draft = {
        "document_id": None,
        "chunk_id": "",
        "citation_page": None,
        "source_excerpt": None,
        "choices": ["A"],
        "answer": None,
        "rationale": "",
    }

    assert missing_approval_fields(draft) == (
        "document_id",
        "chunk_id",
        "citation_page",
        "source_excerpt",
        "choices",
        "answer",
        "rationale",
    )
    assert approval_decision(draft).blocked


def test_approval_policy_accepts_complete_grounded_draft() -> None:
    draft = {
        "document_id": "doc-1",
        "chunk_id": "chunk-1",
        "citation_page": 3,
        "source_excerpt": "least privilege limits access",
        "choices": ["Apply least privilege", "Grant all access"],
        "answer": "Apply least privilege",
        "rationale": "The cited source limits access.",
    }
    chunk = SourceChunk(
        id="chunk-1",
        page_number=3,
        text="The rule says least privilege limits access to required permissions.",
        source_excerpt="least privilege limits access",
    )

    assert approval_decision(draft).approved
    assert grounding_errors_for_draft(draft, chunk) == ()


def test_grounding_policy_reports_page_and_excerpt_mismatches() -> None:
    draft = {
        "citation_page": 2,
        "source_excerpt": "made up citation",
    }
    chunk = SourceChunk(
        id="chunk-1",
        page_number=3,
        text="The real source excerpt is different.",
    )

    assert grounding_errors_for_draft(draft, chunk) == ("citation_page", "source_excerpt")
