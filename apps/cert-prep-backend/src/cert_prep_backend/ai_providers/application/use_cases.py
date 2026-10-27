"""Use cases of AI Providers, named after what the learner checks or chooses about the model."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass

from cert_prep_backend.ai_providers.application.ports import MachineInventory
from cert_prep_backend.ai_providers.domain.provider import LLMProvider, ProviderHealth
from cert_prep_backend.ai_providers.domain.selection import select_provider
from cert_prep_backend.platform.config import Settings
from cert_prep_contracts.hardware import MachineInventorySnapshot
from cert_prep_contracts.llm import LLMProviderName, LLMProviderPreference, LLMProviderSelection
from cert_prep_contracts.llm_profiles import OllamaModelProfile, OllamaProfileSelection
from cert_prep_ollama.profiles import (
    fallback_models_for_selection,
    profile_catalog,
    select_ollama_profile,
)

__all__ = [
    "check_provider_health",
    "choose_ollama_profile",
    "inspect_machine",
    "list_model_profiles",
    "show_profile_selection",
    "show_provider_selection",
]


@dataclass(frozen=True, slots=True)
class ProfileSelectionReport:
    """The Ollama profile chosen for this machine, or none: then the configured model is used."""

    selection: OllamaProfileSelection | None
    fallback_models: tuple[str, ...]
    configured_model: str


def check_provider_health(provider: LLMProvider) -> ProviderHealth:
    return provider.health()


def show_provider_selection(settings: Settings, provider: LLMProvider) -> LLMProviderSelection:
    """The provider the learner's preference selects, and the one actually in use."""

    resolve = getattr(provider, "resolved_provider", None)
    effective_provider = resolve() if callable(resolve) else provider
    return select_provider(
        LLMProviderPreference(settings.llm_provider),
        configured_model=settings.ollama_model,
        effective_provider=str(getattr(effective_provider, "provider", "")),
        effective_model=str(getattr(effective_provider, "model", "")),
    )


def list_model_profiles() -> Sequence[OllamaModelProfile]:
    return profile_catalog()


def show_profile_selection(settings: Settings, machine: MachineInventory) -> ProfileSelectionReport:
    """Which Ollama profile fits this machine, for the provider the preference selects."""

    selected = select_provider(
        LLMProviderPreference(settings.llm_provider),
        configured_model=settings.ollama_model,
    ).selected_provider
    selection = choose_ollama_profile(
        settings,
        machine.inventory,
        provider_selected=selected == LLMProviderName.OLLAMA,
    )
    return ProfileSelectionReport(
        selection=selection,
        fallback_models=(
            tuple(fallback_models_for_selection(selection)) if selection is not None else ()
        ),
        configured_model=settings.ollama_model,
    )


def inspect_machine(machine: MachineInventory, *, refresh: bool = False) -> MachineInventorySnapshot:
    return machine.inventory(refresh=refresh)


def choose_ollama_profile(
    settings: Settings,
    read_inventory: Callable[[], MachineInventorySnapshot | None],
    *,
    provider_selected: bool = False,
) -> OllamaProfileSelection | None:
    """The Ollama model profile for this machine, when profiles apply to the provider.

    The machine is measured only when a profile is chosen.
    """

    if (
        settings.llm_provider != "ollama" and not provider_selected
    ) or not settings.ollama_profile_enabled:
        return None
    return select_ollama_profile(read_inventory(), profile_id=settings.ollama_profile_id)
