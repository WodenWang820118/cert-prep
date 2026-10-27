"""What the AI Providers use cases need from outside: the machine they run on."""

from __future__ import annotations

from typing import Protocol

from cert_prep_contracts.hardware import MachineInventorySnapshot


class MachineInventory(Protocol):
    """The CPU, memory, storage and accelerators of this machine, measured when asked for."""

    def inventory(self, *, refresh: bool = False) -> MachineInventorySnapshot:
        """Return the inventory; a recent one may be reused unless ``refresh`` is set."""
        pass
