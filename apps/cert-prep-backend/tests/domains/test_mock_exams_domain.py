from __future__ import annotations

from cert_prep_backend.domains.mock_exams import (
    GENERATED_DRAFT_STATUS,
    AnswerKeySource,
    DraftStatus,
    DraftSuggestion,
    answer_key_source_from_value,
    normalize_answer,
)


def test_contract_values_preserve_current_serialized_strings() -> None:
    assert [status.value for status in DraftStatus] == ["approved"]
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
