"""One consistent device snapshot for health.

The coordinator's policy, pending flag, restart count and last execution disagree
right after a corrective restart: the stored execution is still the previous
mismatch, and its own restart count is still 0. Health must not read those fields
one by one.
"""

from __future__ import annotations

from dataclasses import dataclass

from cert_prep_ollama.device_policy import OllamaDevicePolicy
from cert_prep_ollama.device_verification import DeviceExecution

_BACKEND_PREFIXES: tuple[tuple[str, str], ...] = (
    ("cuda", "cuda"),
    ("rocm", "rocm"),
    ("hip", "rocm"),
    ("vulkan", "vulkan"),
    ("cpu", "cpu"),
)


@dataclass(frozen=True, slots=True)
class RequestedDeviceSnapshot:
    """Policy target health is allowed to show. Environment variables stay internal."""

    target: str
    backend: str | None
    adapter_name: str | None


@dataclass(frozen=True, slots=True)
class ObservedDeviceSnapshot:
    """Device the server log showed. The monotonic clock and English detail are omitted."""

    backend: str | None
    adapter_name: str | None
    offloaded_layers: int | None
    total_layers: int | None


@dataclass(frozen=True, slots=True)
class DeviceStatus:
    """Locked view of who runs Ollama and which device the last load used."""

    server: str
    requested: RequestedDeviceSnapshot | None
    verification: str
    observed: ObservedDeviceSnapshot | None
    corrective_restarts: int


def normalize_observed_backend(library: str | None) -> str | None:
    """Map an Ollama library label such as ``CUDA0`` onto cuda, rocm, vulkan or cpu."""

    if library is None:
        return None
    folded = library.strip().casefold()
    if not folded:
        return None
    for prefix, backend in _BACKEND_PREFIXES:
        if folded.startswith(prefix):
            return backend
    return None


def build_device_status(
    *,
    local_host: bool,
    ownership: str,
    owns_live_process: bool,
    policy: OllamaDevicePolicy | None,
    verification_pending: bool,
    restarts: int,
    execution: DeviceExecution | None,
) -> DeviceStatus:
    """Build the health snapshot from one consistent set of coordinator fields."""

    if not local_host or ownership == "external":
        return _unobserved("external")
    if ownership != "owned" or not owns_live_process:
        return _unobserved("not_running")

    requested = _requested(policy)
    observed = _observed(execution)
    # Unmanaged never verifies. The unknown state leaves verification pending so
    # the next load is read again, but a log that already names a device is evidence.
    if policy is not None and policy.target == "unmanaged" and observed is not None:
        return DeviceStatus(
            server="owned",
            requested=requested,
            verification="unknown",
            observed=observed,
            corrective_restarts=restarts,
        )
    # Pending hides the stored execution. Right after a corrective restart that
    # record is still the old mismatch, with a restart count of 0.
    if (
        verification_pending
        or execution is None
        or execution.state in ("selected_unverified", "unknown")
    ):
        return DeviceStatus(
            server="owned",
            requested=requested,
            verification="pending",
            observed=None,
            corrective_restarts=restarts,
        )
    if execution.state == "verified":
        verification = "verified"
    elif execution.state == "mismatch":
        verification = "mismatch"
    else:
        verification = "unknown"
    return DeviceStatus(
        server="owned",
        requested=requested,
        verification=verification,
        observed=observed,
        corrective_restarts=restarts,
    )


def _unobserved(server: str) -> DeviceStatus:
    return DeviceStatus(
        server=server,
        requested=None,
        verification="not_observable",
        observed=None,
        corrective_restarts=0,
    )


def _requested(policy: OllamaDevicePolicy | None) -> RequestedDeviceSnapshot | None:
    if policy is None:
        return None
    return RequestedDeviceSnapshot(
        target=policy.target,
        backend=policy.backend,
        adapter_name=policy.adapter_name,
    )


def _observed(execution: DeviceExecution | None) -> ObservedDeviceSnapshot | None:
    if execution is None:
        return None
    backend = normalize_observed_backend(execution.observed_library)
    adapter_name = execution.observed_description or None
    offloaded = execution.offloaded_layers
    total = execution.total_layers
    if backend is None and adapter_name is None and offloaded is None and total is None:
        return None
    return ObservedDeviceSnapshot(
        backend=backend,
        adapter_name=adapter_name,
        offloaded_layers=offloaded,
        total_layers=total,
    )


__all__ = [
    "DeviceStatus",
    "ObservedDeviceSnapshot",
    "RequestedDeviceSnapshot",
    "build_device_status",
    "normalize_observed_backend",
]
