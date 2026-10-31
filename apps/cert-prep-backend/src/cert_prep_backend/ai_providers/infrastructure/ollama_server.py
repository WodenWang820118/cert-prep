"""Factory constructing the shared OllamaServerCoordinator from backend settings."""

from __future__ import annotations

from cert_prep_backend.ai_providers.infrastructure.machine_inventory import OllamaMachineInventory
from cert_prep_backend.platform.config import Settings
from cert_prep_ollama.server_coordinator import OllamaServerCoordinator


def ollama_server_coordinator_from_settings(
    settings: Settings,
    machine_inventory: OllamaMachineInventory | None = None,
) -> OllamaServerCoordinator:
    """Build an application-owned OllamaServerCoordinator bound to machine inventory."""
    inventory = machine_inventory or OllamaMachineInventory(settings)
    return OllamaServerCoordinator(
        host=settings.ollama_host,
        inventory_provider=inventory.inventory,
    )


__all__ = ["ollama_server_coordinator_from_settings"]
