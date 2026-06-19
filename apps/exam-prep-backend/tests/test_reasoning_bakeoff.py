from __future__ import annotations

import json
from pathlib import Path
import sys


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from bakeoff.data import (
    fixed_bakeoff_chunks,
    group_expectation,
)
from bakeoff.scoring import (
    decode_model_payload,
    score_model_content,
)


def test_reasoning_bakeoff_scores_valid_citations_and_group_detection() -> None:
    chunks = fixed_bakeoff_chunks()
    content = json.dumps(
        {
            "items": [
                {
                    "chunk_id": "fixed-page-2-vocab",
                    "citation_page": 2,
                    "question": "Mondai 1 Choose the correct reading.",
                    "choices": ["1 seikai", "2 gotou", "3 betsu", "4 hoka"],
                    "answer": "1",
                    "answer_key_source": "pdf",
                    "rationale": "The source lists this as choice 1.",
                    "source_excerpt": "Mondai 1 Choose the correct reading.",
                    "confidence": 0.95,
                    "source_question_number": "1",
                    "item_kind": "vocabulary_single",
                },
                {
                    "chunk_id": "fixed-page-3-grouped",
                    "citation_page": 3,
                    "question": "Why does Taro call Mika?",
                    "choices": [
                        "1 To ask her to bring the ticket",
                        "2 To cancel the trip",
                        "3 To sell a bicycle",
                        "4 To find a hotel",
                    ],
                    "answer": "1",
                    "answer_key_source": "ai_inferred",
                    "rationale": "The cited conversation says the train is late.",
                    "source_excerpt": "Taro calls Mika because the train is late.",
                    "confidence": 0.7,
                    "source_question_number": "1",
                    "item_kind": "grouped_question",
                    "group_key": "page-3:group-2",
                    "group_prompt": "Mondai 2 Read the conversation and choose",
                },
            ]
        }
    )

    result = score_model_content(
        model="qwen3:14b",
        content=content,
        chunks=chunks,
        latency_ms=123,
    )

    assert result["status"] == "scored"
    assert result["json_valid"] is True
    assert result["citation_validity"] == {
        "total_items": 2,
        "valid_items": 2,
        "invalid_items": 0,
        "valid_ratio": 1.0,
    }
    assert result["group_detection"] == {
        "expected_group_keys": ["page-3:group-2"],
        "expected_group_items": 2,
        "detected_group_keys": ["page-3:group-2"],
        "detected_group_items": 1,
        "detected_expected_groups": ["page-3:group-2"],
        "missing_group_context_items": 0,
    }
    assert result["manual_review_burden"] == {
        "total_items": 2,
        "items_requiring_review": 1,
        "accepted_items_needing_review": 1,
        "rejected_items": 0,
        "review_ratio": 0.5,
        "reasons": {"ai_inferred_answer": 1, "low_confidence": 1},
    }


def test_reasoning_bakeoff_rejects_bad_citation_evidence() -> None:
    result = score_model_content(
        model="gemma4:12b",
        content=json.dumps(
            {
                "items": [
                    {
                        "chunk_id": "fixed-page-2-vocab",
                        "citation_page": 99,
                        "question": "Mondai 1 Choose the correct reading.",
                        "choices": ["1 seikai", "2 gotou", "3 betsu", "4 hoka"],
                        "answer": "1",
                        "answer_key_source": "ai_inferred",
                        "rationale": "Looks plausible.",
                        "source_excerpt": "not copied from the source",
                        "confidence": 0.9,
                    }
                ]
            }
        ),
        chunks=fixed_bakeoff_chunks(),
        latency_ms=44,
    )

    assert result["citation_validity"]["valid_items"] == 0
    assert result["citation_validity"]["invalid_items"] == 1
    assert result["manual_review_burden"]["reasons"] == {
        "rejected_or_unusable_item": 1
    }


def test_reasoning_bakeoff_recovers_json_without_saving_thought_text() -> None:
    thought_wrapped = '<think>private chain-of-thought</think>{"items": []}'

    decoded = decode_model_payload(thought_wrapped)
    result = score_model_content(
        model="deepseek-r1:14b",
        content=thought_wrapped,
        chunks=fixed_bakeoff_chunks(),
        latency_ms=10,
    )

    assert decoded["json_valid"] is False
    assert decoded["json_recovered"] is True
    assert result["json_valid"] is False
    assert result["json_recovered"] is True
    assert "private chain-of-thought" not in json.dumps(result)


def test_reasoning_bakeoff_fixture_has_group_expectation() -> None:
    expectation = group_expectation(fixed_bakeoff_chunks())

    assert expectation.expected_group_keys == ("page-3:group-2",)
    assert expectation.expected_group_items == 2
    assert expectation.grouped_pages == frozenset({3})
