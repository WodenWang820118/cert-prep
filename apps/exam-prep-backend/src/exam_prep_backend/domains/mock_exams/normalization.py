from __future__ import annotations

from collections.abc import Sequence

from exam_prep_backend.domains.mock_exams.models import DraftStatus, DraftSuggestion


def as_ai_reasoning_draft(suggestion: DraftSuggestion) -> DraftSuggestion:
    """Normalize provider suggestions into draft status for mixed generation strategies."""

    return DraftSuggestion(
        chunk_id=suggestion.chunk_id,
        question=suggestion.question,
        choices=suggestion.choices,
        answer=suggestion.answer,
        answer_key_source=suggestion.answer_key_source,
        rationale=suggestion.rationale,
        citation_page=suggestion.citation_page,
        source_excerpt=suggestion.source_excerpt,
        status=DraftStatus.DRAFT,
        confidence=suggestion.confidence,
        source_order=suggestion.source_order,
        source_question_number=suggestion.source_question_number,
        item_kind=suggestion.item_kind,
        group_key=suggestion.group_key,
        group_prompt=suggestion.group_prompt,
    )


def dedupe_suggestions(
    suggestions: Sequence[DraftSuggestion], limit: int
) -> list[DraftSuggestion]:
    """Deduplicate generated suggestions while preserving source order."""

    deduped: list[DraftSuggestion] = []
    seen: set[tuple[str, str, str]] = set()
    for suggestion in suggestions:
        key = (
            suggestion.chunk_id,
            suggestion.source_question_number or "",
            suggestion.question.strip().casefold(),
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(suggestion)
        if len(deduped) >= limit:
            break
    return deduped
