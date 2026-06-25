"""Shared machine inventory value types."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class MachineCpuSnapshot:
    """Best-effort CPU details captured before selecting a local model."""

    architecture: str
    name: str | None = None
    physical_cores: int | None = None
    logical_cores: int | None = None


@dataclass(frozen=True, slots=True)
class MachineRamSnapshot:
    """Best-effort RAM details captured before selecting a local model."""

    total_bytes: int | None = None
    available_bytes: int | None = None


@dataclass(frozen=True, slots=True)
class MachineStorageSnapshot:
    """Disk capacity details for the path where local models are expected."""

    path: str
    free_bytes: int | None = None
    total_bytes: int | None = None


@dataclass(frozen=True, slots=True)
class MachineAcceleratorSnapshot:
    """GPU/NPU capability metadata.

    Accelerators are diagnostic inventory only for this slice; they do not imply
    Ollama acceleration.
    """

    kind: str
    name: str
    vendor: str | None = None
    memory_bytes: int | None = None
    driver_version: str | None = None
    device_id: str | None = None


@dataclass(frozen=True, slots=True)
class MachineInventorySnapshot:
    """Best-effort local machine inventory used by model profile selection."""

    platform: str
    platform_version: str
    architecture: str
    cpu: MachineCpuSnapshot
    ram: MachineRamSnapshot
    storage: MachineStorageSnapshot
    accelerators: tuple[MachineAcceleratorSnapshot, ...] = field(default_factory=tuple)
    warnings: tuple[str, ...] = field(default_factory=tuple)
    schema_version: int = 1


__all__ = [
    "MachineAcceleratorSnapshot",
    "MachineCpuSnapshot",
    "MachineInventorySnapshot",
    "MachineRamSnapshot",
    "MachineStorageSnapshot",
]
