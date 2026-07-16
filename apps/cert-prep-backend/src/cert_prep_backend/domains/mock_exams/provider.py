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
    collect_ollama_machine_inventory,
    ollama_profile_selection_from_settings,
)
from cert_prep_backend.domains.mock_exams.ports import (
    ReasoningDraftProvider,
    provider_capability,
)
from cert_prep_backend.domains.mock_exams.provider_selection import (
    provider_selection_from_settings,
)
from cert_prep_contracts.hardware import MachineInventorySnapshot
from cert_prep_contracts.llm import LLMProviderName
from cert_prep_contracts.runtime import RuntimeRequirementKind
from cert_prep_ollama.profiles import select_ollama_execution_policy
from cert_prep_backend.domains.mock_exams.reasoning_parser import (
    EXAM_ITEMS_SCHEMA,
    draft_suggestion_from_item as _draft_suggestion_from_item,
    json_response as _json_response,
)


def provider_from_settings(settings: Settings):
    """Create the configured mock exam provider."""

    selected_provider = _selected_provider_from_settings(settings)
    if selected_provider == LLMProviderName.OLLAMA:
        inventory = _ollama_inventory_from_settings(settings)
        profile_selection = ollama_profile_selection_from_settings(
            settings,
            provider_selected=True,
            inventory=inventory,
        )
        model = (
            profile_selection.selected_profile.local_model
            if profile_selection is not None
            else settings.ollama_model
        )
        return OllamaProvider(
            host=settings.ollama_host,
            model=model,
            timeout_seconds=settings.ollama_timeout_seconds,
            profile_selection=profile_selection,
            execution_policy=select_ollama_execution_policy(inventory),
        )
    return FakeLLMProvider(model=settings.ollama_model)


class LazyDraftGenerationProvider:
    """Delay provider creation until an endpoint actually needs it."""

    _LAZY_PROVIDER_EXTENSION_ATTRIBUTES: frozenset[str] = frozenset(
        {
            "generate_reasoning_drafts",
            "generate_fast_first_draft",
            "generation_attribution",
            "prepare_model_onboarding",
            "release_resources",
            "reset_generation_attribution",
            "verify_model_onboarding",
            "pull_model",
        }
    )

    def __init__(
        self,
        factory: Callable[[], object],
        *,
        provider: str,
        model: str,
        runtime_requirement_kind: RuntimeRequirementKind | None = None,
        starts_on_generation: bool = False,
    ) -> None:
        self._factory = factory
        self._provider_hint = provider
        self._model_hint = model
        self._runtime_requirement_kind = runtime_requirement_kind
        self._starts_on_generation = starts_on_generation
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

    @property
    def runtime_requirement_kind(self) -> RuntimeRequirementKind | None:
        resolved = self._provider
        if resolved is None:
            return self._runtime_requirement_kind
        return getattr(resolved, "runtime_requirement_kind", None)

    @property
    def starts_on_generation(self) -> bool:
        resolved = self._provider
        if resolved is None:
            return self._starts_on_generation
        return bool(getattr(resolved, "starts_on_generation", False))

    @property
    def profile_selection(self):
        resolved = self._provider
        if resolved is None:
            return None
        return getattr(resolved, "profile_selection", None)

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

    def reconfigure_from_settings(self, settings: Settings) -> None:
        """Reset the lazy provider after an explicit local policy decision."""

        selected_provider = _selected_provider_from_settings(settings).value
        with self._lock:
            resolved = self._provider
            self._provider = None
            self._provider_hint = selected_provider
            self._model_hint = _provider_model_hint(settings, selected_provider)
            self._runtime_requirement_kind = (
                RuntimeRequirementKind.OLLAMA
                if selected_provider == "ollama"
                else None
            )
            self._starts_on_generation = False
        if resolved is not None:
            close = getattr(resolved, "close", None)
            if callable(close):
                close()

    def streaming_generation_kwargs(self) -> dict[str, object]:
        resolved = self._resolved_provider()
        kwargs = getattr(resolved, "streaming_generation_kwargs", None)
        if callable(kwargs):
            return dict(kwargs())
        return {}

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
        if name not in self._LAZY_PROVIDER_EXTENSION_ATTRIBUTES:
            raise AttributeError(f"{type(self).__name__!r} object has no attribute {name!r}")
        return getattr(self._resolved_provider(), name)


def lazy_provider_from_settings(settings: Settings) -> LazyDraftGenerationProvider:
    """Create a provider proxy that keeps app startup free of provider probes."""

    selected_provider = _selected_provider_from_settings(settings).value
    return LazyDraftGenerationProvider(
        lambda: provider_from_settings(settings),
        provider=selected_provider,
        model=_provider_model_hint(settings, selected_provider),
        runtime_requirement_kind=(
            RuntimeRequirementKind.OLLAMA if selected_provider == "ollama" else None
        ),
        starts_on_generation=False,
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

    reasoning_provider = provider_capability(provider, ReasoningDraftProvider)
    if reasoning_provider is not None:
        generated = reasoning_provider.generate_reasoning_drafts(chunks, limit)
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
        if suggestion.answer and suggestion.answer in suggestion.choices and suggestion.rationale
    ][:limit]


def _provider_model_hint(settings: Settings, selected_provider: str | None = None) -> str:
    del selected_provider
    # Keep the lazy hint at the shared configured model. Hardware inventory and
    # any profile-specific local alias are resolved only when the provider is
    # first used.
    return settings.ollama_model


def _selected_provider_from_settings(settings: Settings) -> LLMProviderName:
    if settings.llm_provider == "auto":
        return provider_selection_from_settings(settings).selected_provider
    return LLMProviderName(settings.llm_provider)


def _ollama_inventory_from_settings(
    settings: Settings,
) -> MachineInventorySnapshot | None:
    try:
        return collect_ollama_machine_inventory(settings)
    except Exception:
        return None


__all__ = [
    "EXAM_ITEMS_SCHEMA",
    "FakeLLMProvider",
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
