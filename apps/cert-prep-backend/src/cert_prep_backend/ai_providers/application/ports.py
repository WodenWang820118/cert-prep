"""What the AI Providers use cases need from outside: the machine and the stored device choice."""

from __future__ import annotations

from typing import Protocol

from cert_prep_backend.ai_providers.domain.preference import DevicePreference
from cert_prep_contracts.hardware import MachineInventorySnapshot
from cert_prep_ollama.device_policy import OllamaDevicePreference


class MachineInventory(Protocol):
    """The CPU, memory, storage and accelerators of this machine, measured when asked for."""

    def inventory(self, *, refresh: bool = False) -> MachineInventorySnapshot:
        """Return the inventory; a recent one may be reused unless ``refresh`` is set."""
        pass


class DevicePreferenceRepository(Protocol):
    """The single stored Ollama device choice. No row means Auto."""

    def load(self) -> DevicePreference | None:
        """Return the stored choice, or None when the learner has never chosen."""
        pass

    def save(self, preference: DevicePreference) -> None:
        """Replace the stored choice."""
        pass


class OllamaDeviceServer(Protocol):
    """The owned Ollama server the device choice is applied to."""

    def apply_device_preference(self, preference: OllamaDevicePreference) -> None:
        """Ask for the stored choice ``preference`` to be applied.

        Returns at once, without I/O and without waiting for a restart. A live
        owned server is switched on the coordinator's own thread once nothing
        is using it.
        """
        pass

    def device_preference_application(self) -> tuple[bool, bool]:
        """``(switch_pending, external_server)`` for the preference status. Never waits.

        ``switch_pending`` is a switch that has not finished, including one
        whose start failed. ``external_server`` is a non-local host or a server
        this process does not own.
        """
        pass
