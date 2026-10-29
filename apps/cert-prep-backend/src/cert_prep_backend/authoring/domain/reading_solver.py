"""Deterministic, target-free rules for choosing a kanji span's reading."""

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
import re
from typing import Literal


_CHOICE_NUMBER = re.compile(r"^\s*[0-9０-９]+[.．、)）]?\s*")
_BLANK_MARKER = re.compile(
    r"\(\s*\)|（\s*）|\[\s*\]|［\s*］|[_＿]+|★|…{2,}"
    # Repeated long-vowel marks inside katakana words are not blank markers.
    r"|(?<![ァ-ヺー])ー{2,}(?![ァ-ヺー])"
)


def section_asks_for_reading(instruction: str | None) -> bool:
    return instruction is not None and any(word in instruction for word in ("読み方", "よみかた"))


@dataclass(frozen=True, slots=True)
class ReadingSpan:
    surface: str
    reading: str


@dataclass(frozen=True, slots=True)
class ReadingSolution:
    choice_index: int
    surface: str
    reading: str

    @property
    def rationale(self) -> str:
        return f"「{self.surface}」的讀音是「{self.reading}」，所以答案是 {self.choice_index + 1}。"


def _normalize_reading(text: str) -> str:
    return "".join(
        chr(ord(char) - 0x60) if "ァ" <= char <= "ヶ" else char
        for char in text
        if not char.isspace()
    )


def solve_reading_question(
    stem: str, choices: Sequence[str], spans: Iterable[ReadingSpan]
) -> ReadingSolution | Literal[
    "blank_marker", "no_choices", "short_choice", "no_matching_reading", "ambiguous_readings"
]:
    if _BLANK_MARKER.search(stem):
        return "blank_marker"
    readings = [_normalize_reading(_CHOICE_NUMBER.sub("", choice)) for choice in choices]
    if not readings:
        return "no_choices"
    if any(len(reading) < 2 for reading in readings):
        return "short_choice"

    # Sort before matching so duplicate spans and unordered lexicons cannot change
    # which surface appears in the explanation for the same unique choice.
    ordered_spans = sorted(
        {ReadingSpan(span.surface, _normalize_reading(span.reading)) for span in spans},
        key=lambda span: (span.surface, span.reading),
    )
    matches = [
        ReadingSolution(index, span.surface, span.reading)
        for index, reading in enumerate(readings)
        for span in ordered_spans
        if span.reading == reading
    ]
    if not matches:
        return "no_matching_reading"
    if len({match.choice_index for match in matches}) != 1:
        return "ambiguous_readings"
    return matches[0]
