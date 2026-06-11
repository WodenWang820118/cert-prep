from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

from exam_prep_backend.domains.mock_exams.models import DraftSuggestion, SourceChunk


@dataclass(frozen=True, slots=True)
class ProviderHealth:
    provider: str
    model: str
    available: bool
    detail: str


class DraftGenerationProvider(Protocol):
    provider: str
    model: str

    def health(self) -> ProviderHealth:
        pass

    def generate_drafts(self, chunks: Sequence[SourceChunk], limit: int) -> list[DraftSuggestion]:
        pass
