from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from exam_prep_backend.domains.mock_exams.models import SourceChunk


@dataclass(frozen=True, slots=True)
class ApprovalDecision:
    missing: tuple[str, ...] = ()

    @property
    def approved(self) -> bool:
        return not self.missing

    @property
    def blocked(self) -> bool:
        return bool(self.missing)

    def as_blocked_payload(self) -> dict[str, object]:
        return {"blocked": self.blocked, "missing": list(self.missing)}


def normalize_answer(answer: str, choices: Sequence[str]) -> str:
    if answer in choices:
        return answer

    normalized = answer.strip().rstrip(".:")
    letter_to_index = {"A": 0, "B": 1, "C": 2, "D": 3, "1": 0, "2": 1, "3": 2, "4": 3}
    index = letter_to_index.get(normalized.upper())
    if index is not None and index < len(choices):
        return choices[index]

    for choice in choices:
        stripped = choice.strip()
        if stripped.startswith(f"{normalized}.") or stripped.startswith(f"{normalized} "):
            return choice
    return answer


def approval_decision(draft: Mapping[str, object]) -> ApprovalDecision:
    return ApprovalDecision(missing=missing_approval_fields(draft))


def missing_approval_fields(draft: Mapping[str, object]) -> tuple[str, ...]:
    missing: list[str] = []
    choices = _choices_from_value(draft.get("choices"))
    answer = draft.get("answer")

    if not draft.get("document_id"):
        missing.append("document_id")
    if not draft.get("chunk_id"):
        missing.append("chunk_id")
    if draft.get("citation_page") is None:
        missing.append("citation_page")
    if not draft.get("source_excerpt"):
        missing.append("source_excerpt")
    if len(choices) < 2:
        missing.append("choices")
    if not isinstance(answer, str) or not answer or answer not in choices:
        missing.append("answer")
    if not draft.get("rationale"):
        missing.append("rationale")
    return tuple(missing)


def grounding_errors_for_draft(
    draft: Mapping[str, object],
    chunk: SourceChunk | None,
) -> tuple[str, ...]:
    if chunk is None:
        return ("document_chunk",)

    errors: list[str] = []
    if draft.get("citation_page") != chunk.page_number:
        errors.append("citation_page")

    source_excerpt = _text(draft.get("source_excerpt")).strip()
    if source_excerpt and source_excerpt not in chunk.text:
        errors.append("source_excerpt")
    return tuple(errors)


def _choices_from_value(value: object) -> Sequence[str]:
    if isinstance(value, Sequence) and not isinstance(value, str):
        return tuple(item for item in value if isinstance(item, str))
    return ()


def _text(value: object) -> str:
    return value if isinstance(value, str) else ""
