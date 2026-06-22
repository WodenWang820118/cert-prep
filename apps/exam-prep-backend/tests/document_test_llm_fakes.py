from exam_prep_backend.domains.mock_exams.models import DraftSuggestion, SourceChunk
from exam_prep_backend.domains.mock_exams.ports import ProviderHealth
from exam_prep_backend.errors import ProviderUnavailableError


class MockExamProvider:
    provider = "mock-exam"
    model = "gemma4:12b"

    def health(self) -> ProviderHealth:
        return ProviderHealth(
            provider=self.provider,
            model=self.model,
            available=True,
            detail="test provider",
        )

    def generate_drafts(
        self, chunks: list[SourceChunk] | tuple[SourceChunk, ...], limit: int
    ) -> list[DraftSuggestion]:
        suggestions = [
            DraftSuggestion(
                chunk_id=chunk.id,
                question=f"JLPT question {chunk.page_number}: choose the correct word.",
                choices=["A correct", "B wrong"],
                answer="A correct",
                answer_key_source="ai_inferred",
                rationale="OCR text identifies A as the correct option.",
                citation_page=chunk.page_number,
                source_excerpt=f"JLPT question {chunk.page_number}: choose the correct word.",
            )
            for chunk in chunks
        ]
        return suggestions[:limit]

    def generate_fast_first_draft(
        self,
        source_chunk: SourceChunk,
        candidate: DraftSuggestion,
    ) -> DraftSuggestion | None:
        return DraftSuggestion(
            chunk_id=source_chunk.id,
            question=candidate.question,
            choices=candidate.choices,
            answer=candidate.choices[0] if candidate.choices else "",
            answer_key_source="ai_inferred",
            rationale="Test provider inferred the first visible choice.",
            citation_page=source_chunk.page_number,
            source_excerpt=candidate.source_excerpt,
            confidence=0.8,
            source_order=candidate.source_order,
            source_question_number=candidate.source_question_number,
            item_kind=candidate.item_kind,
            group_key=candidate.group_key,
            group_prompt=candidate.group_prompt,
        )


class MissingModelExamProvider(MockExamProvider):
    model = "qwen3.5:4b"

    def health(self) -> ProviderHealth:
        return ProviderHealth(
            provider="ollama",
            model=self.model,
            available=False,
            detail="model not found",
            unavailable_reason="model_missing",
        )

    def generate_drafts(
        self, chunks: list[SourceChunk] | tuple[SourceChunk, ...], limit: int
    ) -> list[DraftSuggestion]:
        raise AssertionError("streaming worker should not call a missing model")


class FailingExamProvider(MockExamProvider):
    def generate_drafts(
        self, chunks: list[SourceChunk] | tuple[SourceChunk, ...], limit: int
    ) -> list[DraftSuggestion]:
        raise AssertionError("notice pages should not enqueue streaming draft jobs")


class FastFirstCompletionExamProvider(MockExamProvider):
    provider = "ollama"
    model = "qwen3.5:2b"

    def __init__(self) -> None:
        self.fast_first_calls: list[dict] = []
        self.reasoning_calls: list[dict] = []

    def generate_fast_first_draft(
        self,
        source_chunk: SourceChunk,
        candidate: DraftSuggestion,
    ) -> DraftSuggestion | None:
        self.fast_first_calls.append(
            {
                "page_numbers": [source_chunk.page_number],
                "question": candidate.question,
            }
        )
        return super().generate_fast_first_draft(source_chunk, candidate)

    def generate_reasoning_drafts(
        self,
        chunks: list[SourceChunk] | tuple[SourceChunk, ...],
        limit: int,
        *,
        num_ctx: int,
        num_predict: int,
    ) -> list[DraftSuggestion]:
        self.reasoning_calls.append(
            {
                "page_numbers": [chunk.page_number for chunk in chunks],
                "limit": limit,
                "num_ctx": num_ctx,
                "num_predict": num_predict,
            }
        )
        raise AssertionError("fast-first completion should run before reasoning fallback")

    def generate_drafts(
        self, chunks: list[SourceChunk] | tuple[SourceChunk, ...], limit: int
    ) -> list[DraftSuggestion]:
        raise AssertionError("streaming hybrid path should use fast-first reasoning")


class InvalidJsonReasoningExamProvider(MockExamProvider):
    provider = "ollama"
    model = "qwen3.5:4b"

    def generate_fast_first_draft(
        self,
        source_chunk: SourceChunk,
        candidate: DraftSuggestion,
    ) -> DraftSuggestion | None:
        return None

    def generate_reasoning_drafts(
        self,
        chunks: list[SourceChunk] | tuple[SourceChunk, ...],
        limit: int,
        *,
        num_ctx: int,
        num_predict: int,
    ) -> list[DraftSuggestion]:
        raise ProviderUnavailableError("Ollama returned invalid JSON.")

    def generate_drafts(
        self, chunks: list[SourceChunk] | tuple[SourceChunk, ...], limit: int
    ) -> list[DraftSuggestion]:
        raise AssertionError("streaming hybrid path should not retry full generation")
