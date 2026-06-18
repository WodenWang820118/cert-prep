from __future__ import annotations

import argparse
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
import json
import os
from pathlib import Path
from time import perf_counter
from typing import Any
import re
import sys


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

import ollama

from exam_prep_backend.domains.exam_content import (
    QuestionItemKind,
    parse_jlpt_question_blocks,
)
from exam_prep_backend.domains.mock_exams.models import (
    AnswerKeySource,
    DraftSuggestion,
    SourceChunk,
)
from exam_prep_backend.domains.mock_exams.provider import (
    EXAM_ITEMS_SCHEMA,
    _draft_suggestion_from_item,
    _extract_model_names,
)


REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_OUTPUT_DIR = REPO_ROOT / "apps" / "exam-prep-backend" / ".benchmarks"
DEFAULT_MODELS = ("qwen3:14b", "deepseek-r1:14b", "gemma4:12b")
DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434"
DEFAULT_LIMIT = 4


@dataclass(frozen=True, slots=True)
class GroupExpectation:
    expected_group_keys: tuple[str, ...]
    expected_group_items: int
    grouped_pages: frozenset[int]


def fixed_bakeoff_chunks() -> list[SourceChunk]:
    return [
        SourceChunk(
            id="fixed-page-2-vocab",
            page_number=2,
            chunk_index=0,
            text=(
                "Mondai 1 Choose the correct reading. "
                "1 seikai 2 gotou 3 betsu 4 hoka"
            ),
            source_excerpt="Mondai 1 Choose the correct reading.",
        ),
        SourceChunk(
            id="fixed-page-3-grouped",
            page_number=3,
            chunk_index=0,
            text=(
                "Mondai 2 Read the conversation and choose the best answer. "
                "Taro calls Mika because the train is late. Mika says she will "
                "bring the printed ticket to the station. "
                "1 Why does Taro call Mika? "
                "1 To ask her to bring the ticket 2 To cancel the trip "
                "3 To sell a bicycle 4 To find a hotel "
                "2 What will Mika bring? "
                "1 A map 2 A printed ticket 3 A lunch box 4 A book"
            ),
            source_excerpt="Taro calls Mika because the train is late.",
        ),
    ]


def load_chunks(path: Path | None) -> list[SourceChunk]:
    if path is None:
        return fixed_bakeoff_chunks()

    payload = json.loads(path.read_text(encoding="utf-8"))
    raw_chunks = payload.get("chunks") if isinstance(payload, dict) else payload
    if not isinstance(raw_chunks, list):
        raise ValueError("Bakeoff input must be a JSON array or an object with a chunks array.")

    chunks: list[SourceChunk] = []
    for index, raw_chunk in enumerate(raw_chunks):
        if not isinstance(raw_chunk, dict):
            raise ValueError(f"Chunk {index} must be an object.")
        chunks.append(
            SourceChunk(
                id=_required_text(raw_chunk, "id"),
                page_number=_required_int(raw_chunk, "page_number"),
                chunk_index=_optional_int(raw_chunk.get("chunk_index")) or index,
                text=_required_text(raw_chunk, "text"),
                source_excerpt=_text(raw_chunk.get("source_excerpt")),
                raw_text=_text(raw_chunk.get("raw_text")),
            )
        )
    return chunks


def score_model_content(
    *,
    model: str,
    content: object,
    chunks: Sequence[SourceChunk],
    latency_ms: int | None,
    limit: int = DEFAULT_LIMIT,
) -> dict[str, object]:
    decoded = decode_model_payload(content)
    expectation = group_expectation(chunks)
    base: dict[str, object] = {
        "model": model,
        "provider": "ollama",
        "latency_ms": latency_ms,
        "json_valid": decoded["json_valid"],
        "json_recovered": decoded["json_recovered"],
    }
    payload = decoded["payload"]
    if not isinstance(payload, dict):
        return base | {
            "status": "invalid_json",
            "json_error": decoded["json_error"],
            "citation_validity": citation_validity([], 0),
            "group_detection": group_detection([], expectation),
            "manual_review_burden": manual_review_burden([], 0, expectation),
            "accepted_items": [],
        }

    raw_items = payload.get("items")
    if not isinstance(raw_items, list):
        return base | {
            "status": "invalid_items",
            "json_error": None,
            "citation_validity": citation_validity([], 1),
            "group_detection": group_detection([], expectation),
            "manual_review_burden": manual_review_burden([], 1, expectation),
            "accepted_items": [],
        }

    chunks_by_page = {chunk.page_number: chunk for chunk in chunks}
    chunks_by_id = {chunk.id: chunk for chunk in chunks}
    accepted: list[DraftSuggestion] = []
    for raw_item in raw_items:
        suggestion = _draft_suggestion_from_item(raw_item, chunks_by_page, chunks_by_id)
        if suggestion is None:
            continue
        accepted.append(suggestion)
        if len(accepted) >= limit:
            break

    rejected_count = max(0, len(raw_items) - len(accepted))
    return base | {
        "status": "scored",
        "json_error": None,
        "citation_validity": citation_validity(accepted, len(raw_items)),
        "group_detection": group_detection(accepted, expectation),
        "manual_review_burden": manual_review_burden(
            accepted,
            rejected_count,
            expectation,
        ),
        "accepted_items": [sanitized_item(item) for item in accepted],
    }


def decode_model_payload(content: object) -> dict[str, object]:
    if not isinstance(content, str):
        return {
            "payload": None,
            "json_valid": False,
            "json_recovered": False,
            "json_error": "response content was not a string",
        }

    try:
        payload = json.loads(content)
        return {
            "payload": payload if isinstance(payload, dict) else None,
            "json_valid": isinstance(payload, dict),
            "json_recovered": False,
            "json_error": None if isinstance(payload, dict) else "JSON payload was not an object",
        }
    except json.JSONDecodeError as exc:
        strict_error = exc.msg

    recovered_content = extract_json_object_without_thought(content)
    if recovered_content is not None:
        try:
            payload = json.loads(recovered_content)
            return {
                "payload": payload if isinstance(payload, dict) else None,
                "json_valid": False,
                "json_recovered": isinstance(payload, dict),
                "json_error": None
                if isinstance(payload, dict)
                else "Recovered JSON payload was not an object",
            }
        except json.JSONDecodeError as exc:
            strict_error = exc.msg

    return {
        "payload": None,
        "json_valid": False,
        "json_recovered": False,
        "json_error": strict_error,
    }


def extract_json_object_without_thought(content: str) -> str | None:
    without_think = re.sub(r"(?is)<think>.*?</think>", "", content)
    start = without_think.find("{")
    end = without_think.rfind("}")
    if start < 0 or end <= start:
        return None
    return without_think[start : end + 1]


def group_expectation(chunks: Sequence[SourceChunk]) -> GroupExpectation:
    expected_keys: set[str] = set()
    grouped_pages: set[int] = set()
    expected_items = 0
    for chunk in chunks:
        for block in parse_jlpt_question_blocks(
            text=chunk.raw_or_text(),
            page_number=chunk.page_number,
            chunk_index=chunk.chunk_index,
        ):
            if block.group_key:
                expected_keys.add(block.group_key)
                grouped_pages.add(chunk.page_number)
                expected_items += 1
    return GroupExpectation(
        expected_group_keys=tuple(sorted(expected_keys)),
        expected_group_items=expected_items,
        grouped_pages=frozenset(grouped_pages),
    )


def citation_validity(
    accepted: Sequence[DraftSuggestion],
    total_items: int,
) -> dict[str, object]:
    invalid = max(0, total_items - len(accepted))
    denominator = total_items or 1
    return {
        "total_items": total_items,
        "valid_items": len(accepted),
        "invalid_items": invalid,
        "valid_ratio": round(len(accepted) / denominator, 4),
    }


def group_detection(
    accepted: Sequence[DraftSuggestion],
    expectation: GroupExpectation,
) -> dict[str, object]:
    detected_keys = sorted({item.group_key for item in accepted if item.group_key})
    detected_group_items = sum(
        1
        for item in accepted
        if item.item_kind is QuestionItemKind.GROUPED_QUESTION or item.group_key
    )
    missing_group_context = sum(
        1
        for item in accepted
        if item.citation_page in expectation.grouped_pages and not item.group_key
    )
    expected_keys = set(expectation.expected_group_keys)
    return {
        "expected_group_keys": list(expectation.expected_group_keys),
        "expected_group_items": expectation.expected_group_items,
        "detected_group_keys": detected_keys,
        "detected_group_items": detected_group_items,
        "detected_expected_groups": sorted(expected_keys.intersection(detected_keys)),
        "missing_group_context_items": missing_group_context,
    }


def manual_review_burden(
    accepted: Sequence[DraftSuggestion],
    rejected_count: int,
    expectation: GroupExpectation,
) -> dict[str, object]:
    reasons: Counter[str] = Counter()
    accepted_needing_review = 0
    for item in accepted:
        item_reasons = set()
        if item.answer_key_source is AnswerKeySource.AI_INFERRED:
            item_reasons.add("ai_inferred_answer")
        if item.confidence is None or item.confidence < 0.75:
            item_reasons.add("low_confidence")
        if item.citation_page in expectation.grouped_pages and not item.group_key:
            item_reasons.add("missing_group_context")
        if item_reasons:
            accepted_needing_review += 1
            reasons.update(item_reasons)

    if rejected_count:
        reasons["rejected_or_unusable_item"] += rejected_count

    total_items = len(accepted) + rejected_count
    requiring_review = accepted_needing_review + rejected_count
    return {
        "total_items": total_items,
        "items_requiring_review": requiring_review,
        "accepted_items_needing_review": accepted_needing_review,
        "rejected_items": rejected_count,
        "review_ratio": round(requiring_review / (total_items or 1), 4),
        "reasons": dict(sorted(reasons.items())),
    }


def sanitized_item(item: DraftSuggestion) -> dict[str, object]:
    return {
        "chunk_id": item.chunk_id,
        "citation_page": item.citation_page,
        "source_question_number": item.source_question_number,
        "item_kind": item.item_kind.value,
        "group_key": item.group_key,
        "has_group_prompt": item.group_prompt is not None,
        "answer_key_source": item.answer_key_source.value,
        "confidence": item.confidence,
    }


def run_bakeoff(
    *,
    models: Sequence[str],
    chunks: Sequence[SourceChunk],
    host: str,
    timeout_seconds: float,
    limit: int,
) -> list[dict[str, object]]:
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


def unavailable_model_result(
    model: str,
    status: str,
    exc: Exception,
    expectation: GroupExpectation,
) -> dict[str, object]:
    return {
        "model": model,
        "provider": "ollama",
        "status": status,
        "json_valid": None,
        "json_recovered": None,
        "json_error": type(exc).__name__,
        "citation_validity": citation_validity([], 0),
        "group_detection": group_detection([], expectation),
        "latency_ms": None,
        "manual_review_burden": manual_review_burden([], 0, expectation),
        "accepted_items": [],
    }


def build_report(
    *,
    models: Sequence[str],
    chunks: Sequence[SourceChunk],
    host: str,
    timeout_seconds: float,
    limit: int,
) -> dict[str, object]:
    expectation = group_expectation(chunks)
    return {
        "schema_version": 1,
        "generated_at": datetime.now(UTC).isoformat(),
        "input": {
            "chunk_count": len(chunks),
            "chunk_ids": [chunk.id for chunk in chunks],
            "expected_group_keys": list(expectation.expected_group_keys),
            "expected_group_items": expectation.expected_group_items,
            "limit": limit,
        },
        "models": run_bakeoff(
            models=models,
            chunks=chunks,
            host=host,
            timeout_seconds=timeout_seconds,
            limit=limit,
        ),
    }


def default_output_path() -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return DEFAULT_OUTPUT_DIR / f"reasoning-bakeoff-{stamp}.json"


def write_json_report(report: dict[str, object], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path)
    parser.add_argument("--output", type=Path, default=default_output_path())
    parser.add_argument("--model", action="append", dest="models")
    parser.add_argument(
        "--host",
        default=os.environ.get("EXAM_PREP_OLLAMA_HOST", DEFAULT_OLLAMA_HOST),
    )
    parser.add_argument("--timeout-seconds", type=float, default=180.0)
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    models = tuple(args.models or DEFAULT_MODELS)
    chunks = load_chunks(args.input)
    report = build_report(
        models=models,
        chunks=chunks,
        host=args.host,
        timeout_seconds=args.timeout_seconds,
        limit=args.limit,
    )
    write_json_report(report, args.output)
    print(json.dumps({"output": str(args.output), "models": list(models)}, indent=2))


def _required_text(raw: dict[str, object], key: str) -> str:
    value = raw.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"Chunk field {key} must be a non-empty string.")
    return value


def _required_int(raw: dict[str, object], key: str) -> int:
    value = raw.get(key)
    parsed = _optional_int(value)
    if parsed is None:
        raise ValueError(f"Chunk field {key} must be an integer.")
    return parsed


def _optional_int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def _text(value: object) -> str:
    return value if isinstance(value, str) else ""


if __name__ == "__main__":
    main()
