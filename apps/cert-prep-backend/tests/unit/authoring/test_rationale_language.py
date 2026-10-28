"""Draft prompts ask for a Traditional Chinese rationale and keep the JSON shape."""

from cert_prep_backend.authoring.domain.models import DraftSuggestion
from cert_prep_backend.authoring.infrastructure.ollama_drafts import (
    _reasoning_system_prompt,
    _reasoning_user_prompt,
    _supplemental_reasoning_user_prompt,
)
from cert_prep_backend.authoring.infrastructure.response_parsing import (
    RATIONALE_LANGUAGE_INSTRUCTION,
    fast_first_prompt,
    fast_first_retry_prompt,
)


def _candidate() -> DraftSuggestion:
    return DraftSuggestion(
        chunk_id="chunk-1",
        question="余暇の楽しみ方は？",
        choices=["ようか", "よか"],
        answer="よか",
        answer_key_source="ai_inferred",
        rationale="",
        citation_page=1,
        source_excerpt="余暇",
    )


def test_every_rationale_prompt_requires_traditional_chinese() -> None:
    candidate = _candidate()
    prompts = {
        "system": _reasoning_system_prompt(),
        "user": _reasoning_user_prompt("読む", limit=2),
        "supplemental-empty": _supplemental_reasoning_user_prompt("読む", limit=1, accepted=[]),
        "supplemental-accepted": _supplemental_reasoning_user_prompt(
            "読む", limit=1, accepted=[candidate]
        ),
        "fast-first": fast_first_prompt(candidate),
        "fast-first-retry": fast_first_retry_prompt(candidate),
    }

    assert RATIONALE_LANGUAGE_INSTRUCTION == (
        "解說（rationale）必須用繁體中文（台灣用語）撰寫，不可用日文或英文；日文原文只放在「」裡引用。"
    )
    for name, prompt in prompts.items():
        assert RATIONALE_LANGUAGE_INSTRUCTION in prompt, name
    assert "items" in prompts["system"]
    assert "answer, rationale, confidence" in prompts["fast-first"]
    assert "answer, rationale, and confidence" in prompts["fast-first-retry"]
