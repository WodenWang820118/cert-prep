"""Writing question drafts with an Ollama model: the prompts, and reading what the model returns."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import replace
import logging
from typing import Any

from cert_prep_backend.ai_providers.domain.generation_errors import (
    is_non_fatal_generation_error,
)
from cert_prep_backend.ai_providers.domain.provider import (
    DEFAULT_KEEP_ALIVE,
    JsonChat,
    JsonChatProvider,
)
from cert_prep_backend.authoring.domain.deterministic_parser import (
    extract_jlpt_question_blocks,
    is_exam_source_chunk,
    source_text_and_chunks_for_prompt,
)
from cert_prep_backend.authoring.domain.models import (
    AnswerKeySource,
    DraftSuggestion,
    SourceChunk,
)
from cert_prep_backend.authoring.domain.normalization import dedupe_suggestions
from cert_prep_backend.authoring.application.ports import ReadingLexicon
from cert_prep_backend.authoring.domain.reading_solver import (
    ReadingSolution,
    section_asks_for_reading,
    solve_reading_question,
)
from cert_prep_backend.authoring.infrastructure.reasoning_parser import (
    draft_suggestion_from_item,
    json_payload,
)
from cert_prep_backend.authoring.infrastructure.response_parsing import (
    RATIONALE_LANGUAGE_INSTRUCTION,
    answer_from_payload,
    confidence_from_payload,
    fast_first_prompt,
    fast_first_retry_prompt,
    json_object_or_unavailable,
)
from cert_prep_backend.platform.errors import ProviderUnavailableError

_LOGGER = logging.getLogger(__name__)
_REASONING_JSON_ATTEMPTS = 4


class OllamaDraftWriter:
    """Draft writer that asks an Ollama model for answers, rationales and missing items."""

    def __init__(
        self, model: JsonChatProvider, *, reading_lexicon: ReadingLexicon | None = None
    ) -> None:
        self._model = model
        self._reading_lexicon = reading_lexicon

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
        self,
        chunks: Sequence[SourceChunk],
        limit: int,
        *,
        num_ctx: int = 8192,
        num_predict: int = 4096,
        keep_alive: str | float | int | None = DEFAULT_KEEP_ALIVE,
    ) -> list[DraftSuggestion]:
        """Ask Ollama for structured JSON drafts and validate grounded results."""

        if not chunks or limit <= 0:
            return []

        source, prompt_chunks = source_text_and_chunks_for_prompt(chunks, limit)
        return self._model.json_chat_session(
            lambda chat: self._reasoning_drafts(
                chat,
                chunks,
                source,
                prompt_chunks,
                limit=limit,
                num_ctx=num_ctx,
                num_predict=num_predict,
                keep_alive=keep_alive,
            )
        )

    def _reasoning_drafts(
        self,
        chat: JsonChat,
        chunks: Sequence[SourceChunk],
        source: str,
        prompt_chunks: Sequence[SourceChunk],
        *,
        limit: int,
        num_ctx: int,
        num_predict: int,
        keep_alive: str | float | int | None,
    ) -> list[DraftSuggestion]:
        payload = _request_reasoning_payload(
            chat,
            _reasoning_user_prompt(source, limit=limit),
            num_ctx=num_ctx,
            num_predict=num_predict,
            keep_alive=keep_alive,
        )

        chunks_by_page = {chunk.page_number: chunk for chunk in prompt_chunks}
        chunks_by_id = {chunk.id: chunk for chunk in prompt_chunks}
        suggestions = _suggestions_from_reasoning_payload(
            payload,
            chunks_by_page=chunks_by_page,
            chunks_by_id=chunks_by_id,
            limit=limit,
        )
        if (
            limit <= 1
            or len(suggestions) >= limit
            or (not suggestions and not any(is_exam_source_chunk(chunk) for chunk in chunks))
        ):
            return suggestions

        missing = limit - len(suggestions)
        supplemental_chunks = _prioritize_supplemental_chunks(
            chunks,
            prompted=prompt_chunks,
            accepted=suggestions,
        )
        supplemental_source, supplemental_prompt_chunks = source_text_and_chunks_for_prompt(
            supplemental_chunks,
            missing,
        )
        supplemental_payload = _request_reasoning_payload(
            chat,
            _supplemental_reasoning_user_prompt(
                supplemental_source,
                limit=missing,
                accepted=suggestions,
            ),
            num_ctx=num_ctx,
            num_predict=num_predict,
            keep_alive=keep_alive,
        )
        supplemental = _suggestions_from_reasoning_payload(
            supplemental_payload,
            chunks_by_page={chunk.page_number: chunk for chunk in supplemental_prompt_chunks},
            chunks_by_id={chunk.id: chunk for chunk in supplemental_prompt_chunks},
            limit=limit,
        )
        return dedupe_suggestions([*suggestions, *supplemental], limit)

    def generate_fast_first_draft(
        self,
        source_chunk: SourceChunk,
        candidate: DraftSuggestion,
        *,
        num_ctx: int = 4096,
        num_predict: int = 512,
        keep_alive: str | float | int | None = DEFAULT_KEEP_ALIVE,
    ) -> DraftSuggestion | None:
        """Ask Ollama to complete one extracted draft with answer/rationale JSON."""

        if (
            not candidate.answer
            and self._reading_lexicon is not None
            and section_asks_for_reading(candidate.section_instruction)
        ):
            solution = solve_reading_question(
                candidate.question,
                candidate.choices,
                self._reading_lexicon.kanji_span_readings(candidate.question),
            )
            if isinstance(solution, ReadingSolution):
                return replace(
                    candidate,
                    answer=candidate.choices[solution.choice_index],
                    answer_key_source=AnswerKeySource.AI_INFERRED,
                    rationale=solution.rationale,
                    confidence=1.0,
                    dictionary_generated=True,
                )

        try:
            payload = None
            answer = None
            for attempt in range(_REASONING_JSON_ATTEMPTS):
                try:
                    payload = self._model.json_chat_session(
                        lambda chat: json_object_or_unavailable(
                            chat(
                                [
                                    {
                                        "role": "user",
                                        "content": (
                                            fast_first_prompt(candidate)
                                            if attempt == 0
                                            else fast_first_retry_prompt(candidate)
                                        ),
                                    }
                                ],
                                num_ctx=num_ctx,
                                num_predict=num_predict,
                                keep_alive=keep_alive,
                            ),
                            provider_label="Ollama",
                        )
                    )
                    answer = answer_from_payload(payload.get("answer"), candidate.choices)
                    if answer is not None:
                        break
                    if attempt + 1 < _REASONING_JSON_ATTEMPTS:
                        _LOGGER.warning(
                            "Ollama fast-first answer did not match visible choices; retrying."
                        )
                except ProviderUnavailableError as exc:
                    if "invalid JSON" not in str(exc) or attempt + 1 >= _REASONING_JSON_ATTEMPTS:
                        raise
                    _LOGGER.warning("Ollama fast-first response was not JSON; retrying.")
            if payload is None or answer is None:
                raise ProviderUnavailableError("Ollama returned an unreadable response.")
        except ProviderUnavailableError as exc:
            if is_non_fatal_generation_error(exc):
                return None
            raise
        if answer is None:
            return None

        rationale = payload.get("rationale")
        rationale_text = (
            rationale.strip()
            if isinstance(rationale, str) and rationale.strip()
            else "Qwen inferred the answer from the visible stem and choices."
        )
        return DraftSuggestion(
            chunk_id=source_chunk.id,
            question=candidate.question,
            choices=candidate.choices,
            answer=answer,
            answer_key_source=AnswerKeySource.AI_INFERRED,
            rationale=rationale_text,
            citation_page=source_chunk.page_number,
            source_excerpt=candidate.source_excerpt,
            confidence=confidence_from_payload(payload.get("confidence")),
            source_order=candidate.source_order,
            source_question_number=candidate.source_question_number,
            item_kind=candidate.item_kind,
            group_key=candidate.group_key,
            group_prompt=candidate.group_prompt,
            section_instruction=candidate.section_instruction,
        )


def _request_reasoning_payload(
    chat: JsonChat,
    user_prompt: str,
    *,
    num_ctx: int,
    num_predict: int,
    keep_alive: str | float | int | None,
) -> dict[str, Any]:
    messages = [
        {
            "role": "system",
            "content": _reasoning_system_prompt(),
        },
        {"role": "user", "content": user_prompt},
    ]
    for attempt in range(_REASONING_JSON_ATTEMPTS):
        try:
            # JSON mode, not a schema: the installed Qwen study profile reliably honors
            # Ollama's JSON mode, while the larger schema parameter can make the same model
            # emit Markdown. The response parser below still performs the complete field,
            # type, and source-grounding validation, so accepting JSON mode does not relax
            # the host contract or introduce a provider fallback.
            return json_payload(
                chat(
                    messages,
                    num_ctx=num_ctx,
                    num_predict=num_predict,
                    keep_alive=keep_alive,
                )
            )
        except ProviderUnavailableError as exc:
            if "invalid JSON" not in str(exc) or attempt + 1 >= _REASONING_JSON_ATTEMPTS:
                raise
            _LOGGER.warning("Ollama reasoning response was not JSON; retrying.")
    raise AssertionError("unreachable")


def _suggestions_from_reasoning_payload(
    payload: dict[str, Any],
    *,
    chunks_by_page: dict[int, SourceChunk],
    chunks_by_id: dict[str, SourceChunk],
    limit: int,
) -> list[DraftSuggestion]:
    raw_items = payload.get("items", [])
    if not isinstance(raw_items, list):
        return []

    suggestions: list[DraftSuggestion] = []
    for raw_item in raw_items:
        suggestion = draft_suggestion_from_item(raw_item, chunks_by_page, chunks_by_id)
        if suggestion is None:
            continue
        suggestions.append(suggestion)
    return dedupe_suggestions(suggestions, limit)


def _prioritize_supplemental_chunks(
    chunks: Sequence[SourceChunk],
    *,
    prompted: Sequence[SourceChunk],
    accepted: Sequence[DraftSuggestion],
) -> list[SourceChunk]:
    prompted_chunk_ids = {chunk.id for chunk in prompted}
    accepted_chunk_ids = {suggestion.chunk_id for suggestion in accepted}
    return [
        *[chunk for chunk in chunks if chunk.id not in prompted_chunk_ids],
        *[
            chunk
            for chunk in chunks
            if chunk.id in prompted_chunk_ids and chunk.id not in accepted_chunk_ids
        ],
        *[chunk for chunk in chunks if chunk.id in accepted_chunk_ids],
    ]


def _reasoning_system_prompt() -> str:
    return (
        "You convert OCR text from an uploaded JLPT exam into practice-ready "
        "mock exam questions. Preserve actual exam questions and choices. "
        "Ignore cover pages, title pages, notes, version notices, copyright "
        "notices, and general instructions; do not invent questions from them. "
        "Only output real multiple-choice exam items with a question stem and "
        "visible choices. If an explicit answer key is present, use it. If it "
        "is absent, infer the correct answer and mark answer_key_source as "
        "ai_inferred. Do not include chain-of-thought, hidden reasoning, or "
        "analysis. Only include a concise user-facing rationale. "
        "Return one JSON object with an items array; never use Markdown or "
        f"prose outside that JSON object. {RATIONALE_LANGUAGE_INSTRUCTION}"
    )


def _reasoning_user_prompt(
    source: str,
    *,
    limit: int,
) -> str:
    return (
        "Return one item for each distinct visible multiple-choice exam item, "
        f"up to {limit}. If at least {limit} valid items are present, return exactly {limit}. "
        "If fewer valid items are present, return only those items, possibly an empty array. "
        "Never invent, duplicate, or split an item merely to reach the requested count. "
        "Inspect the complete supplied source before responding. Each item must have a complete "
        "question stem and at least two visible choices, with each choice in a separate choices "
        "array element. For every item, set answer to the exact choice text, include a concise "
        "user-facing rationale. Include confidence as a number from 0 to 1, keep "
        "citation_page from the source page, and include a source_excerpt copied exactly "
        "from the source text. If the source only contains title, note, version, or "
        f"instruction text, return an empty items array for that text.\n\n{source}\n"
        f"{RATIONALE_LANGUAGE_INSTRUCTION}"
    )


def _supplemental_reasoning_user_prompt(
    source: str,
    *,
    limit: int,
    accepted: Sequence[DraftSuggestion],
) -> str:
    exclusions = "\n".join(
        (
            f"- chunk_id={suggestion.chunk_id}; "
            f"source_question_number={suggestion.source_question_number or 'unknown'}; "
            f"question={suggestion.question[:160]}"
        )
        for suggestion in accepted
    )
    accepted_context = (
        f"Do not repeat these already accepted items:\n{exclusions}\n\n"
        if exclusions
        else "No item from the prior response passed strict validation.\n\n"
    )
    return (
        "This is the single supplemental pass because the prior response did not yield enough "
        "complete grounded items. Return only additional distinct visible multiple-choice exam "
        f"items, up to {limit}. If at least {limit} additional valid items are present, return "
        f"exactly {limit}. Never invent, duplicate, or split an item to reach the count. Each "
        "item must have a complete question stem and at least two visible choices, with every "
        "choice in a separate choices array element. Set answer to the exact choice text, include "
        "a concise user-facing rationale. Include confidence from 0 to 1, keep citation_page from "
        "the source page, and copy source_excerpt exactly from the source text. "
        f"{accepted_context}{source}\n"
        f"{RATIONALE_LANGUAGE_INSTRUCTION}"
    )
