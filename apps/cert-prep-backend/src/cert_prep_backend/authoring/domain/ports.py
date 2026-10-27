"""How Question Authoring asks for drafts: a draft writer and its optional capabilities.

A draft writer turns source chunks into draft exam items with a language model of AI
Providers; ``authoring.infrastructure.draft_writing.draft_writer_for`` picks the writer for
the configured model.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Protocol, runtime_checkable

from cert_prep_backend.authoring.domain.models import DraftSuggestion, SourceChunk

__all__ = [
    "DraftGenerationProvider",
    "FastFirstDraftProvider",
    "ReasoningDraftProvider",
]


@runtime_checkable
class DraftGenerationProvider(Protocol):
    """Boundary for writers that turn source chunks into draft exam items."""

    def generate_drafts(self, chunks: Sequence[SourceChunk], limit: int) -> list[DraftSuggestion]:
        """Generate up to limit draft suggestions from source chunks."""
        pass


@runtime_checkable
class ReasoningDraftProvider(Protocol):
    """Writer capability for structured reasoning over source chunks."""

    def generate_reasoning_drafts(
        self,
        chunks: Sequence[SourceChunk],
        limit: int,
        **kwargs: Any,
    ) -> list[DraftSuggestion]:
        """Generate drafts through the provider's reasoning path."""
        pass


@runtime_checkable
class FastFirstDraftProvider(Protocol):
    """Writer capability for completing one deterministic draft candidate."""

    def generate_fast_first_draft(
        self,
        source_chunk: SourceChunk,
        candidate: DraftSuggestion,
        **kwargs: Any,
    ) -> DraftSuggestion | None:
        """Complete answer/rationale fields for one deterministic draft."""
        pass
