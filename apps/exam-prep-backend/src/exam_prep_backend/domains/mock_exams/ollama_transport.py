from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import ollama

from exam_prep_backend.domains.mock_exams.deterministic_parser import (
    extract_jlpt_question_blocks,
    source_text_for_prompt,
)
from exam_prep_backend.domains.mock_exams.models import DraftSuggestion, SourceChunk
from exam_prep_backend.domains.mock_exams.normalization import dedupe_suggestions
from exam_prep_backend.domains.mock_exams.ports import ModelPullProgress, ProviderHealth
from exam_prep_backend.domains.mock_exams.reasoning_parser import (
    EXAM_ITEMS_SCHEMA,
    draft_suggestion_from_item,
    json_response,
)
from exam_prep_backend.domains.runtime_installations import resolve_ollama_executable


class OllamaProvider:
    """Ollama-backed mock exam draft provider and model-download transport."""

    provider = "ollama"

    def __init__(self, host: str, model: str, timeout_seconds: float) -> None:
        self.host = host
        self.model = model
        self._client = ollama.Client(host=host, timeout=timeout_seconds)

    def health(self) -> ProviderHealth:
        """Return Ollama process and configured-model availability."""

        if resolve_ollama_executable() is None:
            return ProviderHealth(
                provider=self.provider,
                model=self.model,
                available=False,
                detail="Ollama is not installed.",
                unavailable_reason="ollama_missing",
            )
        try:
            response = self._client.list()
        except Exception as exc:
            return ProviderHealth(
                provider=self.provider,
                model=self.model,
                available=False,
                detail=f"Ollama unavailable: {exc}",
                unavailable_reason="ollama_not_running",
            )

        model_names = extract_model_names(response)
        available = self.model in model_names
        detail = "model available" if available else "model not found"
        return ProviderHealth(
            provider=self.provider,
            model=self.model,
            available=available,
            detail=detail,
            unavailable_reason=None if available else "model_missing",
        )

    def generate_drafts(self, chunks: Sequence[SourceChunk], limit: int) -> list[DraftSuggestion]:
        """Generate drafts by combining deterministic extraction with reasoning fallback."""

        if not chunks:
            return []

        extracted = extract_jlpt_question_blocks(chunks, limit)
        if len(extracted) >= limit:
            return extracted

        generated = self.generate_reasoning_drafts(chunks, limit - len(extracted))
        return dedupe_suggestions([*extracted, *generated], limit)

    def generate_reasoning_drafts(
        self, chunks: Sequence[SourceChunk], limit: int
    ) -> list[DraftSuggestion]:
        """Ask Ollama for structured JSON drafts and validate grounded results."""

        if not chunks or limit <= 0:
            return []

        source = source_text_for_prompt(chunks, limit)
        response = self._client.chat(
            model=self.model,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You convert OCR text from an uploaded JLPT exam into practice-ready "
                        "mock exam questions. Preserve actual exam questions and choices. "
                        "Ignore cover pages, title pages, notes, version notices, copyright "
                        "notices, and general instructions; do not invent questions from them. "
                        "Only output real multiple-choice exam items with a question stem and "
                        "visible choices. If an explicit answer key is present, use it. If it "
                        "is absent, infer the correct answer and mark answer_key_source as "
                        "ai_inferred. Do not include chain-of-thought, hidden reasoning, or "
                        "analysis. Only include a concise user-facing rationale."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"Create up to {limit} JLPT mock exam items from this page-delimited "
                        "source text. For every item, set answer to the exact choice text, "
                        "include a concise user-facing rationale, include confidence as a "
                        "number from 0 to 1, keep citation_page from the source page, and "
                        "include a source_excerpt copied exactly from the source text. If "
                        "the source only contains title, note, version, or instruction text, "
                        "return an empty items array for that text.\n\n"
                        f"{source}"
                    ),
                },
            ],
            format=EXAM_ITEMS_SCHEMA,
            options={"temperature": 0, "num_ctx": 8192, "num_predict": 4096},
            think=False,
        )
        payload = json_response(response)
        raw_items = payload.get("items", [])
        if not isinstance(raw_items, list):
            return []

        chunks_by_page = {chunk.page_number: chunk for chunk in chunks}
        chunks_by_id = {chunk.id: chunk for chunk in chunks}
        suggestions: list[DraftSuggestion] = []
        for raw_item in raw_items:
            suggestion = draft_suggestion_from_item(raw_item, chunks_by_page, chunks_by_id)
            if suggestion is None:
                continue
            suggestions.append(suggestion)
            if len(suggestions) >= limit:
                break
        return suggestions

    def pull_model(self, progress) -> None:
        """Pull the configured Ollama model after explicit user confirmation."""

        for update in self._client.pull(self.model, stream=True):
            progress(pull_progress(update))


def extract_model_names(response: Any) -> set[str]:
    """Extract model names from the shapes returned by Ollama clients."""

    models = getattr(response, "models", None)
    if models is None and isinstance(response, dict):
        models = response.get("models", [])
    names: set[str] = set()
    for model in models or []:
        name = getattr(model, "model", None)
        if name is None and isinstance(model, dict):
            name = model.get("model") or model.get("name")
        if isinstance(name, str):
            names.add(name)
    return names


def pull_progress(response: Any) -> ModelPullProgress:
    """Normalize streamed Ollama pull progress into domain progress values."""

    status = getattr(response, "status", None)
    completed = getattr(response, "completed", None)
    total = getattr(response, "total", None)
    if isinstance(response, dict):
        status = response.get("status", status)
        completed = response.get("completed", completed)
        total = response.get("total", total)
    return ModelPullProgress(
        status=status if isinstance(status, str) else "downloading model",
        completed=completed if isinstance(completed, int) else None,
        total=total if isinstance(total, int) else None,
    )
