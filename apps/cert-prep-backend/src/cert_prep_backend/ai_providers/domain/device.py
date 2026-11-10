"""The device an Ollama health check is allowed to report.

These names are the health contract. The server log's monotonic clock and the
English verification sentence stay inside the Ollama package.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class OllamaServerOwnership(StrEnum):
    """Who is running the Ollama server this health check saw."""

    OWNED = "owned"
    EXTERNAL = "external"
    NOT_RUNNING = "not_running"


class DeviceTarget(StrEnum):
    """Execution target the device policy asked for."""

    DEDICATED_GPU = "dedicated_gpu"
    INTEGRATED_GPU = "integrated_gpu"
    CPU = "cpu"
    UNMANAGED = "unmanaged"


class DeviceBackend(StrEnum):
    """Compute backend, normalized from an Ollama library label such as CUDA0."""

    CUDA = "cuda"
    ROCM = "rocm"
    VULKAN = "vulkan"
    CPU = "cpu"


class DeviceVerification(StrEnum):
    """Whether the loaded device matches the policy."""

    PENDING = "pending"
    VERIFIED = "verified"
    MISMATCH = "mismatch"
    UNKNOWN = "unknown"
    NOT_OBSERVABLE = "not_observable"


@dataclass(frozen=True, slots=True)
class RequestedDevice:
    """Policy target, backend and adapter name reported with health."""

    target: DeviceTarget
    backend: DeviceBackend | None = None
    adapter_name: str | None = None


@dataclass(frozen=True, slots=True)
class ObservedDevice:
    """Backend, adapter and layer counts taken from the server log."""

    backend: DeviceBackend | None = None
    adapter_name: str | None = None
    offloaded_layers: int | None = None
    total_layers: int | None = None


@dataclass(frozen=True, slots=True)
class OllamaDeviceStatus:
    """Device section of one Ollama health result."""

    server: OllamaServerOwnership
    requested: RequestedDevice | None
    verification: DeviceVerification
    observed: ObservedDevice | None
    corrective_restarts: int


__all__ = [
    "DeviceBackend",
    "DeviceTarget",
    "DeviceVerification",
    "ObservedDevice",
    "OllamaDeviceStatus",
    "OllamaServerOwnership",
    "RequestedDevice",
]
