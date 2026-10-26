from __future__ import annotations

from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum
import json
import re
from typing import TypeAlias


class ContentProfile(StrEnum):
    UNKNOWN = "unknown"
    JLPT_VOCABULARY = "jlpt_vocabulary"
    JLPT_GROUPED = "jlpt_grouped"
    MIXED = "mixed"


class QuestionItemKind(StrEnum):
    UNKNOWN = "unknown"
    VOCABULARY_SINGLE = "vocabulary_single"
    GROUPED_QUESTION = "grouped_question"


ContentProfileValue: TypeAlias = ContentProfile | str
QuestionItemKindValue: TypeAlias = QuestionItemKind | str


@dataclass(frozen=True, slots=True)
class TextClassification:
    content_profile: ContentProfile
    detail: str


@dataclass(frozen=True, slots=True)
class LineMetadata:
    line_start: int | None
    line_end: int | None
    line_count: int


@dataclass(frozen=True, slots=True)
class ParsedQuestionBlock:
    source_order: int
    source_question_number: str
    item_kind: QuestionItemKind
    group_key: str | None
    group_prompt: str | None
    stem: str
    choices: tuple[str, ...]
    source_excerpt: str


QUESTION_BLOCK_PATTERN = re.compile(
    r"(?<!\u554f\u984c)(?P<number>\d{1,3})\s+"
    r"(?P<stem>.+?)\s*"
    r"1\s*(?P<c1>.+?)\s*"
    r"2\s*(?P<c2>.+?)\s*"
    r"3\s*(?P<c3>.+?)\s*"
    r"4\s*(?P<c4>.+?)"
    r"(?=\s+\d{1,3}\s+|$)",
    re.DOTALL,
)
GROUP_PROMPT_PATTERN = re.compile(
    r"(?P<prompt>(?:\u554f\u984c|mondai)\s*(?P<number>\d{1,3}).{0,400}?"
    r"(?:\u9078\u3073\u306a\u3055\u3044|choose)[^0-9]{0,80})",
    re.IGNORECASE | re.DOTALL,
)


def classify_exam_text(text: str) -> TextClassification:
    raw_text = text or ""
    group_prompts = _group_prompts(raw_text)
    question_blocks = [
        match
        for match in QUESTION_BLOCK_PATTERN.finditer(_question_block_source_text(raw_text))
        if not _looks_like_question_group_instruction(_clean_exam_text(match.group("stem")))
    ]

    grouped_prompts = [
        prompt for _, prompt in group_prompts if _prompt_is_grouped_question_set(prompt)
    ]
    if question_blocks and len(grouped_prompts) > 1:
        profile = ContentProfile.MIXED
    elif question_blocks and grouped_prompts:
        profile = ContentProfile.JLPT_GROUPED
    elif question_blocks:
        profile = ContentProfile.JLPT_VOCABULARY
    elif grouped_prompts:
        profile = ContentProfile.JLPT_GROUPED
    else:
        profile = ContentProfile.UNKNOWN

    detail = json.dumps(
        {
            "profile": profile.value,
            "question_block_count": len(question_blocks),
            "group_prompt_count": len(group_prompts),
            "grouped_prompt_count": len(grouped_prompts),
        },
        sort_keys=True,
    )
    return TextClassification(content_profile=profile, detail=detail)


def line_metadata(raw_text: str) -> LineMetadata:
    lines = [line for line in (raw_text or "").splitlines() if line.strip()]
    if not lines and raw_text.strip():
        lines = [raw_text]
    count = len(lines)
    return LineMetadata(
        line_start=1 if count else None,
        line_end=count if count else None,
        line_count=count,
    )


def aggregate_content_profile(profiles: Sequence[ContentProfileValue]) -> ContentProfile:
    values = [content_profile_from_value(profile) for profile in profiles]
    meaningful = [profile for profile in values if profile is not ContentProfile.UNKNOWN]
    if not meaningful:
        return ContentProfile.UNKNOWN
    unique = set(meaningful)
    if len(unique) == 1:
        return meaningful[0]
    return ContentProfile.MIXED


def classification_summary(profiles: Sequence[ContentProfileValue]) -> str:
    normalized = [content_profile_from_value(profile).value for profile in profiles]
    return json.dumps(
        {
            "profile": aggregate_content_profile(profiles).value,
            "chunks": len(normalized),
            "counts": dict(sorted(Counter(normalized).items())),
        },
        sort_keys=True,
    )


def parse_jlpt_question_blocks(
    *,
    text: str,
    page_number: int,
    chunk_index: int = 0,
) -> list[ParsedQuestionBlock]:
    source_text = _question_block_source_text(text)
    group_prompt = _first_group_prompt(text)
    is_grouped_set = group_prompt is not None and _prompt_is_grouped_question_set(
        group_prompt[1]
    )
    item_kind = (
        QuestionItemKind.GROUPED_QUESTION
        if is_grouped_set
        else QuestionItemKind.VOCABULARY_SINGLE
    )
    group_key = None
    if is_grouped_set and group_prompt is not None:
        group_number = group_prompt[0]
        group_key = f"page-{page_number}:group-{group_number}"

    blocks: list[ParsedQuestionBlock] = []
    for index, match in enumerate(QUESTION_BLOCK_PATTERN.finditer(source_text), start=1):
        stem = _clean_exam_text(match.group("stem"))
        if _looks_like_question_group_instruction(stem):
            continue
        choices = tuple(
            choice
            for choice in (
                f"{choice_index} {_clean_exam_text(match.group(f'c{choice_index}'))}"
                for choice_index in range(1, 5)
            )
            if len(choice) > 2
        )
        if not stem or len(choices) < 4:
            continue
        source_excerpt = match.group(0).strip()
        source_order = (page_number * 10_000) + (chunk_index * 1_000) + index
        blocks.append(
            ParsedQuestionBlock(
                source_order=source_order,
                source_question_number=match.group("number"),
                item_kind=item_kind,
                group_key=group_key,
                group_prompt=group_prompt[1] if is_grouped_set and group_prompt else None,
                stem=stem,
                choices=choices,
                source_excerpt=source_excerpt[:500],
            )
        )
    return blocks


def content_profile_from_value(value: ContentProfileValue | None) -> ContentProfile:
    if isinstance(value, ContentProfile):
        return value
    if isinstance(value, str):
        try:
            return ContentProfile(value)
        except ValueError:
            return ContentProfile.UNKNOWN
    return ContentProfile.UNKNOWN


def question_item_kind_from_value(value: QuestionItemKindValue | None) -> QuestionItemKind:
    if isinstance(value, QuestionItemKind):
        return value
    if isinstance(value, str):
        try:
            return QuestionItemKind(value)
        except ValueError:
            return QuestionItemKind.UNKNOWN
    return QuestionItemKind.UNKNOWN


def _group_prompts(text: str) -> list[tuple[str, str]]:
    prompts: list[tuple[str, str]] = []
    for match in GROUP_PROMPT_PATTERN.finditer(text or ""):
        prompt = _clean_exam_text(match.group("prompt"))
        if prompt:
            prompts.append((match.group("number"), prompt))
    return prompts


def _first_group_prompt(text: str) -> tuple[str, str] | None:
    prompts = _group_prompts(text)
    return prompts[0] if prompts else None


def _clean_exam_text(text: str) -> str:
    return " ".join((text or "").split()).strip(" -")


def _question_block_source_text(text: str) -> str:
    group_match = GROUP_PROMPT_PATTERN.search(text or "")
    if group_match is not None:
        return (text or "")[group_match.end() :]
    return re.sub(
        r"^.*?(?:\u9078\u3073\u306a\u3055\u3044|choose)[?\u3002.]*\s*(?=\d{1,3}\s+)",
        "",
        text or "",
        count=1,
        flags=re.IGNORECASE | re.DOTALL,
    )


def _looks_like_question_group_instruction(stem: str) -> bool:
    lowered = stem.lower()
    return (
        "\u554f\u984c" in stem
        or "\u9078\u3073\u306a\u3055\u3044" in stem
        or (lowered.startswith("mondai") and "choose" in lowered and "?" not in lowered)
    )


def _prompt_is_grouped_question_set(prompt: str) -> bool:
    lowered = prompt.lower()
    grouped_markers = (
        "blank",
        "passage",
        "conversation",
        "dialogue",
        "\u6b21\u306e\u6587",
        "\u672c\u6587",
        "\u4f1a\u8a71",
        "\u7a7a\u6b04",
        "__",
    )
    return any(marker in lowered or marker in prompt for marker in grouped_markers)
