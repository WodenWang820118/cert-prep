from __future__ import annotations

from collections.abc import Sequence
from time import perf_counter
from typing import Any

import ollama

from cert_prep_backend.domains.mock_exams.models import SourceChunk
from cert_prep_backend.domains.mock_exams.provider import (
    EXAM_ITEMS_SCHEMA,
    _extract_model_names,
)

from bakeoff.data import group_expectation
from bakeoff.scoring import (
    citation_validity,
    group_detection,
    manual_review_burden,
    score_model_content,
    unavailable_model_result,
)


def run_bakeoff(
    *,
    models: Sequence[str],
    chunks: Sequence[SourceChunk],
    host: str,
    timeout_seconds: float,
    limit: int,
) -> list[dict[str, object]]:
    """Run the configured Ollama models and return scored bakeoff results."""
    client = ollama.Client(host=host, timeout=timeout_seconds)
    expectation = group_expectation(chunks)
    try:
        available_models = _extract_model_names(client.list())
    except Exception as exc:
        return [
            unavailable_model_result(model, "ollama_unavailable", exc, expectation)
            for model in models
        ]

    results: list[dict[str, object]] = []
    for model in models:
        if model not in available_models:
            results.append(
                {
                    "model": model,
                    "provider": "ollama",
                    "status": "missing_model",
                    "json_valid": None,
                    "json_recovered": None,
                    "citation_validity": citation_validity([], 0),
                    "group_detection": group_detection([], expectation),
                    "latency_ms": None,
                    "manual_review_burden": manual_review_burden(
                        [],
                        0,
                        expectation,
                    ),
                    "accepted_items": [],
                }
            )
            continue

        started = perf_counter()
        try:
            response = client.chat(
                model=model,
                messages=bakeoff_messages(chunks, limit),
                format=EXAM_ITEMS_SCHEMA,
                options={"temperature": 0, "num_ctx": 8192, "num_predict": 4096},
                think=False,
            )
            latency_ms = int((perf_counter() - started) * 1000)
            results.append(
                score_model_content(
                    model=model,
                    content=response_content(response),
                    chunks=chunks,
                    latency_ms=latency_ms,
                    limit=limit,
                )
            )
        except Exception as exc:
            results.append(unavailable_model_result(model, "request_failed", exc, expectation))
    return results


def bakeoff_messages(
    chunks: Sequence[SourceChunk],
    limit: int,
) -> list[dict[str, str]]:
    source = "\n\n".join(
        f"[[chunk_id:{chunk.id} page:{chunk.page_number}]]\n{chunk.raw_or_text()}"
        for chunk in chunks
    )
    return [
        {
            "role": "system",
            "content": (
                "You convert fixed parsed JLPT source chunks into draft exam items. "
                "Return only the requested JSON object. Do not include chain-of-thought, "
                "hidden reasoning, analysis, markdown, or prose outside JSON."
            ),
        },
        {
            "role": "user",
            "content": (
                f"Create up to {limit} multiple-choice exam items. Preserve chunk_id, "
                "set citation_page from the source header, copy source_excerpt exactly "
                "from the source text, and include group_key/group_prompt for passage "
                "or conversation questions. Use item_kind grouped_question for grouped "
                "items and vocabulary_single for standalone vocabulary items.\n\n"
                f"{source}"
            ),
        },
    ]


def response_content(response: Any) -> object:
    message = getattr(response, "message", None)
    if isinstance(message, dict):
        return message.get("content")
    if message is not None:
        return getattr(message, "content", None)
    if isinstance(response, dict):
        raw_message = response.get("message")
        if isinstance(raw_message, dict):
            return raw_message.get("content")
    return None
