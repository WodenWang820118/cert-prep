from __future__ import annotations

from collections.abc import Sequence

from exam_prep_backend.config import DEFAULT_OLLAMA_MODEL
from exam_prep_backend.domains.exam_content import QuestionItemKind
from exam_prep_backend.domains.mock_exams.models import (
    AnswerKeySource,
    DraftSuggestion,
    SourceChunk,
)
from exam_prep_backend.domains.mock_exams.ports import ProviderHealth


class FakeLLMProvider:
    """Deterministic local provider used when Ollama is not configured."""

    provider = "fake"

    def __init__(self, model: str = DEFAULT_OLLAMA_MODEL) -> None:
        self.model = model

    def health(self) -> ProviderHealth:
        """Return an always-available health snapshot for local deterministic drafts."""

        return ProviderHealth(
            provider=self.provider,
            model=self.model,
            available=True,
            detail="deterministic local fake provider",
        )

    def generate_drafts(self, chunks: Sequence[SourceChunk], limit: int) -> list[DraftSuggestion]:
        """Generate deterministic placeholder drafts from source chunks."""

        suggestions: list[DraftSuggestion] = []
        for chunk in chunks[:limit]:
            excerpt = chunk.excerpt_or_text_prefix()
            suggestions.append(
                DraftSuggestion(
                    chunk_id=chunk.id,
                    question="Which action best applies the cited exam concept?",
                    choices=[
                        "Apply the cited concept",
                        "Ignore the cited source",
                        "Choose an unrelated control",
                        "Remove all safeguards",
                    ],
                    answer="Apply the cited concept",
                    answer_key_source=AnswerKeySource.AI_INFERRED,
                    rationale=f"The cited source supports applying this concept: {excerpt}",
                    citation_page=chunk.page_number,
                    source_excerpt=excerpt,
                    confidence=1.0,
                    source_order=(chunk.page_number * 10_000) + (chunk.chunk_index * 1_000) + 1,
                    item_kind=QuestionItemKind.UNKNOWN,
                )
            )
        return suggestions
