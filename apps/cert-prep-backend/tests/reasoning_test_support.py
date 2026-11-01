"""Test-only adapter over the production reasoning admission.

Production code calls `admit_reasoning_item` and handles every admission
outcome. Tests that only care about the accepted suggestion use this helper.
"""

from cert_prep_backend.authoring.domain.models import DraftSuggestion, SourceChunk
from cert_prep_backend.authoring.infrastructure.reasoning_parser import admit_reasoning_item


def draft_suggestion_from_item(
    raw_item: object,
    chunks_by_page: dict[int, SourceChunk],
    chunks_by_id: dict[str, SourceChunk],
) -> DraftSuggestion | None:
    admission = admit_reasoning_item(raw_item, chunks_by_page, chunks_by_id)
    return admission if isinstance(admission, DraftSuggestion) else None
