from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import TypeAlias

from exam_prep_backend.domains.exam_content import (
    ContentProfileValue,
    QuestionItemKind,
    QuestionItemKindValue,
    question_item_kind_from_value,
)


class DraftStatus(StrEnum):
    DRAFT = "draft"
    APPROVED = "approved"


class DraftGenerationStrategy(StrEnum):
    DETERMINISTIC_ONLY = "deterministic_only"
    HYBRID_REASONING = "hybrid_reasoning"


class AnswerKeySource(StrEnum):
    MANUAL = "manual"
    PDF = "pdf"
    AI_INFERRED = "ai_inferred"


DraftStatusValue: TypeAlias = DraftStatus | str
DraftGenerationStrategyValue: TypeAlias = DraftGenerationStrategy | str
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
    chunk_index: int = 0
    raw_text: str = ""
    line_start: int | None = None
    line_end: int | None = None
    line_count: int = 0
    content_profile: ContentProfileValue = "unknown"

    def excerpt_or_text_prefix(self, max_chars: int = 500) -> str:
        return self.source_excerpt or self.text[:max_chars]

    def raw_or_text(self) -> str:
        return self.raw_text or self.text


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
    status: DraftStatus | str = GENERATED_DRAFT_STATUS
    confidence: float | None = None
    source_order: int | None = None
    source_question_number: str | None = None
    item_kind: QuestionItemKindValue = QuestionItemKind.UNKNOWN
    group_key: str | None = None
    group_prompt: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "choices", tuple(self.choices))
        object.__setattr__(
            self,
            "answer_key_source",
            answer_key_source_from_value(self.answer_key_source),
        )
        object.__setattr__(self, "status", draft_status_from_value(self.status))
        object.__setattr__(self, "item_kind", question_item_kind_from_value(self.item_kind))
        if self.confidence is not None:
            object.__setattr__(self, "confidence", float(self.confidence))

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
            "confidence": self.confidence,
            "source_order": self.source_order,
            "source_question_number": self.source_question_number,
            "item_kind": self.item_kind.value,
            "group_key": self.group_key,
            "group_prompt": self.group_prompt,
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
