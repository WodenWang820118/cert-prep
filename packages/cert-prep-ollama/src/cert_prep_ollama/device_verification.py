"""Device execution verification against selected device policies."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
import time
from typing import Literal

from cert_prep_ollama.device_policy import (
    OllamaDevicePolicy,
    normalize_device_name,
    parse_pci_bus,
)
from cert_prep_ollama.server_log import (
    BackendLoaded,
    DiscoveredDevice,
    LayerOffload,
    RunnerDevice,
    SchedulerSelection,
)

VerificationState = Literal["verified", "mismatch", "selected_unverified", "unknown"]
ServerOwnership = Literal["owned", "external", "none"]


@dataclass(frozen=True, slots=True)
class DeviceExecution:
    """Observed runtime device execution details and verification status."""

    target: str
    backend: str | None
    adapter_name: str | None
    observed_library: str | None
    observed_description: str | None
    observed_pci_bus: str | None
    offloaded_layers: int | None
    total_layers: int | None
    state: VerificationState
    detail: str
    ownership: ServerOwnership
    restarts: int = 0
    observed_at: float = field(default_factory=time.time)


def verify_device_execution(
    policy: OllamaDevicePolicy,
    load_records: Sequence[object],
    discovered: Sequence[DiscoveredDevice],
    *,
    ownership: ServerOwnership = "owned",
    restarts: int = 0,
    clock: Callable[[], float] | None = None,
) -> DeviceExecution:
    """Verify whether Ollama executed on the device and backend requested by policy."""
    now = clock() if clock is not None else time.time()

    # Extract relevant evidence records from load_records
    runner_device: RunnerDevice | None = None
    backend_loaded: BackendLoaded | None = None
    layer_offload: LayerOffload | None = None
    scheduler_selection: SchedulerSelection | None = None

    for rec in load_records:
        if isinstance(rec, RunnerDevice):
            runner_device = rec
        elif isinstance(rec, BackendLoaded):
            # Prefer non-CPU backend if present
            if backend_loaded is None or backend_loaded.library.upper() == "CPU":
                backend_loaded = rec
        elif isinstance(rec, LayerOffload):
            layer_offload = rec
        elif isinstance(rec, SchedulerSelection):
            scheduler_selection = rec

    offloaded_layers = layer_offload.offloaded_layers if layer_offload else None
    total_layers = layer_offload.total_layers if layer_offload else None

    # Case 1: unmanaged policy or no evidence at all
    if policy.target == "unmanaged" or (not load_records and not discovered):
        return DeviceExecution(
            target=policy.target,
            backend=policy.backend,
            adapter_name=policy.adapter_name,
            observed_library=None,
            observed_description=None,
            observed_pci_bus=None,
            offloaded_layers=offloaded_layers,
            total_layers=total_layers,
            state="unknown",
            detail="No device verification evidence or unmanaged policy.",
            ownership=ownership,
            restarts=restarts,
            observed_at=now,
        )

    # Case 2: CPU target requested
    if policy.target == "cpu":
        if layer_offload is not None and layer_offload.offloaded_layers > 0:
            obs_lib = runner_device.device_name if runner_device else (
                backend_loaded.library if backend_loaded else "GPU"
            )
            return DeviceExecution(
                target=policy.target,
                backend=policy.backend,
                adapter_name=policy.adapter_name,
                observed_library=obs_lib,
                observed_description=runner_device.description if runner_device else None,
                observed_pci_bus=runner_device.pci_bus if runner_device else None,
                offloaded_layers=offloaded_layers,
                total_layers=total_layers,
                state="mismatch",
                detail=(
                    f"CPU target requested, but {layer_offload.offloaded_layers}/"
                    f"{layer_offload.total_layers} layers offloaded to GPU."
                ),
                ownership=ownership,
                restarts=restarts,
                observed_at=now,
            )

        if runner_device is not None:
            return DeviceExecution(
                target=policy.target,
                backend=policy.backend,
                adapter_name=policy.adapter_name,
                observed_library=runner_device.device_name,
                observed_description=runner_device.description,
                observed_pci_bus=runner_device.pci_bus,
                offloaded_layers=offloaded_layers,
                total_layers=total_layers,
                state="mismatch",
                detail=f"CPU target requested, but runner device active: {runner_device.device_name}.",
                ownership=ownership,
                restarts=restarts,
                observed_at=now,
            )

        if backend_loaded is not None and backend_loaded.library.upper() != "CPU":
            return DeviceExecution(
                target=policy.target,
                backend=policy.backend,
                adapter_name=policy.adapter_name,
                observed_library=backend_loaded.library,
                observed_description=None,
                observed_pci_bus=None,
                offloaded_layers=offloaded_layers,
                total_layers=total_layers,
                state="mismatch",
                detail=f"CPU target requested, but GPU backend loaded: {backend_loaded.library}.",
                ownership=ownership,
                restarts=restarts,
                observed_at=now,
            )

        if backend_loaded is not None and backend_loaded.library.upper() == "CPU":
            return DeviceExecution(
                target=policy.target,
                backend=policy.backend,
                adapter_name=policy.adapter_name,
                observed_library="CPU",
                observed_description=None,
                observed_pci_bus=None,
                offloaded_layers=offloaded_layers,
                total_layers=total_layers,
                state="verified",
                detail="CPU execution verified: CPU backend loaded with no GPU offload.",
                ownership=ownership,
                restarts=restarts,
                observed_at=now,
            )

        # Check if CPU was discovered
        has_cpu_discovered = any(d.library.lower() == "cpu" for d in discovered)
        if has_cpu_discovered:
            return DeviceExecution(
                target=policy.target,
                backend=policy.backend,
                adapter_name=policy.adapter_name,
                observed_library=None,
                observed_description=None,
                observed_pci_bus=None,
                offloaded_layers=offloaded_layers,
                total_layers=total_layers,
                state="selected_unverified",
                detail="CPU discovered; awaiting model runner confirmation.",
                ownership=ownership,
                restarts=restarts,
                observed_at=now,
            )

        return DeviceExecution(
            target=policy.target,
            backend=policy.backend,
            adapter_name=policy.adapter_name,
            observed_library=None,
            observed_description=None,
            observed_pci_bus=None,
            offloaded_layers=offloaded_layers,
            total_layers=total_layers,
            state="unknown",
            detail="No CPU execution evidence.",
            ownership=ownership,
            restarts=restarts,
            observed_at=now,
        )

    # Case 3: GPU target requested (dedicated_gpu or integrated_gpu)
    if runner_device is not None:
        obs_lib = runner_device.device_name
        obs_desc = runner_device.description
        obs_pci = runner_device.pci_bus

        # Match library:
        lib_match = False
        if policy.backend:
            dev_upper = runner_device.device_name.upper()
            backend_upper = policy.backend.upper()
            lib_match = backend_upper in dev_upper or dev_upper.startswith(backend_upper)

        # Match description:
        desc_match = (
            normalize_device_name(runner_device.description)
            == normalize_device_name(policy.adapter_name)
        )

        # Match PCI bus if both have one:
        pci_match = True
        if policy.pci_bus and runner_device.pci_bus:
            parsed_policy_pci = parse_pci_bus(policy.pci_bus)
            parsed_runner_pci = parse_pci_bus(runner_device.pci_bus)
            if parsed_policy_pci is not None and parsed_runner_pci is not None:
                pci_match = (parsed_policy_pci == parsed_runner_pci)
            else:
                pci_match = (policy.pci_bus.casefold() == runner_device.pci_bus.casefold())

        if lib_match and desc_match and pci_match:
            if layer_offload is not None and layer_offload.offloaded_layers == 0:
                state: VerificationState = "mismatch"
                detail = "No layers were offloaded to the GPU, so the model runs on the CPU."
            else:
                state = "verified"
                detail = (
                    f"Verified execution on {runner_device.description} ({runner_device.device_name}) "
                    f"with {offloaded_layers or 0}/{total_layers or 0} layers offloaded."
                )
        else:
            state = "mismatch"
            detail = (
                f"Mismatch: expected {policy.backend} on {policy.adapter_name}, "
                f"observed {runner_device.device_name} ({runner_device.description})."
            )

        return DeviceExecution(
            target=policy.target,
            backend=policy.backend,
            adapter_name=policy.adapter_name,
            observed_library=obs_lib,
            observed_description=obs_desc,
            observed_pci_bus=obs_pci,
            offloaded_layers=offloaded_layers,
            total_layers=total_layers,
            state=state,
            detail=detail,
            ownership=ownership,
            restarts=restarts,
            observed_at=now,
        )

    if backend_loaded is not None:
        obs_lib = backend_loaded.library
        if policy.backend and backend_loaded.library.casefold() == policy.backend.casefold():
            if layer_offload is not None and layer_offload.offloaded_layers == 0:
                state = "mismatch"
                detail = "No layers were offloaded to the GPU, so the model runs on the CPU."
            else:
                state = "verified"
                detail = f"Verified backend loaded: {backend_loaded.library} ({backend_loaded.token})."
        else:
            state = "mismatch"
            detail = f"Mismatch: expected backend {policy.backend}, loaded {backend_loaded.library}."

        return DeviceExecution(
            target=policy.target,
            backend=policy.backend,
            adapter_name=policy.adapter_name,
            observed_library=obs_lib,
            observed_description=None,
            observed_pci_bus=None,
            offloaded_layers=offloaded_layers,
            total_layers=total_layers,
            state=state,
            detail=detail,
            ownership=ownership,
            restarts=restarts,
            observed_at=now,
        )

    if scheduler_selection is not None:
        obs_lib = scheduler_selection.library
        obs_desc = scheduler_selection.description
        lib_match = (
            policy.backend is not None
            and scheduler_selection.library.casefold() == policy.backend.casefold()
        )
        desc_match = (
            normalize_device_name(scheduler_selection.description)
            == normalize_device_name(policy.adapter_name)
        )
        if lib_match and desc_match:
            state = "selected_unverified"
            detail = (
                f"Device selected by scheduler: {scheduler_selection.description}; "
                "awaiting runner load."
            )
        else:
            state = "mismatch"
            detail = (
                f"Mismatch: scheduler selected {scheduler_selection.name} "
                f"({scheduler_selection.description}) instead of target {policy.adapter_name}."
            )

        return DeviceExecution(
            target=policy.target,
            backend=policy.backend,
            adapter_name=policy.adapter_name,
            observed_library=obs_lib,
            observed_description=obs_desc,
            observed_pci_bus=None,
            offloaded_layers=offloaded_layers,
            total_layers=total_layers,
            state=state,
            detail=detail,
            ownership=ownership,
            restarts=restarts,
            observed_at=now,
        )

    if discovered:
        return DeviceExecution(
            target=policy.target,
            backend=policy.backend,
            adapter_name=policy.adapter_name,
            observed_library=None,
            observed_description=None,
            observed_pci_bus=None,
            offloaded_layers=offloaded_layers,
            total_layers=total_layers,
            state="selected_unverified",
            detail="Target device discovered; awaiting runner execution.",
            ownership=ownership,
            restarts=restarts,
            observed_at=now,
        )

    return DeviceExecution(
        target=policy.target,
        backend=policy.backend,
        adapter_name=policy.adapter_name,
        observed_library=None,
        observed_description=None,
        observed_pci_bus=None,
        offloaded_layers=offloaded_layers,
        total_layers=total_layers,
        state="unknown",
        detail="No runner, backend, or scheduler evidence.",
        ownership=ownership,
        restarts=restarts,
        observed_at=now,
    )


__all__ = [
    "DeviceExecution",
    "ServerOwnership",
    "VerificationState",
    "verify_device_execution",
]
