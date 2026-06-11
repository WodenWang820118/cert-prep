from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Callable, Protocol

from exam_prep_backend.domains.mock_exams.models import DraftSuggestion, SourceChunk


@dataclass(frozen=True, slots=True)
class ProviderHealth:
    provider: str
    model: str
    available: bool
    detail: str


@dataclass(frozen=True, slots=True)
class ModelPullProgress:
    """Progress reported by an explicit model download provider."""

    status: str
    completed: int | None = None
    total: int | None = None


class DraftGenerationProvider(Protocol):
    provider: str
    model: str

    def health(self) -> ProviderHealth:
        pass

    def generate_drafts(self, chunks: Sequence[SourceChunk], limit: int) -> list[DraftSuggestion]:
        pass


class ModelDownloadProvider(Protocol):
    """Provider capability for user-confirmed local model downloads."""

    provider: str
    model: str

    def pull_model(self, progress: Callable[[ModelPullProgress], None]) -> None:
        pass
