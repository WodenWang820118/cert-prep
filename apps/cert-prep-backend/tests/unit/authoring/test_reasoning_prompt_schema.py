"""Reasoning prompts show the exact canonical parser keys in a JSON example."""

import json

import pytest

from cert_prep_backend.authoring.infrastructure.ollama_drafts import (
    _reasoning_system_prompt,
    _reasoning_user_prompt,
    _supplemental_reasoning_user_prompt,
)
from cert_prep_backend.authoring.infrastructure.response_parsing import (
    RATIONALE_LANGUAGE_INSTRUCTION,
)


@pytest.mark.parametrize(
    "prompt",
    [
        _reasoning_system_prompt(),
        _reasoning_user_prompt("Synthetic source.", limit=1),
        _supplemental_reasoning_user_prompt("Synthetic source.", limit=1, accepted=[]),
    ],
    ids=["system", "user", "supplemental"],
)
def test_reasoning_prompts_include_exact_parser_keys_and_a_json_example(prompt: str) -> None:
    start = prompt.index('{"items":')
    example, _ = json.JSONDecoder().raw_decode(prompt[start:])
    item = example["items"][0]

    assert set(item) == {
        "chunk_id",
        "citation_page",
        "question",
        "choices",
        "answer",
        "answer_key_source",
        "rationale",
        "source_excerpt",
        "confidence",
    }
    assert isinstance(item["citation_page"], int)
    assert isinstance(item["confidence"], int | float)
    assert item["answer"] in item["choices"]
    assert "question_stem" not in item
    assert "stem" not in item
    assert prompt.endswith(RATIONALE_LANGUAGE_INSTRUCTION)
