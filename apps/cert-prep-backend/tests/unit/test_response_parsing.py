from __future__ import annotations

import pytest

from cert_prep_backend.authoring.domain.models import DraftSuggestion
from cert_prep_backend.authoring.infrastructure.ollama_drafts import (
    _reasoning_system_prompt,
    _reasoning_user_prompt,
    _supplemental_reasoning_user_prompt,
)
from cert_prep_backend.authoring.infrastructure.response_parsing import (
    RATIONALE_LANGUAGE_INSTRUCTION,
    answer_from_payload,
    confidence_from_payload,
    fast_first_prompt,
    fast_first_retry_prompt,
    is_reading_question,
    json_object,
)


def _candidate(
    *,
    question: str = "Question text",
    choices: list[str] | tuple[str, ...],
    source_excerpt: str = "Source text",
) -> DraftSuggestion:
    return DraftSuggestion(
        chunk_id="chunk-1",
        question=question,
        choices=choices,
        answer="",
        answer_key_source="manual",
        rationale="",
        citation_page=1,
        source_excerpt=source_excerpt,
    )


@pytest.mark.parametrize(
    ("choices", "expected"),
    [
        (["1 せっきょう", "2 ぜっきょう", "３ ぜっきゅう", "4　せっきゅう"], True),
        (["せっきょう", "ぜっきょう", "ぜっきゅう", "せっきゅう"], True),
        (["1　コーヒー", "2 ケーキ", "3 ラーメン", "4 スープ"], True),
        (["1 適応", "2 合致"], False),
        (["A", "B"], False),
        ([], False),
        ([""], False),
        (["1 せっきょう", ""], False),
        (["1", "2"], False),
        (["1 "], False),
        (["1 食べる", "2 飲む"], False),
    ],
)
def test_is_reading_question(choices: list[str], expected: bool) -> None:
    assert is_reading_question(choices) is expected


def test_fast_first_prompt_reading_candidate_shape_and_ending() -> None:
    candidate = _candidate(
        question="余暇の楽しみ方はいろいろある。",
        choices=["1 ようか", "2 よか", "3 よが", "4 ようが"],
        source_excerpt="1 余暇の楽しみ方はいろいろある。",
    )
    prompt = fast_first_prompt(candidate)

    assert (
        "Return only compact JSON with keys target, reading, answer, rationale, confidence."
        in prompt
    )
    assert (
        "First find the target word in the question (the word whose reading is asked). "
        "Write its correct reading in hiragana in reading. "
        "Then set answer to the visible choice whose text matches that reading, "
        "exactly as shown. "
        "Rationale must be concise and user-facing."
        in prompt
    )
    assert "Question: 余暇の楽しみ方はいろいろある。" in prompt
    assert "Choices:\n1 ようか\n2 よか\n3 よが\n4 ようが" in prompt
    assert "Source excerpt:\n1 余暇の楽しみ方はいろいろある。" in prompt
    assert "Pick the best answer from the choices." not in prompt
    assert prompt.endswith(RATIONALE_LANGUAGE_INSTRUCTION)
    assert prompt.splitlines()[-1] == RATIONALE_LANGUAGE_INSTRUCTION


def test_fast_first_prompt_non_reading_candidate_shape_and_ending() -> None:
    candidate = _candidate(
        question="この計画には無理がある。",
        choices=["1 適応", "2 合致", "3 妥当", "4 適切"],
        source_excerpt="この計画には無理がある。",
    )
    prompt = fast_first_prompt(candidate)

    assert (
        "Return only compact JSON with keys answer, rationale, confidence."
        in prompt
    )
    assert (
        "Answer must be one of the visible choices, exactly as shown, or its leading number. "
        "Rationale must be concise and user-facing; do not include hidden reasoning."
        in prompt
    )
    assert "Question: この計画には無理がある。" in prompt
    assert "Choices:\n1 適応\n2 合致\n3 妥当\n4 適切" in prompt
    assert "Source excerpt:\nこの計画には無理がある。" in prompt
    assert "Pick the best answer from the choices." in prompt
    assert "keys target, reading" not in prompt
    assert prompt.endswith(RATIONALE_LANGUAGE_INSTRUCTION)
    assert prompt.splitlines()[-1] == RATIONALE_LANGUAGE_INSTRUCTION


def test_fast_first_retry_prompt_reading_candidate_shape_and_ending() -> None:
    long_question = "問 " + ("長い問題文" * 200)
    candidate = _candidate(
        question=long_question,
        choices=["1 せっきょう", "2 ぜっきょう", "３ ぜっきゅう", "4　せっきゅう"],
        source_excerpt="Unique source excerpt that must not appear in retry prompt",
    )
    prompt = fast_first_retry_prompt(candidate)

    assert (
        "Return one JSON object only with target, reading, answer, rationale, and confidence."
        in prompt
    )
    assert "Do not write Markdown, analysis, or prose." in prompt
    assert "First find the target word in the question" in prompt
    assert f"Question: {long_question[:800]}\n" in prompt
    assert long_question[:801] not in prompt
    assert "Source excerpt" not in prompt
    assert "Unique source excerpt" not in prompt
    assert prompt.endswith(RATIONALE_LANGUAGE_INSTRUCTION)
    assert prompt.splitlines()[-1] == RATIONALE_LANGUAGE_INSTRUCTION


def test_fast_first_retry_prompt_non_reading_candidate_shape_and_ending() -> None:
    long_question = "問 " + ("長い問題文" * 200)
    candidate = _candidate(
        question=long_question,
        choices=["1 適応", "2 合致", "3 妥当", "4 適切"],
        source_excerpt="Unique source excerpt that must not appear in retry prompt",
    )
    prompt = fast_first_retry_prompt(candidate)

    assert (
        "Return one JSON object only with answer, rationale, and confidence."
        in prompt
    )
    assert "Do not write Markdown, analysis, or prose." in prompt
    assert "Answer must be one of the four visible choices." in prompt
    assert "Choose the best visible answer." in prompt
    assert "target, reading" not in prompt
    assert f"Question: {long_question[:800]}\n" in prompt
    assert long_question[:801] not in prompt
    assert "Source excerpt" not in prompt
    assert "Unique source excerpt" not in prompt
    assert prompt.endswith(RATIONALE_LANGUAGE_INSTRUCTION)
    assert prompt.splitlines()[-1] == RATIONALE_LANGUAGE_INSTRUCTION


def test_reasoning_prompts_end_with_rationale_language_instruction() -> None:
    system_prompt = _reasoning_system_prompt()
    assert system_prompt.endswith(RATIONALE_LANGUAGE_INSTRUCTION)
    assert system_prompt.endswith(f". {RATIONALE_LANGUAGE_INSTRUCTION}")

    user_prompt = _reasoning_user_prompt("Source chunk text 123", limit=3)
    assert user_prompt.endswith(RATIONALE_LANGUAGE_INSTRUCTION)
    assert user_prompt.splitlines()[-1] == RATIONALE_LANGUAGE_INSTRUCTION
    assert "\nSource chunk text 123\n" in user_prompt

    accepted_candidate = _candidate(
        question="Accepted question stem",
        choices=["1 A", "2 B"],
        source_excerpt="Accepted source",
    )
    supplemental_empty = _supplemental_reasoning_user_prompt(
        "Supplemental source text",
        limit=2,
        accepted=[],
    )
    assert supplemental_empty.endswith(RATIONALE_LANGUAGE_INSTRUCTION)
    assert supplemental_empty.splitlines()[-1] == RATIONALE_LANGUAGE_INSTRUCTION
    assert (
        "No item from the prior response passed strict validation."
        in supplemental_empty
    )

    supplemental_with_accepted = _supplemental_reasoning_user_prompt(
        "Supplemental source text",
        limit=2,
        accepted=[accepted_candidate],
    )
    assert supplemental_with_accepted.endswith(RATIONALE_LANGUAGE_INSTRUCTION)
    assert supplemental_with_accepted.splitlines()[-1] == RATIONALE_LANGUAGE_INSTRUCTION
    assert (
        "Do not repeat these already accepted items:"
        in supplemental_with_accepted
    )


def test_parsing_ignores_extra_target_and_reading_keys() -> None:
    raw_json = (
        '{"target": "余暇", "reading": "よか", "answer": "2", '
        '"rationale": "解說內容", "confidence": "high", "extra_field": 123}'
    )
    payload = json_object(raw_json)
    assert payload["target"] == "余暇"
    assert payload["reading"] == "よか"

    choices = ["1 ようか", "2 よか", "3 よが", "4 ようが"]
    answer = answer_from_payload(payload["answer"], choices)
    assert answer == "2 よか"

    confidence = confidence_from_payload(payload["confidence"])
    assert confidence == 0.8
