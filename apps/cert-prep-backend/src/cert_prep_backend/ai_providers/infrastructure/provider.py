from __future__ import annotations

from collections.abc import Callable
from threading import Lock
from typing import TYPE_CHECKING

from cert_prep_backend.ai_providers.application.use_cases import choose_ollama_profile
from cert_prep_backend.ai_providers.domain.selection import select_provider
from cert_prep_backend.ai_providers.infrastructure.fake_provider import FakeLLMProvider
from cert_prep_backend.ai_providers.infrastructure.machine_inventory import OllamaMachineInventory
from cert_prep_backend.ai_providers.infrastructure.ollama_transport import OllamaProvider
from cert_prep_backend.platform.config import Settings
from cert_prep_contracts.hardware import MachineInventorySnapshot
from cert_prep_contracts.llm import LLMProviderName, LLMProviderPreference
from cert_prep_contracts.runtime import RuntimeRequirementKind
from cert_prep_ollama.profiles import select_ollama_execution_policy

if TYPE_CHECKING:
    from cert_prep_ollama.server_coordinator import OllamaServerCoordinator


def provider_from_settings(
    settings: Settings,
    server: OllamaServerCoordinator | None = None,
):
    """Create the configured language model provider."""

    selected_provider = _selected_provider_from_settings(settings)
    if selected_provider == LLMProviderName.OLLAMA:
        inventory = _ollama_inventory_from_settings(settings)
        profile_selection = choose_ollama_profile(
            settings,
            lambda: inventory,
            provider_selected=True,
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
            server=server,
        )
    return FakeLLMProvider(model=settings.ollama_model)


class LazyLLMProvider:
    """Delay provider creation until an endpoint actually needs it."""

    _LAZY_PROVIDER_EXTENSION_ATTRIBUTES: frozenset[str] = frozenset(
        {
            "generate_structured_json",
            "generation_attribution",
            "json_chat_session",
            "prepare_model_onboarding",
            "release_resources",
            "reset_generation_attribution",
            "verify_model_onboarding",
            "pull_model",
            "device_execution",
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


def lazy_provider_from_settings(
    settings: Settings,
    server: OllamaServerCoordinator | None = None,
) -> LazyLLMProvider:
    """Create a provider proxy that keeps app startup free of provider probes."""

    selected_provider = _selected_provider_from_settings(settings).value
    return LazyLLMProvider(
        lambda: provider_from_settings(settings, server=server),
        provider=selected_provider,
        model=_provider_model_hint(settings, selected_provider),
        runtime_requirement_kind=(
            RuntimeRequirementKind.OLLAMA if selected_provider == "ollama" else None
        ),
        starts_on_generation=False,
    )


def _provider_model_hint(settings: Settings, selected_provider: str | None = None) -> str:
    del selected_provider
    # Keep the lazy hint at the shared configured model. Hardware inventory and
    # any profile-specific local alias are resolved only when the provider is
    # first used.
    return settings.ollama_model


def _selected_provider_from_settings(settings: Settings) -> LLMProviderName:
    if settings.llm_provider == "auto":
        return select_provider(
            LLMProviderPreference(settings.llm_provider),
            configured_model=settings.ollama_model,
        ).selected_provider
    return LLMProviderName(settings.llm_provider)


def _ollama_inventory_from_settings(
    settings: Settings,
) -> MachineInventorySnapshot | None:
    try:
        return OllamaMachineInventory(settings).inventory()
    except Exception:
        return None


__all__ = [
    "FakeLLMProvider",
    "LazyLLMProvider",
    "OllamaProvider",
    "lazy_provider_from_settings",
    "provider_from_settings",
]
