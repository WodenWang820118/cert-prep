"""Use cases of AI Providers, named after what the learner checks or chooses about the model."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass

from cert_prep_backend.ai_providers.application.ports import (
    DevicePreferenceRepository,
    MachineInventory,
    OllamaDeviceServer,
)
from cert_prep_backend.ai_providers.domain.preference import (
    DevicePreference,
    DevicePreferenceMode,
    DevicePreferenceRejected,
    DevicePreferenceStatus,
)
from cert_prep_backend.ai_providers.domain.provider import LLMProvider, ProviderHealth
from cert_prep_backend.ai_providers.domain.selection import select_provider
from cert_prep_backend.platform.config import Settings
from cert_prep_contracts.hardware import MachineInventorySnapshot
from cert_prep_contracts.llm import LLMProviderName, LLMProviderPreference, LLMProviderSelection
from cert_prep_contracts.llm_profiles import OllamaModelProfile, OllamaProfileSelection
from cert_prep_ollama.device_policy import (
    OllamaDevicePreference,
    selectable_adapters,
    select_ollama_device_policy,
)
from cert_prep_ollama.profiles import (
    fallback_models_for_selection,
    profile_catalog,
    select_ollama_profile,
)

__all__ = [
    "check_provider_health",
    "choose_device_preference",
    "choose_ollama_profile",
    "inspect_machine",
    "list_model_profiles",
    "show_device_preference",
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


@dataclass(frozen=True, slots=True)
class DeviceChoiceReport:
    """One adapter the learner can see, including those that cannot be chosen."""

    adapter_key: str | None
    name: str
    classification: str
    backend: str | None
    selectable: bool


@dataclass(frozen=True, slots=True)
class DevicePreferenceView:
    """The stored choice, whether it is in effect, and the adapters on this machine."""

    mode: DevicePreferenceMode
    adapter_key: str | None
    adapter_name: str | None
    status: DevicePreferenceStatus
    choices: tuple[DeviceChoiceReport, ...]


def show_device_preference(
    machine: MachineInventory,
    preferences: DevicePreferenceRepository,
    server: OllamaDeviceServer,
) -> DevicePreferenceView:
    """The stored device choice and the adapters the cached inventory lists."""

    inventory = machine.inventory(refresh=False)
    return _device_preference_view(preferences.load(), inventory, server)


def choose_device_preference(
    machine: MachineInventory,
    preferences: DevicePreferenceRepository,
    server: OllamaDeviceServer,
    *,
    mode: DevicePreferenceMode,
    adapter_key: str | None,
) -> DevicePreferenceView:
    """Store a device choice and ask the server to switch. Does not wait for a restart.

    The cached inventory is enough when the requested adapter is already in it.
    A key that is absent is measured once. The response is the row read back
    after the save, so a concurrent choice cannot be reported unless it was stored.
    """

    inventory = machine.inventory(refresh=False)
    key = _blank_to_none(adapter_key)
    if mode is DevicePreferenceMode.ADAPTER:
        if key is None:
            raise DevicePreferenceRejected(
                "unknown_device",
                "Choosing an adapter requires adapter_key.",
            )
        match = _matching_adapter(inventory, key)
        if match is None:
            inventory = machine.inventory(refresh=True)
            match = _matching_adapter(inventory, key)
        if match is None:
            raise DevicePreferenceRejected(
                "unknown_device",
                "That adapter is not a selectable choice on this machine.",
            )
        stored = DevicePreference(
            mode=DevicePreferenceMode.ADAPTER,
            adapter_key=key,
            adapter_name=match.name,
            pci_vendor_id=match.pci_vendor_id,
            pci_device_id=match.pci_device_id,
        )
    else:
        if key is not None:
            raise DevicePreferenceRejected(
                "validation_error",
                "adapter_key is only allowed when mode is adapter.",
            )
        stored = DevicePreference(mode=mode)
    preferences.save(stored)
    loaded = preferences.load()
    current = loaded if loaded is not None else stored
    server.apply_device_preference(_package_preference(current))
    return _device_preference_view(current, inventory, server)


def _matching_adapter(inventory: MachineInventorySnapshot, key: str):
    return next(
        (
            choice
            for choice in selectable_adapters(inventory)
            if choice.selectable and choice.adapter_key == key
        ),
        None,
    )


def _blank_to_none(adapter_key: str | None) -> str | None:
    if adapter_key is None:
        return None
    stripped = adapter_key.strip()
    return stripped or None


def _package_preference(stored: DevicePreference) -> OllamaDevicePreference:
    if stored.mode is DevicePreferenceMode.AUTO:
        return OllamaDevicePreference()
    if stored.mode is DevicePreferenceMode.CPU:
        return OllamaDevicePreference(mode="cpu")
    return OllamaDevicePreference(
        mode="adapter",
        adapter_key=stored.adapter_key,
        adapter_name=stored.adapter_name,
        pci_vendor_id=stored.pci_vendor_id,
        pci_device_id=stored.pci_device_id,
    )


def _preference_status(
    application: str,
    *,
    pending: bool,
    external: bool,
) -> DevicePreferenceStatus:
    if application == "not_applicable":
        return DevicePreferenceStatus.NOT_APPLICABLE
    if application == "adapter_missing":
        return DevicePreferenceStatus.ADAPTER_MISSING
    if pending:
        return DevicePreferenceStatus.PENDING
    if external:
        return DevicePreferenceStatus.EXTERNAL_SERVER
    return DevicePreferenceStatus.ACTIVE


def _device_preference_view(
    stored: DevicePreference | None,
    inventory: MachineInventorySnapshot,
    server: OllamaDeviceServer,
) -> DevicePreferenceView:
    preference = stored if stored is not None else DevicePreference()
    policy = select_ollama_device_policy(
        inventory,
        preference=_package_preference(preference),
    )
    pending, external = server.device_preference_application()
    choices = tuple(
        DeviceChoiceReport(
            adapter_key=choice.adapter_key,
            name=choice.name,
            classification=choice.classification,
            backend=choice.backend,
            selectable=choice.selectable,
        )
        for choice in selectable_adapters(inventory)
    )
    return DevicePreferenceView(
        mode=preference.mode,
        adapter_key=preference.adapter_key,
        adapter_name=preference.adapter_name,
        status=_preference_status(policy.application, pending=pending, external=external),
        choices=choices,
    )
