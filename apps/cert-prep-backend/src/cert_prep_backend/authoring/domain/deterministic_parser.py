from __future__ import annotations

from collections.abc import Sequence
from dataclasses import replace
import re

from cert_prep_backend.source_library.domain.exam_content import (
    ParsedQuestionBlock,
    parse_jlpt_question_blocks,
    without_page_footer,
)
from cert_prep_backend.authoring.domain.models import (
    AnswerKeySource,
    DraftSuggestion,
    SourceChunk,
)


MAX_PROMPT_SOURCE_CHARS = 3_000
MAX_PROMPT_CHUNKS = 6


def source_text_for_prompt(chunks: Sequence[SourceChunk], limit: int) -> str:
    """Build bounded page-delimited source text for the reasoning provider prompt."""

    source, _ = source_text_and_chunks_for_prompt(chunks, limit)
    return source


def source_text_and_chunks_for_prompt(
    chunks: Sequence[SourceChunk],
    limit: int,
) -> tuple[str, tuple[SourceChunk, ...]]:
    """Build prompt text and return only the chunks actually represented in it."""

    sections: list[str] = []
    selected_chunks: list[SourceChunk] = []
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
        selected_chunks.append(chunk)
        used_chars += len(section)
    return "\n\n".join(sections), tuple(selected_chunks)


def is_exam_source_chunk(chunk: SourceChunk) -> bool:
    """Return whether a chunk looks like exam content rather than notice text."""

    text = chunk.raw_or_text().lower()
    if _is_notice_chunk(chunk):
        return False
    exam_markers = (
        "\u554f\u984c",
        "\u9078\u3073\u306a\u3055\u3044",
        "\u6700\u3082\u3088\u3044",
        "mondai",
        "choose",
    )
    return any(marker in text for marker in exam_markers) or bool(
        parse_jlpt_question_blocks(
            text=chunk.raw_or_text(),
            page_number=chunk.page_number,
            chunk_index=chunk.chunk_index,
        )
    )


def _is_notice_chunk(chunk: SourceChunk) -> bool:
    text = chunk.raw_or_text().lower()
    rejected_markers = (
        "this test paper has multiple versions",
        "the questions are the same, but the fonts and layouts differ",
        "official wechat",
        "\u8907\u6570\u306e\u30d0\u30fc\u30b8\u30e7\u30f3",
    )
    return any(marker in text for marker in rejected_markers)


_NUMBERED_LINE = re.compile(r"(?m)^[ \t]*(?P<number>\d{1,3})(?!\d)[.\uFF0E]?[ \t]*")
_SECTION_LINE = re.compile(
    r"(?im)^[ \t]*(?:(?:問題[ \t]*|mondai[ \t]+)\d{1,3}(?=[\s、，,]|$)|言語知識[ \t]*[（(])"
)


def _page_question_text(chunk: SourceChunk) -> str:
    return without_page_footer(chunk.raw_or_text(), chunk.page_number).rstrip()


def _continued_question(left: SourceChunk, right: SourceChunk) -> ParsedQuestionBlock | None:
    if (
        not left.document_id
        or left.document_id != right.document_id
        or right.page_number != left.page_number + 1
        or right.chunk_index != left.chunk_index + 1
        or _is_notice_chunk(left)
        or _is_notice_chunk(right)
    ):
        return None
    left_text = _page_question_text(left)
    left_markers = list(_NUMBERED_LINE.finditer(left_text))
    for count in (3, 2, 1):
        if len(left_markers) <= count:
            continue
        if [int(m.group("number")) for m in left_markers[-count:]] != list(range(1, count + 1)):
            continue
        question = left_markers[-count - 1]
        # A 1..4 marker has ambiguous question/option identity across a boundary.
        if int(question.group("number")) <= 4:
            return None
        tail = left_text[question.start() :]
        if _SECTION_LINE.search(tail):
            return None
        prefix = _page_question_text(right).lstrip()
        section = _SECTION_LINE.search(prefix)
        if section:
            prefix = prefix[: section.start()].rstrip()
        right_markers = list(_NUMBERED_LINE.finditer(prefix))
        if not right_markers or right_markers[0].start() != 0:
            return None
        expected = count + 1
        for marker in right_markers:
            if expected == 5:
                # A later numeric line may be a quantity or decimal wrapped
                # inside option 4. Only an unambiguous new question ends it.
                if int(marker.group("number")) > 4 and re.match(
                    r"[ \t]*\d{1,3}(?:[.\uFF0E](?!\d)|[ \t]+|\r?$)",
                    prefix[marker.start() :].split("\n", 1)[0],
                ):
                    prefix = prefix[: marker.start()].rstrip()
                    break
                continue
            if int(marker.group("number")) != expected:
                return None
            expected += 1
        if expected != 5:
            return None
        blocks = parse_jlpt_question_blocks(
            text=tail + "\n" + prefix,
            page_number=left.page_number,
            chunk_index=left.chunk_index,
        )
        if len(blocks) == 1 and blocks[0].source_question_number == question.group("number"):
            return blocks[0]
        return None
    return None


def extract_jlpt_question_blocks(
    chunks: Sequence[SourceChunk], limit: int
) -> list[DraftSuggestion]:
    """Extract visible JLPT question blocks without using AI reasoning."""

    suggestions: list[DraftSuggestion] = []
    for chunk_index, chunk in enumerate(chunks):
        if len(suggestions) >= limit:
            break
        blocks = (
            parse_jlpt_question_blocks(
                text=chunk.raw_or_text(),
                page_number=chunk.page_number,
                chunk_index=chunk.chunk_index,
            )
            if is_exam_source_chunk(chunk)
            else []
        )
        if chunk_index + 1 < len(chunks):
            continued = _continued_question(chunk, chunks[chunk_index + 1])
            if continued is not None:
                blocks.append(
                    replace(
                        continued,
                        source_order=chunk.page_number * 10_000
                        + chunk.chunk_index * 1_000
                        + len(blocks)
                        + 1,
                    )
                )
        for block in blocks:
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
