from __future__ import annotations

from collections.abc import Callable, Sequence
from threading import Lock

from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.mock_exams.deterministic_parser import (
    MAX_PROMPT_SOURCE_CHARS,
    extract_jlpt_question_blocks as _extract_jlpt_question_blocks,
    source_text_for_prompt as _source_text_for_prompt,
)
from cert_prep_backend.domains.mock_exams.fake_provider import FakeLLMProvider
from cert_prep_backend.domains.mock_exams.fastflowlm_transport import FastFlowLMProvider
from cert_prep_backend.domains.mock_exams.models import (
    DraftGenerationStrategy,
    DraftSuggestion,
    SourceChunk,
)
from cert_prep_backend.domains.mock_exams.normalization import (
    as_editable_question as _as_editable_question,
    dedupe_suggestions as _dedupe_suggestions,
)
from cert_prep_backend.domains.mock_exams.ollama_transport import (
    OllamaProvider,
    extract_model_names as _extract_model_names,
    pull_progress as _pull_progress,
)
from cert_prep_backend.domains.mock_exams.ollama_profiles import (
    ollama_profile_selection_from_settings,
)
from cert_prep_backend.domains.mock_exams.reasoning_parser import (
    EXAM_ITEMS_SCHEMA,
    draft_suggestion_from_item as _draft_suggestion_from_item,
    json_response as _json_response,
)


def provider_from_settings(settings: Settings):
    """Create the configured mock exam provider."""

    if settings.llm_provider == "ollama":
        profile_selection = ollama_profile_selection_from_settings(settings)
        model = (
            profile_selection.selected_profile.local_model
            if profile_selection is not None
            else settings.ollama_model
        )
        fallback_models = (
            tuple(profile.local_model for profile in profile_selection.fallback_profiles)
            if profile_selection is not None
            else tuple(settings.ollama_fallback_models)
        )
        return OllamaProvider(
            host=settings.ollama_host,
            model=model,
            fallback_models=fallback_models,
            timeout_seconds=settings.ollama_timeout_seconds,
            profile_selection=profile_selection,
        )
    if settings.llm_provider == "fastflowlm":
        return FastFlowLMProvider(
            base_url=settings.fastflowlm_base_url,
            model=settings.fastflowlm_model,
            fallback_models=settings.fastflowlm_fallback_models,
            timeout_seconds=settings.fastflowlm_timeout_seconds,
            model_pull_timeout_seconds=settings.runtime_install_timeout_seconds,
            primary_min_available_ram_bytes=(
                settings.fastflowlm_primary_min_available_ram_bytes
            ),
            auto_start_server=settings.fastflowlm_auto_start_server,
            server_start_timeout_seconds=settings.fastflowlm_server_start_timeout_seconds,
            owned_server_idle_timeout_seconds=(
                settings.fastflowlm_owned_server_idle_timeout_seconds
            ),
        )
    return FakeLLMProvider(model=settings.ollama_model)


class LazyDraftGenerationProvider:
    """Delay provider creation until an endpoint actually needs it."""

    def __init__(
        self,
        factory: Callable[[], object],
        *,
        provider: str,
        model: str,
    ) -> None:
        self._factory = factory
        self._provider_hint = provider
        self._model_hint = model
        self._lock = Lock()
        self._provider: object | None = None

    @property
    def provider(self) -> str:
        resolved = self._provider
        if resolved is None:
            return self._provider_hint
        return str(getattr(resolved, "provider", self._provider_hint))

    @property
    def model(self) -> str:
        resolved = self._provider
        if resolved is None:
            return self._model_hint
        return str(getattr(resolved, "model", self._model_hint))

    def health(self):
        return self._resolved_provider().health()

    def generate_drafts(
        self,
        chunks: Sequence[SourceChunk],
        limit: int,
    ) -> list[DraftSuggestion]:
        return self._resolved_provider().generate_drafts(chunks, limit)

    def close(self) -> None:
        resolved = self._provider
        if resolved is None:
            return
        close = getattr(resolved, "close", None)
        if callable(close):
            close()

    def resolved_provider(self) -> object:
        """Return the underlying provider, resolving it on first access."""

        return self._resolved_provider()

    def _resolved_provider(self):
        resolved = self._provider
        if resolved is not None:
            return resolved
        with self._lock:
            if self._provider is None:
                self._provider = self._factory()
            return self._provider

    def __getattr__(self, name: str):
        if name not in _LAZY_PROVIDER_EXTENSION_ATTRIBUTES:
            raise AttributeError(name)
        return getattr(self._resolved_provider(), name)


def lazy_provider_from_settings(settings: Settings) -> LazyDraftGenerationProvider:
    """Create a provider proxy that keeps app startup free of provider probes."""

    return LazyDraftGenerationProvider(
        lambda: provider_from_settings(settings),
        provider=settings.llm_provider,
        model=_provider_model_hint(settings),
    )


def generate_drafts_for_strategy(
    provider,
    chunks: Sequence[SourceChunk],
    limit: int,
    strategy: DraftGenerationStrategy,
) -> list[DraftSuggestion]:
    """Generate immediately playable question suggestions for a document."""

    deterministic = _extract_jlpt_question_blocks(chunks, limit)
    if strategy == DraftGenerationStrategy.DETERMINISTIC_ONLY:
        return _playable_suggestions(deterministic, limit)

    if isinstance(provider, OllamaProvider):
        generated = provider.generate_reasoning_drafts(chunks, limit)
    else:
        generated = provider.generate_drafts(chunks, limit)
    generated = [_as_editable_question(suggestion) for suggestion in generated]
    return _dedupe_suggestions(
        [*_playable_suggestions(deterministic, limit), *generated],
        limit,
    )


def _playable_suggestions(
    suggestions: Sequence[DraftSuggestion], limit: int
) -> list[DraftSuggestion]:
    return [
        suggestion
        for suggestion in suggestions
        if suggestion.answer
        and suggestion.answer in suggestion.choices
        and suggestion.rationale
    ][:limit]


def _provider_model_hint(settings: Settings) -> str:
    if settings.llm_provider == "fastflowlm":
        return settings.fastflowlm_model
    if settings.llm_provider == "ollama" and settings.ollama_profile_enabled:
        return f"ollama-profile:{settings.ollama_profile_id}"
    return settings.ollama_model


_LAZY_PROVIDER_EXTENSION_ATTRIBUTES = {
    "auto_start_server",
    "generate_fast_first_draft",
    "generate_reasoning_drafts",
    "pull_model",
    "release_resources",
}


__all__ = [
    "EXAM_ITEMS_SCHEMA",
    "FakeLLMProvider",
    "FastFlowLMProvider",
    "LazyDraftGenerationProvider",
    "MAX_PROMPT_SOURCE_CHARS",
    "OllamaProvider",
    "_as_editable_question",
    "_dedupe_suggestions",
    "_draft_suggestion_from_item",
    "_extract_jlpt_question_blocks",
    "_extract_model_names",
    "_json_response",
    "_pull_progress",
    "_source_text_for_prompt",
    "generate_drafts_for_strategy",
    "lazy_provider_from_settings",
    "provider_from_settings",
]
