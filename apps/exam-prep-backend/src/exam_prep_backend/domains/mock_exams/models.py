from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import TypeAlias


class DraftStatus(StrEnum):
    DRAFT = "draft"
    APPROVED = "approved"


class AnswerKeySource(StrEnum):
    MANUAL = "manual"
    PDF = "pdf"
    AI_INFERRED = "ai_inferred"


DraftStatusValue: TypeAlias = DraftStatus | str
AnswerKeySourceValue: TypeAlias = AnswerKeySource | str

GENERATED_DRAFT_STATUS = DraftStatus.APPROVED
DEFAULT_MANUAL_ANSWER_KEY_SOURCE = AnswerKeySource.MANUAL
DEFAULT_GENERATED_ANSWER_KEY_SOURCE = AnswerKeySource.AI_INFERRED


@dataclass(frozen=True, slots=True)
class SourceChunk:
    id: str
    page_number: int
    text: str
    source_excerpt: str = ""

    def excerpt_or_text_prefix(self, max_chars: int = 500) -> str:
        return self.source_excerpt or self.text[:max_chars]


@dataclass(frozen=True, slots=True)
class DraftSuggestion:
    chunk_id: str
    question: str
    choices: Sequence[str]
    answer: str
    answer_key_source: AnswerKeySource | str
    rationale: str
    citation_page: int
    source_excerpt: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "choices", tuple(self.choices))
        object.__setattr__(
            self,
            "answer_key_source",
            answer_key_source_from_value(self.answer_key_source),
        )

    def to_serialized(self) -> dict[str, object]:
        return {
            "chunk_id": self.chunk_id,
            "question": self.question,
            "choices": list(self.choices),
            "answer": self.answer,
            "answer_key_source": self.answer_key_source.value,
            "rationale": self.rationale,
            "citation_page": self.citation_page,
            "source_excerpt": self.source_excerpt,
        }


def answer_key_source_from_value(
    value: AnswerKeySource | str | None,
    *,
    default: AnswerKeySource = DEFAULT_GENERATED_ANSWER_KEY_SOURCE,
) -> AnswerKeySource:
    if isinstance(value, AnswerKeySource):
        return value
    if isinstance(value, str):
        try:
            return AnswerKeySource(value)
        except ValueError:
            return default
    return default


def draft_status_from_value(
    value: DraftStatus | str | None,
    *,
    default: DraftStatus = DraftStatus.DRAFT,
) -> DraftStatus:
    if isinstance(value, DraftStatus):
        return value
    if isinstance(value, str):
        try:
            return DraftStatus(value)
        except ValueError:
            return default
    return default
