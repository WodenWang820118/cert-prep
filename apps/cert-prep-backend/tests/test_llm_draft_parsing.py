import pytest

from cert_prep_backend.api.errors import ProviderUnavailableError
from cert_prep_backend.domains.mock_exams.models import (
    DraftGenerationStrategy,
    DraftSuggestion,
    SourceChunk,
)
from cert_prep_backend.domains.mock_exams.provider import (
    MAX_PROMPT_SOURCE_CHARS,
    _draft_suggestion_from_item,
    _extract_jlpt_question_blocks,
    _json_response,
    _source_text_for_prompt,
    generate_drafts_for_strategy,
)


def test_draft_parser_rejects_cover_and_instruction_text_as_exam_items() -> None:
    rejected_texts = [
        "This test paper has multiple versions with the same question content.",
        "General instructions: do not open this booklet until you are told to start.",
    ]

    for rejected_text in rejected_texts:
        _assert_rejected_as_non_exam_item(rejected_text)

def test_draft_parser_accepts_jlpt_like_choice_item() -> None:
    chunk = SourceChunk(
        id="chunk-2",
        page_number=3,
        text=("Mondai 1 Choose the correct reading. 1 seikai 2 gotou 3 betsu 4 hoka"),
        source_excerpt="Mondai 1 Choose the correct reading.",
    )

    suggestion = _draft_suggestion_from_item(
        {
            "chunk_id": "chunk-2",
            "citation_page": 3,
            "question": "Mondai 1 Choose the correct reading.",
            "choices": ["1 seikai", "2 gotou", "3 betsu", "4 hoka"],
            "answer": "1",
            "answer_key_source": "ai_inferred",
            "rationale": "Choice 1 matches the inferred reading.",
            "source_excerpt": "Mondai 1 Choose the correct reading.",
            "confidence": 0.82,
        },
        {3: chunk},
        {"chunk-2": chunk},
    )

    assert suggestion is not None
    assert suggestion.answer == "1 seikai"
    assert suggestion.citation_page == 3
    assert suggestion.confidence == 0.82

def test_draft_parser_rejects_invalid_json_and_grounding_mismatches() -> None:
    chunk = SourceChunk(
        id="chunk-2",
        page_number=3,
        text="Mondai 1 Choose the correct reading. 1 seikai 2 gotou 3 betsu 4 hoka",
        source_excerpt="Mondai 1 Choose the correct reading.",
    )
    valid_item = {
        "chunk_id": "chunk-2",
        "citation_page": 3,
        "question": "Mondai 1 Choose the correct reading.",
        "choices": ["1 seikai", "2 gotou", "3 betsu", "4 hoka"],
        "answer": "1",
        "answer_key_source": "ai_inferred",
        "rationale": "Choice 1 matches the inferred reading.",
        "source_excerpt": "Mondai 1 Choose the correct reading.",
        "confidence": 0.82,
    }

    with pytest.raises(ProviderUnavailableError, match="invalid JSON"):
        _json_response({"message": {"content": "not-json"}})
    assert (
        _draft_suggestion_from_item(
            valid_item | {"citation_page": 99},
            {3: chunk},
            {"chunk-2": chunk},
        )
        is None
    )
    assert (
        _draft_suggestion_from_item(
            valid_item | {"source_excerpt": "not in source"},
            {3: chunk},
            {"chunk-2": chunk},
        )
        is None
    )
    assert (
        _draft_suggestion_from_item(
            valid_item | {"answer": "missing choice"},
            {3: chunk},
            {"chunk-2": chunk},
        )
        is None
    )

def test_generate_drafts_for_strategy_uses_reasoning_provider_protocol() -> None:
    class CustomReasoningProvider:
        provider = "custom-reasoning"
        model = "custom-model"

        def generate_drafts(self, _chunks, _limit):
            raise AssertionError("reasoning-capable providers should use reasoning drafts")

        def generate_reasoning_drafts(self, chunks, limit, **_kwargs):
            chunk = chunks[0]
            return [
                DraftSuggestion(
                    chunk_id=chunk.id,
                    question="JLPT question: choose the correct word.",
                    choices=["A correct", "B wrong"],
                    answer="A correct",
                    answer_key_source="ai_inferred",
                    rationale="The visible source supports A.",
                    citation_page=chunk.page_number,
                    source_excerpt="JLPT question: choose the correct word.",
                )
            ][:limit]

    chunk = SourceChunk(
        id="chunk-1",
        page_number=1,
        text="JLPT question: choose the correct word. A correct B wrong",
        source_excerpt="JLPT question: choose the correct word.",
    )

    suggestions = generate_drafts_for_strategy(
        CustomReasoningProvider(),
        [chunk],
        1,
        DraftGenerationStrategy.HYBRID_REASONING,
    )

    assert [suggestion.answer for suggestion in suggestions] == ["A correct"]

def test_ollama_prompt_source_skips_notice_pages_and_stays_bounded() -> None:
    notice = SourceChunk(
        id="cover",
        page_number=1,
        text=(
            "This test paper has multiple versions. The questions are the same, "
            "but the fonts and layouts differ."
        ),
        source_excerpt="This test paper has multiple versions.",
    )
    first_exam_page = SourceChunk(
        id="page-2",
        page_number=2,
        text=(
            "問題1 の言葉の読み方として最もよいのを、1・2・3・4から"
            "一つ選びなさい。 1 余暇の楽しみ方はいろいろある。"
            " 1 ようか 2 よか 3 よが 4 ようが"
        ),
        source_excerpt="問題1 の言葉の読み方として最もよいのを選びなさい。",
    )
    long_exam_page = SourceChunk(
        id="page-3",
        page_number=3,
        text="問題2 " + ("日本語の設問 " * 2000),
        source_excerpt="問題2",
    )

    source = _source_text_for_prompt([notice, first_exam_page, long_exam_page], limit=3)

    assert "chunk_id:cover" not in source
    assert "chunk_id:page-2" in source
    assert "余暇" in source
    assert len(source) <= MAX_PROMPT_SOURCE_CHARS

def test_jlpt_question_blocks_extract_as_unanswered_candidates_without_ai() -> None:
    chunk = SourceChunk(
        id="page-2",
        page_number=2,
        text=(
            "問題1 の言葉の読み方として最もよいのを、1・2・3・4から"
            "一つ選びなさい。 1 余暇の楽しみ方はいろいろある。 "
            "1 ようか 2 よか 3 よが 4 ようが "
            "2 その動物は動きが鈍い。 1 するどい 2 にぶい 3 あらい 4 あやうい"
        ),
        source_excerpt="問題1 の言葉の読み方として最もよいのを選びなさい。",
    )

    suggestions = _extract_jlpt_question_blocks([chunk], limit=2)

    assert len(suggestions) == 2
    assert suggestions[0].question == "余暇の楽しみ方はいろいろある。"
    assert suggestions[0].choices == ("1 ようか", "2 よか", "3 よが", "4 ようが")
    assert suggestions[0].answer == ""
    assert suggestions[0].answer_key_source.value == "manual"
    assert suggestions[0].status.value == "approved"
    assert suggestions[0].citation_page == 2
    assert suggestions[0].confidence == 1.0
    assert suggestions[0].source_order == 20001
    assert suggestions[0].source_question_number == "1"
    assert suggestions[0].item_kind.value == "vocabulary_single"
    assert suggestions[0].group_key is None

def _assert_rejected_as_non_exam_item(rejected_text: str) -> None:
    chunk = SourceChunk(
        id="chunk-1",
        page_number=1,
        text=f"2025 JLPT N1 notice. {rejected_text}",
        source_excerpt=rejected_text,
    )

    suggestion = _draft_suggestion_from_item(
        {
            "citation_page": 1,
            "question": rejected_text,
            "choices": [
                f"A. {rejected_text}",
                "B. The content is unchanged, but fonts and layout may differ.",
            ],
            "answer": "B",
            "answer_key_source": "ai_inferred",
            "rationale": "The notice says the content is the same.",
            "source_excerpt": rejected_text,
            "confidence": 0.7,
        },
        {1: chunk},
        {"chunk-1": chunk},
    )

    assert suggestion is None
