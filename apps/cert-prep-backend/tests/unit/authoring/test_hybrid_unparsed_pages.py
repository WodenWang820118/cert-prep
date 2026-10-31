from dataclasses import replace

import pytest

from cert_prep_backend.authoring.domain.deterministic_parser import extract_jlpt_question_blocks
from cert_prep_backend.authoring.domain.generation import DraftJobCanceledError
from cert_prep_backend.authoring.domain.models import (
    DraftGenerationStrategy,
    DraftSuggestion,
    SourceChunk,
)
from cert_prep_backend.authoring.infrastructure.draft_writing import (
    generate_drafts_with_annotations_for_strategy,
)
from cert_prep_backend.authoring.infrastructure.streaming import _generate_streaming_fast_first_drafts
from cert_prep_backend.platform.errors import ProviderUnavailableError


def _page(number: int, *, parsed: bool = False) -> SourceChunk:
    # Invented source text, unrelated to private exam inputs.
    text = (
        f"Mondai 1 Choose the correct word. {number + 4} Which widget is correct? "
        "1 alpha 2 beta 3 gamma 4 delta"
        if parsed
        else f"Choose a widget from the damaged layout on page {number}."
    )
    return SourceChunk(id=f"page-{number}", page_number=number, text=text, source_excerpt=text)


def _reasoned(chunk: SourceChunk) -> DraftSuggestion:
    return DraftSuggestion(
        chunk_id=chunk.id,
        question=f"Reasoned widget on page {chunk.page_number}?",
        choices=["alpha", "beta"],
        answer="alpha",
        answer_key_source="ai_inferred",
        rationale="The source supports alpha.",
        citation_page=chunk.page_number,
        source_excerpt=chunk.text,
    )


class RecordingHybridProvider:
    provider = "fake"
    model = "offline"

    def __init__(self, *, incomplete=False, error=None, duplicates=False, dictionary=False):
        self.fast_calls = []
        self.reasoning_calls = []
        self.incomplete = incomplete
        self.error = error
        self.duplicates = duplicates
        self.dictionary = dictionary

    def generate_fast_first_draft(self, chunk, candidate):
        self.fast_calls.append(chunk.id)
        if self.incomplete:
            return None
        return replace(
            candidate,
            answer=candidate.choices[0],
            rationale="The source supports alpha.",
            dictionary_generated=self.dictionary,
        )

    def generate_reasoning_drafts(self, chunks, limit):
        self.reasoning_calls.append(([chunk.id for chunk in chunks], limit))
        if self.error and chunks[0].id == "page-2":
            raise self.error
        suggestions = [_reasoned(chunk) for chunk in chunks]
        if self.duplicates:
            suggestions = [suggestions[0], suggestions[0], replace(
                suggestions[0], question="A second distinct widget?"
            )]
        return suggestions


def _generate(provider, chunks, limit=10):
    return generate_drafts_with_annotations_for_strategy(
        provider, chunks, limit, DraftGenerationStrategy.HYBRID_REASONING
    )


def test_mixed_pages_use_fast_first_then_reasoning_for_remaining_count():
    provider = RecordingHybridProvider(dictionary=True)
    result = _generate(provider, [_page(1, parsed=True), _page(2), _page(3)], limit=2)
    assert provider.fast_calls == ["page-1"]
    assert provider.reasoning_calls == [(["page-2"], 1)]
    assert [item.chunk_id for item in result.suggestions] == ["page-1", "page-2"]
    assert [item.dictionary_generated for item in result.suggestions] == [True, False]
    assert result.unavailable_blocks == []


def test_reasoning_duplicates_do_not_spend_the_next_pages_budget():
    provider = RecordingHybridProvider(duplicates=True)
    result = _generate(provider, [_page(1, parsed=True), _page(2), _page(3)], limit=4)
    assert provider.reasoning_calls == [(["page-2"], 3), (["page-3"], 1)]
    assert len(result.suggestions) == 4
    assert [item.chunk_id for item in result.suggestions] == [
        "page-1", "page-2", "page-2", "page-3"
    ]


@pytest.mark.parametrize("limit", [1, 10])
def test_all_parsed_pages_never_use_reasoning(limit):
    provider = RecordingHybridProvider()
    result = _generate(provider, [_page(1, parsed=True), _page(2, parsed=True)], limit)
    assert len(result.suggestions) == min(limit, 2)
    assert provider.reasoning_calls == []


def test_all_unparsed_pages_keep_the_existing_batched_reasoning_call():
    provider = RecordingHybridProvider()
    result = _generate(provider, [_page(2), _page(3)], limit=3)
    assert provider.fast_calls == []
    assert provider.reasoning_calls == [(["page-2", "page-3"], 3)]
    assert len(result.suggestions) == 2


def test_non_fatal_reasoning_failure_keeps_fast_first_and_other_pages():
    provider = RecordingHybridProvider(error=ProviderUnavailableError("invalid JSON"))
    result = _generate(provider, [_page(1, parsed=True), _page(2), _page(3)])
    assert [item.chunk_id for item in result.suggestions] == ["page-1", "page-3"]
    assert provider.reasoning_calls == [(["page-2"], 9), (["page-3"], 9)]


def test_a_repeat_limit_abort_skips_only_that_page():
    provider = RecordingHybridProvider(error=ProviderUnavailableError(
        "Ollama unavailable for configured model lfm3:1.7b: "
        "prediction aborted, token repeat limit reached (status code: 500)"
    ))
    result = _generate(provider, [_page(1, parsed=True), _page(2), _page(3)])
    assert [item.chunk_id for item in result.suggestions] == ["page-1", "page-3"]
    assert provider.reasoning_calls == [(["page-2"], 9), (["page-3"], 9)]


@pytest.mark.parametrize("error", [
    ProviderUnavailableError("model missing"),
    DraftJobCanceledError("Draft generation was canceled."),
])
def test_fatal_reasoning_errors_and_cancellation_propagate(error):
    provider = RecordingHybridProvider(error=error)
    with pytest.raises(type(error), match=str(error)):
        _generate(provider, [_page(1, parsed=True), _page(2), _page(3)])
    assert provider.reasoning_calls == [(["page-2"], 9)]


def test_unavailable_parsed_blocks_stay_reported_and_never_go_to_reasoning():
    provider = RecordingHybridProvider(incomplete=True)
    result = _generate(provider, [_page(1, parsed=True), _page(2), _page(3, parsed=True)])
    assert [item.chunk_id for item in result.suggestions] == ["page-2"]
    assert provider.reasoning_calls == [(["page-2"], 10)]
    assert [item.chunk_id for item in result.unavailable_blocks] == ["page-1", "page-3"]
    assert all("no playable answer" in item.reason for item in result.unavailable_blocks)


def test_parsed_pages_beyond_the_parser_limit_are_not_reasoned():
    provider = RecordingHybridProvider(incomplete=True)
    result = _generate(provider, [_page(1, parsed=True), _page(2, parsed=True), _page(3)], 1)
    assert provider.fast_calls == ["page-1"]
    assert provider.reasoning_calls == [(["page-3"], 1)]
    assert len(result.unavailable_blocks) == 1


def test_completed_continuation_beyond_parser_limit_is_not_reasoned_again():
    provider = RecordingHybridProvider(incomplete=True)
    pages = [
        _page(1, parsed=True),
        SourceChunk(id="page-2", page_number=2, chunk_index=1, document_id="document",
                    text="8 Which shape fits?\n1 alpha\n2 beta"),
        SourceChunk(id="page-3", page_number=3, chunk_index=2, document_id="document",
                    text="3 gamma\n4 delta"),
    ]
    assert [item.chunk_id for item in extract_jlpt_question_blocks(pages, 10)] == [
        "page-1", "page-2"
    ]
    _generate(provider, pages, 1)
    assert provider.reasoning_calls == [(["page-3"], 1)]


def test_without_fast_first_capability_the_existing_reasoning_path_is_used():
    class ReasoningOnly:
        def __init__(self):
            self.calls = []

        def generate_reasoning_drafts(self, chunks, limit):
            self.calls.append(([chunk.id for chunk in chunks], limit))
            return [_reasoned(chunks[-1])]

    provider = ReasoningOnly()
    result = _generate(provider, [_page(1, parsed=True), _page(2)], 2)
    assert provider.calls == [(["page-1", "page-2"], 2)]
    assert len(result.suggestions) == 1


def test_fast_first_only_provider_does_not_attempt_a_fallback():
    class FastFirstOnly:
        generate_fast_first_draft = RecordingHybridProvider.generate_fast_first_draft

        def __init__(self):
            self.fast_calls = []
            self.incomplete = False
            self.dictionary = False

    result = _generate(FastFirstOnly(), [_page(1, parsed=True), _page(2)])
    assert [item.chunk_id for item in result.suggestions] == ["page-1"]


def test_deterministic_only_does_not_call_either_provider_capability():
    provider = RecordingHybridProvider()
    pages = [_page(1, parsed=True), _page(2)]
    assert len(extract_jlpt_question_blocks(pages, 10)) == 1
    result = generate_drafts_with_annotations_for_strategy(
        provider, pages, 10, DraftGenerationStrategy.DETERMINISTIC_ONLY
    )
    assert result.suggestions == []
    assert len(result.unavailable_blocks) == 1
    assert provider.fast_calls == provider.reasoning_calls == []


def test_mixed_pages_assign_parser_compatible_source_order():
    result = _generate(
        RecordingHybridProvider(),
        [_page(1, parsed=True), replace(_page(2), chunk_index=2)],
    )
    assert [item.source_order for item in result.suggestions] == [10001, 22001]


def test_several_reasoning_drafts_keep_their_order_within_the_chunk():
    provider = RecordingHybridProvider(duplicates=True)
    result = _generate(provider, [_page(1, parsed=True), replace(_page(2), chunk_index=2)])
    assert [item.source_order for item in result.suggestions] == [10001, 22001, 22003]
    assert [item.question for item in result.suggestions[1:]] == [
        "Reasoned widget on page 2?", "A second distinct widget?"
    ]


@pytest.mark.parametrize("streaming", [False, True])
@pytest.mark.parametrize("source_order", [None, 0, 20077])
def test_reasoning_source_order_is_defaulted_only_when_absent(streaming, source_order):
    class OrderedReasoningProvider(RecordingHybridProvider):
        def generate_reasoning_drafts(self, chunks, limit, **kwargs):
            return [replace(_reasoned(chunks[0]), source_order=source_order)]

    chunk = replace(_page(2), chunk_index=2)
    provider = OrderedReasoningProvider()
    if streaming:
        suggestions = _generate_streaming_fast_first_drafts(
            provider, chunk, 1, DraftGenerationStrategy.HYBRID_REASONING
        )
    else:
        suggestions = _generate(provider, [_page(1, parsed=True), chunk]).suggestions[1:]
    assert suggestions[0].source_order == (22001 if source_order is None else source_order)
