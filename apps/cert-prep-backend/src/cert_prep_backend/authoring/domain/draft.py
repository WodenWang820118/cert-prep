"""The Question Draft aggregate: a multiple-choice question a learner can edit and practise.

A draft is written by hand or generated from a source chunk. Values read back from storage
(answer key source, item kind, status) are kept as stored, so older rows keep their meaning.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, replace

from cert_prep_backend.authoring.domain.models import (
    AnswerKeySource,
    AnswerKeySourceValue,
    DraftStatusValue,
)
from cert_prep_backend.platform.errors import ValidationError
from cert_prep_backend.source_library.domain.exam_content import (
    QuestionItemKind,
    QuestionItemKindValue,
)

__all__ = ["DraftEdit", "NewQuestionDraft", "QuestionDraft"]


@dataclass(frozen=True, slots=True)
class NewQuestionDraft:
    """A draft the learner writes by hand; it may cite one chunk of a source document."""

    question: str = ""
    choices: Sequence[str] = ()
    answer: str | None = None
    answer_key_source: AnswerKeySourceValue = AnswerKeySource.MANUAL
    rationale: str | None = None
    citation_page: int | None = None
    source_excerpt: str | None = None
    confidence: float | None = None
    document_id: str | None = None
    chunk_id: str | None = None
    source_order: int | None = None
    source_question_number: str | None = None
    item_kind: QuestionItemKindValue = QuestionItemKind.UNKNOWN
    group_key: str | None = None
    group_prompt: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "choices", tuple(self.choices))

    @property
    def cites_a_source(self) -> bool:
        return self.document_id is not None or self.chunk_id is not None

    def ensure_source_is_complete(self) -> None:
        """A cited source names both the document and the chunk, or neither."""

        if self.cites_a_source and (self.document_id is None or self.chunk_id is None):
            raise ValidationError("Document id and chunk id must be provided together.")


@dataclass(frozen=True, slots=True)
class DraftEdit:
    """A learner's correction of a draft: only the fields given change."""

    question: str | None = None
    choices: Sequence[str] | None = None
    answer: str | None = None
    answer_key_source: AnswerKeySourceValue | None = None
    rationale: str | None = None
    citation_page: int | None = None
    source_excerpt: str | None = None
    confidence: float | None = None
    source_order: int | None = None
    source_question_number: str | None = None
    item_kind: QuestionItemKindValue | None = None
    group_key: str | None = None
    group_prompt: str | None = None

    def __post_init__(self) -> None:
        if self.choices is not None:
            object.__setattr__(self, "choices", tuple(self.choices))


_EDITABLE_FIELDS = (
    "question",
    "choices",
    "answer",
    "answer_key_source",
    "rationale",
    "citation_page",
    "source_excerpt",
    "confidence",
    "source_order",
    "source_question_number",
    "item_kind",
    "group_key",
    "group_prompt",
)


@dataclass(frozen=True, slots=True)
class QuestionDraft:
    """A stored question draft, its source citation, and whether it is approved."""

    id: str
    project_id: str
    document_id: str | None
    chunk_id: str | None
    question: str
    choices: tuple[str, ...]
    answer: str | None
    answer_key_source: AnswerKeySourceValue
    rationale: str | None
    citation_page: int | None
    citation_locator_kind: str
    citation_start_ms: int | None
    citation_end_ms: int | None
    source_excerpt: str | None
    confidence: float | None
    source_order: int | None
    source_question_number: str | None
    item_kind: QuestionItemKindValue
    group_key: str | None
    group_prompt: str | None
    status: DraftStatusValue
    rejection_reason: str | None
    created_at: str
    updated_at: str

    def edited(self, edit: DraftEdit, *, now: str) -> QuestionDraft:
        """The draft after the learner's correction; its source and status stay as they are."""

        changes = {
            field: getattr(edit, field)
            for field in _EDITABLE_FIELDS
            if getattr(edit, field) is not None
        }
        return replace(self, **changes, updated_at=now)
