from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
import json
from pathlib import Path

from cert_prep_backend.domains.exam_content import parse_jlpt_question_blocks
from cert_prep_backend.domains.mock_exams.models import SourceChunk


@dataclass(frozen=True, slots=True)
class GroupExpectation:
    """Grouped-question expectations parsed from the bakeoff source chunks."""

    expected_group_keys: tuple[str, ...]
    expected_group_items: int
    grouped_pages: frozenset[int]


def fixed_bakeoff_chunks() -> list[SourceChunk]:
    """Return the deterministic built-in chunks used when no input file is supplied."""
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
    """Load bakeoff source chunks from JSON, or use the built-in fixture."""
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


def group_expectation(chunks: Sequence[SourceChunk]) -> GroupExpectation:
    """Compute expected grouped-question coverage from source chunks."""
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
