from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

from exam_prep_backend.domains.mock_exams.models import DraftSuggestion, SourceChunk


@dataclass(frozen=True, slots=True)
class ProviderHealth:
    """Read-only health snapshot for a draft-generation provider."""

    provider: str
    model: str
    available: bool
    detail: str
    unavailable_reason: str | None = None
    configured_model: str | None = None
    effective_model: str | None = None
    fallback_models: tuple[str, ...] = ()
    fallback_reason: str | None = None


@dataclass(frozen=True, slots=True)
class ModelPullProgress:
    """Progress reported by an explicit model download provider."""

    status: str
    completed: int | None = None
    total: int | None = None


class DraftGenerationProvider(Protocol):
    """Boundary for providers that turn source chunks into draft exam items."""

    provider: str
    model: str

    def health(self) -> ProviderHealth:
        """Return provider and model availability without generating drafts."""
        pass

    def generate_drafts(self, chunks: Sequence[SourceChunk], limit: int) -> list[DraftSuggestion]:
        """Generate up to limit draft suggestions from source chunks."""
        pass
