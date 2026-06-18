from __future__ import annotations

from collections.abc import Sequence

from exam_prep_backend.domains.exam_content import parse_jlpt_question_blocks
from exam_prep_backend.domains.mock_exams.models import (
    AnswerKeySource,
    DraftStatus,
    DraftSuggestion,
    SourceChunk,
)


MAX_PROMPT_SOURCE_CHARS = 3_000
MAX_PROMPT_CHUNKS = 6


def source_text_for_prompt(chunks: Sequence[SourceChunk], limit: int) -> str:
    """Build bounded page-delimited source text for the reasoning provider prompt."""

    sections: list[str] = []
    used_chars = 0
    max_chunks = max(1, min(MAX_PROMPT_CHUNKS, max(1, limit)))
    candidates = [chunk for chunk in chunks if is_exam_source_chunk(chunk)]
    if not candidates:
        candidates = list(chunks)

    for chunk in candidates:
        if len(sections) >= max_chunks:
            break
        text = chunk.raw_or_text().strip()
        if not text:
            continue
        section = f"[[chunk_id:{chunk.id} page:{chunk.page_number}]]\n{text}"
        remaining = MAX_PROMPT_SOURCE_CHARS - used_chars
        if remaining <= 0:
            break
        if len(section) > remaining:
            if not sections:
                section = section[:remaining]
            else:
                break
        sections.append(section)
        used_chars += len(section)
    return "\n\n".join(sections)


def is_exam_source_chunk(chunk: SourceChunk) -> bool:
    """Return whether a chunk looks like exam content rather than notice text."""

    text = chunk.raw_or_text().lower()
    rejected_markers = (
        "this test paper has multiple versions",
        "the questions are the same, but the fonts and layouts differ",
        "official wechat",
        "\u8907\u6570\u306e\u30d0\u30fc\u30b8\u30e7\u30f3",
    )
    if any(marker in text for marker in rejected_markers):
        return False
    exam_markers = (
        "\u554f\u984c",
        "\u9078\u3073\u306a\u3055\u3044",
        "\u6700\u3082\u3088\u3044",
        "mondai",
        "choose",
    )
    return any(marker in text for marker in exam_markers)


def extract_jlpt_question_blocks(
    chunks: Sequence[SourceChunk], limit: int
) -> list[DraftSuggestion]:
    """Extract visible JLPT question blocks without using AI reasoning."""

    suggestions: list[DraftSuggestion] = []
    for chunk in chunks:
        if len(suggestions) >= limit:
            break
        if not is_exam_source_chunk(chunk):
            continue
        for block in parse_jlpt_question_blocks(
            text=chunk.raw_or_text(),
            page_number=chunk.page_number,
            chunk_index=chunk.chunk_index,
        ):
            suggestions.append(
                DraftSuggestion(
                    chunk_id=chunk.id,
                    question=block.stem,
                    choices=block.choices,
                    answer="",
                    answer_key_source=AnswerKeySource.MANUAL,
                    rationale="",
                    citation_page=chunk.page_number,
                    source_excerpt=block.source_excerpt,
                    status=DraftStatus.DRAFT,
                    confidence=1.0,
                    source_order=block.source_order,
                    source_question_number=block.source_question_number,
                    item_kind=block.item_kind,
                    group_key=block.group_key,
                    group_prompt=block.group_prompt,
                )
            )
            if len(suggestions) >= limit:
                break
    return suggestions
