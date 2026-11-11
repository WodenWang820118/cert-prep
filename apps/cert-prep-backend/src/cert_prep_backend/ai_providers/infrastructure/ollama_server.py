"""Factory constructing the shared OllamaServerCoordinator from backend settings."""

from __future__ import annotations

from cert_prep_backend.ai_providers.application.ports import DevicePreferenceRepository
from cert_prep_backend.ai_providers.domain.preference import (
    DevicePreference,
    DevicePreferenceMode,
)
from cert_prep_backend.ai_providers.infrastructure.machine_inventory import OllamaMachineInventory
from cert_prep_backend.platform.config import Settings
from cert_prep_ollama.device_policy import OllamaDevicePreference
from cert_prep_ollama.server_coordinator import OllamaServerCoordinator


def _stored_ollama_preference(repository: DevicePreferenceRepository) -> OllamaDevicePreference:
    """Map the stored row onto the package preference. No row is Auto."""

    stored = repository.load()
    if stored is None or stored.mode is DevicePreferenceMode.AUTO:
        return OllamaDevicePreference()
    if stored.mode is DevicePreferenceMode.CPU:
        return OllamaDevicePreference(mode="cpu")
    return _adapter_preference(stored)


def _adapter_preference(stored: DevicePreference) -> OllamaDevicePreference:
    return OllamaDevicePreference(
        mode="adapter",
        adapter_key=stored.adapter_key,
        adapter_name=stored.adapter_name,
        pci_vendor_id=stored.pci_vendor_id,
        pci_device_id=stored.pci_device_id,
    )


def ollama_server_coordinator_from_settings(
    settings: Settings,
    machine_inventory: OllamaMachineInventory | None = None,
    *,
    preferences: DevicePreferenceRepository,
) -> OllamaServerCoordinator:
    """Build an application-owned OllamaServerCoordinator bound to machine inventory.

    Every owned start reads the stored choice. No row is Auto.
    """

    inventory = machine_inventory or OllamaMachineInventory(settings)
    return OllamaServerCoordinator(
        host=settings.ollama_host,
        inventory_provider=inventory.inventory,
        preference_provider=lambda: _stored_ollama_preference(preferences),
    )


__all__ = ["ollama_server_coordinator_from_settings"]
