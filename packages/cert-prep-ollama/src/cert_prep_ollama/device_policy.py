"""Device selection policy and environment configuration for owned Ollama servers."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
import hashlib
import os
import platform
import re
from typing import TYPE_CHECKING, Literal

from cert_prep_contracts.hardware import (
    MachineAcceleratorSnapshot,
    MachineInventorySnapshot,
)

if TYPE_CHECKING:
    from cert_prep_ollama.server_log import DiscoveredDevice


TargetDeviceKind = Literal["dedicated_gpu", "integrated_gpu", "cpu", "unmanaged"]
BackendKind = Literal["cuda", "rocm", "vulkan", "cpu"]
ResolutionAction = Literal["set", "overridden", "cleared"]

_BASE_CLEARED_VARS: tuple[str, ...] = (
    "ROCR_VISIBLE_DEVICES",
    "GPU_DEVICE_ORDINAL",
    "HSA_OVERRIDE_GFX_VERSION",
    "OLLAMA_LLM_LIBRARY",
)

_ALL_GPU_ENV_VARS: tuple[str, ...] = (
    "CUDA_VISIBLE_DEVICES",
    "HIP_VISIBLE_DEVICES",
    "GGML_VK_VISIBLE_DEVICES",
    "OLLAMA_VULKAN",
    "OLLAMA_IGPU_ENABLE",
)


@dataclass(frozen=True, slots=True)
class OllamaDevicePolicy:
    """Device selection and environment configuration for an Ollama server."""

    target: TargetDeviceKind
    backend: BackendKind | None
    adapter_name: str | None = None
    pci_vendor_id: str | None = None
    pci_device_id: str | None = None
    adapter_luid: str | None = None
    device_id: str | None = None
    pci_bus: str | None = None
    environment: dict[str, str] = field(default_factory=dict)
    cleared: tuple[str, ...] = field(default_factory=tuple)
    reason: str = ""
    # How the caller's preference was applied. Not a log line: callers compare it.
    application: Literal["applied", "adapter_missing", "not_applicable"] = "applied"

    @property
    def name(self) -> str | None:
        """Alias for adapter_name."""
        return self.adapter_name

    @property
    def nvidia_uuid(self) -> str | None:
        """NVIDIA UUID when known and stored in device_id."""
        if self.device_id and self.device_id.startswith("GPU-"):
            return self.device_id
        return None


@dataclass(frozen=True, slots=True)
class EnvironmentResolution:
    """Record of an environment variable change applied for an Ollama server."""

    name: str
    action: ResolutionAction


def normalize_device_name(name: str | None) -> str:
    """Normalize device names for matching across DXGI and Ollama discovery."""
    if not name:
        return ""
    cleaned = re.sub(r"\((?:tm|r)\)", "", name, flags=re.IGNORECASE)
    return " ".join(cleaned.split()).casefold()


_PCI_BUS_PATTERN = re.compile(
    r"^(?:([0-9a-fA-F]+):)?([0-9a-fA-F]+):([0-9a-fA-F]+)\.([0-9a-fA-F]+)$"
)


def parse_pci_bus(value: str | None) -> tuple[int, int, int, int] | None:
    """Parse a PCI bus address into hex components (domain, bus, device, function).

    Supports 'domain:bus:device.function' or 'bus:device.function' (domain defaults to 0).
    Returns None if value cannot be parsed as hexadecimal PCI components.
    """
    if not value:
        return None
    match = _PCI_BUS_PATTERN.match(value.strip())
    if not match:
        return None
    domain_str, bus_str, dev_str, fn_str = match.groups()
    try:
        domain = int(domain_str, 16) if domain_str is not None else 0
        bus = int(bus_str, 16)
        dev = int(dev_str, 16)
        fn = int(fn_str, 16)
        return (domain, bus, dev, fn)
    except ValueError:
        return None


def _is_nvidia_accelerator(acc: MachineAcceleratorSnapshot) -> bool:
    if (acc.pci_vendor_id or "").casefold() == "10de":
        return True
    if (acc.device_id or "").startswith("GPU-"):
        return True
    vendor = (acc.vendor or "").casefold()
    if "nvidia" in vendor:
        return True
    name = acc.name.casefold()
    return "geforce" in name or "nvidia" in name or "rtx" in name


def _is_amd_accelerator(acc: MachineAcceleratorSnapshot) -> bool:
    if (acc.pci_vendor_id or "").casefold() == "1002":
        return True
    vendor = (acc.vendor or "").casefold()
    if "amd" in vendor:
        return True
    name = acc.name.casefold()
    return "radeon" in name or "amd" in name


def _dedicated_gpu_sort_key(acc: MachineAcceleratorSnapshot) -> tuple[int, int, str]:
    mem = acc.dedicated_memory_bytes or 0
    vendor_id = (acc.pci_vendor_id or "").casefold()
    if vendor_id == "10de" or _is_nvidia_accelerator(acc):
        vendor_rank = 0
    elif vendor_id == "1002" or _is_amd_accelerator(acc):
        vendor_rank = 1
    else:
        vendor_rank = 2
    return (-mem, vendor_rank, acc.name)


def _integrated_gpu_sort_key(acc: MachineAcceleratorSnapshot) -> tuple[int, str]:
    mem = (acc.dedicated_memory_bytes or 0) + (acc.shared_memory_bytes or 0)
    return (-mem, acc.name)


@dataclass(frozen=True, slots=True)
class OllamaDevicePreference:
    """User choice of Ollama device. Auto is the default.

    ``adapter_name`` and the PCI ids are the fallback identity used when
    ``adapter_key`` no longer matches, for example after the card moves slots.
    """

    mode: Literal["auto", "cpu", "adapter"] = "auto"
    adapter_key: str | None = None
    adapter_name: str | None = None
    pci_vendor_id: str | None = None
    pci_device_id: str | None = None


USER_CHOSEN_CPU_EXECUTION_WARNING = (
    "The user's device choice is CPU; Ollama requests run on the CPU."
)

AdapterClassification = Literal["integrated", "dedicated", "software", "unknown"]


@dataclass(frozen=True, slots=True)
class SelectableAdapter:
    """One physical GPU the device-choice list may show.

    ``pci_vendor_id`` and ``pci_device_id`` are copied into the stored row.
    They are not part of the HTTP choice.
    """

    adapter_key: str | None
    name: str
    classification: AdapterClassification
    backend: BackendKind | None
    selectable: bool
    pci_vendor_id: str | None = None
    pci_device_id: str | None = None


def _adapter_key_material(adapter: MachineAcceleratorSnapshot) -> str | None:
    """First identity that survives a reboot. The DXGI LUID changes every boot."""

    pnp_id = (adapter.pnp_device_id or "").strip()
    if pnp_id:
        return f"pnp:{pnp_id}"
    device_id = (adapter.device_id or "").strip()
    if device_id.startswith("GPU-"):
        return f"nvidia:{device_id}"
    vendor = (adapter.pci_vendor_id or "").strip().casefold()
    device = (adapter.pci_device_id or "").strip().casefold()
    name = normalize_device_name(adapter.name)
    if vendor and device and name:
        return f"pci:{vendor}:{device}:{name}"
    return None


def adapter_key(adapter: MachineAcceleratorSnapshot) -> str | None:
    """Opaque adapter id: the first 16 hex characters of sha256 of its stable identity."""

    material = _adapter_key_material(adapter)
    if material is None:
        return None
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


def _gpu_accelerators(
    inventory: MachineInventorySnapshot,
) -> list[MachineAcceleratorSnapshot]:
    """Physical GPUs. Software adapters are ignored, as they are for Auto."""

    return [
        acc
        for acc in inventory.accelerators
        if acc.kind.casefold() == "gpu" and acc.classification != "software"
    ]


def _selectable(adapter: MachineAcceleratorSnapshot) -> bool:
    return adapter.classification in ("dedicated", "integrated")


def _pci_ids_match(
    adapter: MachineAcceleratorSnapshot,
    vendor: str | None,
    device: str | None,
) -> bool:
    stored_vendor = (vendor or "").strip().casefold()
    stored_device = (device or "").strip().casefold()
    if not stored_vendor or not stored_device:
        return False
    return (
        (adapter.pci_vendor_id or "").strip().casefold() == stored_vendor
        and (adapter.pci_device_id or "").strip().casefold() == stored_device
    )


def _preferred_adapter(
    inventory: MachineInventorySnapshot,
    preference: OllamaDevicePreference,
) -> MachineAcceleratorSnapshot | None:
    """The one selectable adapter for this preference, or None when it cannot be chosen."""

    gpus = _gpu_accelerators(inventory)
    wanted = (preference.adapter_key or "").strip()
    if wanted:
        keyed = [acc for acc in gpus if adapter_key(acc) == wanted]
        # Two adapters that share a key are both not selectable.
        if len(keyed) > 1:
            return None
        if len(keyed) == 1:
            return keyed[0] if _selectable(keyed[0]) else None
    matched = [
        acc
        for acc in gpus
        if _pci_ids_match(acc, preference.pci_vendor_id, preference.pci_device_id)
    ]
    if len(matched) == 1 and _selectable(matched[0]):
        return matched[0]
    return None


def _accelerator_policy(
    chosen: MachineAcceleratorSnapshot,
    *,
    target: TargetDeviceKind,
    backend: BackendKind,
    environment: dict[str, str],
    reason: str,
) -> OllamaDevicePolicy:
    return OllamaDevicePolicy(
        target=target,
        backend=backend,
        adapter_name=chosen.name,
        pci_vendor_id=chosen.pci_vendor_id,
        pci_device_id=chosen.pci_device_id,
        adapter_luid=chosen.adapter_luid,
        device_id=chosen.device_id,
        environment=environment,
        cleared=_compute_cleared(environment),
        reason=reason,
        application="applied",
    )


def _policy_for_dedicated(chosen: MachineAcceleratorSnapshot) -> OllamaDevicePolicy:
    """Vendor branch for one dedicated GPU. Variable order matches the historical Auto branch."""

    env: dict[str, str] = {}
    if _is_nvidia_accelerator(chosen):
        if chosen.device_id and chosen.device_id.startswith("GPU-"):
            env["CUDA_VISIBLE_DEVICES"] = chosen.device_id
        env["HIP_VISIBLE_DEVICES"] = "-1"
        env["GGML_VK_VISIBLE_DEVICES"] = "-1"
        env["OLLAMA_VULKAN"] = "0"
        env["OLLAMA_IGPU_ENABLE"] = "0"
        reason = f"Dedicated NVIDIA GPU selected for CUDA: {chosen.name}"
        backend: BackendKind = "cuda"
    elif _is_amd_accelerator(chosen):
        env["CUDA_VISIBLE_DEVICES"] = "-1"
        # HIP_VISIBLE_DEVICES unset until discovery
        env["GGML_VK_VISIBLE_DEVICES"] = "-1"
        env["OLLAMA_VULKAN"] = "0"
        env["OLLAMA_IGPU_ENABLE"] = "0"
        reason = f"Dedicated AMD GPU selected for ROCm: {chosen.name}"
        backend = "rocm"
    else:
        env["CUDA_VISIBLE_DEVICES"] = "-1"
        env["HIP_VISIBLE_DEVICES"] = "-1"
        # GGML_VK_VISIBLE_DEVICES unset
        env["OLLAMA_VULKAN"] = "1"
        env["OLLAMA_IGPU_ENABLE"] = "0"
        reason = f"Dedicated GPU selected for Vulkan: {chosen.name}"
        backend = "vulkan"
    return _accelerator_policy(
        chosen,
        target="dedicated_gpu",
        backend=backend,
        environment=env,
        reason=reason,
    )


def _policy_for_integrated(chosen: MachineAcceleratorSnapshot) -> OllamaDevicePolicy:
    """Vulkan with the iGPU enabled. CUDA and HIP are hidden; Vulkan's device is pinned later."""

    env = {
        "CUDA_VISIBLE_DEVICES": "-1",
        "HIP_VISIBLE_DEVICES": "-1",
        "OLLAMA_VULKAN": "1",
        "OLLAMA_IGPU_ENABLE": "1",
    }
    return _accelerator_policy(
        chosen,
        target="integrated_gpu",
        backend="vulkan",
        environment=env,
        reason=f"Integrated GPU selected for Vulkan: {chosen.name}",
    )


def _policy_for_cpu(reason: str) -> OllamaDevicePolicy:
    env = {
        "CUDA_VISIBLE_DEVICES": "-1",
        "HIP_VISIBLE_DEVICES": "-1",
        "GGML_VK_VISIBLE_DEVICES": "-1",
        "OLLAMA_VULKAN": "0",
        "OLLAMA_IGPU_ENABLE": "0",
    }
    return OllamaDevicePolicy(
        target="cpu",
        backend="cpu",
        environment=env,
        cleared=_compute_cleared(env),
        reason=reason,
        application="applied",
    )


def _select_auto_policy(inventory: MachineInventorySnapshot) -> OllamaDevicePolicy:
    """Today's automatic choice. Environment order is the historical branch order."""

    gpu_accelerators = _gpu_accelerators(inventory)
    dedicated_gpus = [acc for acc in gpu_accelerators if acc.classification == "dedicated"]
    unknown_gpus = [
        acc for acc in gpu_accelerators if acc.classification in ("unknown", None)
    ]
    integrated_gpus = [acc for acc in gpu_accelerators if acc.classification == "integrated"]

    # 1. A confirmed dedicated GPU wins over unknown ones
    if dedicated_gpus:
        chosen = sorted(dedicated_gpus, key=_dedicated_gpu_sort_key)[0]
        return _policy_for_dedicated(chosen)

    # 2. No dedicated GPU, but an unknown GPU is present -> unmanaged
    if unknown_gpus:
        return OllamaDevicePolicy(
            target="unmanaged",
            backend=None,
            reason=(
                "Unmanaged Ollama device policy: GPU classification is unknown "
                "and none is dedicated."
            ),
            application="applied",
        )

    # 3. No dedicated GPU, at least one integrated, no unknown/None -> integrated_gpu / vulkan
    if integrated_gpus:
        chosen = sorted(integrated_gpus, key=_integrated_gpu_sort_key)[0]
        return _policy_for_integrated(chosen)

    # 4. No GPU, or only software adapters -> cpu / cpu
    return _policy_for_cpu("CPU mode selected: no physical GPU confirmed in inventory.")


def select_ollama_device_policy(
    inventory: MachineInventorySnapshot | None,
    *,
    platform_name: str | None = None,
    preference: OllamaDevicePreference | None = None,
) -> OllamaDevicePolicy:
    """Choose the Ollama device target and child environment for one inventory.

    ``preference`` defaults to Auto, which is the historical choice. A missing
    or no-longer selectable adapter falls back to that choice and sets
    ``application`` to ``adapter_missing``. Non-Windows and a missing inventory
    stay unmanaged and report ``not_applicable``.
    """

    chosen = preference if preference is not None else OllamaDevicePreference()
    resolved_platform = (
        inventory.platform if inventory is not None else platform_name or platform.system()
    )
    if resolved_platform.casefold() != "windows" or inventory is None:
        return OllamaDevicePolicy(
            target="unmanaged",
            backend=None,
            reason="Unmanaged Ollama device policy: platform is not Windows or inventory is missing.",
            application="not_applicable",
        )
    if chosen.mode == "cpu":
        return _policy_for_cpu("CPU mode selected: the device preference forces CPU.")
    if chosen.mode == "adapter":
        adapter = _preferred_adapter(inventory, chosen)
        if adapter is None:
            return replace(_select_auto_policy(inventory), application="adapter_missing")
        if adapter.classification == "integrated":
            return _policy_for_integrated(adapter)
        return _policy_for_dedicated(adapter)
    return _select_auto_policy(inventory)


def _listed_classification(
    adapter: MachineAcceleratorSnapshot,
) -> AdapterClassification:
    if adapter.classification == "integrated":
        return "integrated"
    if adapter.classification == "dedicated":
        return "dedicated"
    if adapter.classification == "software":
        return "software"
    return "unknown"


def _listed_backend(adapter: MachineAcceleratorSnapshot) -> BackendKind | None:
    """Backend the policy would use for this adapter. Unknown adapters have none."""

    if adapter.classification == "dedicated":
        return _policy_for_dedicated(adapter).backend
    if adapter.classification == "integrated":
        return "vulkan"
    return None


def selectable_adapters(
    inventory: MachineInventorySnapshot | None,
) -> tuple[SelectableAdapter, ...]:
    """Physical GPUs a learner may see, in inventory order.

    Software adapters are omitted, as Auto ignores them. Non-Windows and a
    missing inventory have no choices. An ``unknown`` adapter is listed and
    not selectable. Adapters that share a key are listed and not selectable.
    A missing stable key is not selectable either.
    """

    if inventory is None or inventory.platform.casefold() != "windows":
        return ()
    gpus = _gpu_accelerators(inventory)
    keys = [adapter_key(adapter) for adapter in gpus]
    counts: dict[str, int] = {}
    for key in keys:
        if key is not None:
            counts[key] = counts.get(key, 0) + 1
    listed: list[SelectableAdapter] = []
    for adapter, key in zip(gpus, keys, strict=True):
        listed.append(
            SelectableAdapter(
                adapter_key=key,
                name=adapter.name,
                classification=_listed_classification(adapter),
                backend=_listed_backend(adapter),
                selectable=(
                    _selectable(adapter) and key is not None and counts.get(key, 0) == 1
                ),
                pci_vendor_id=adapter.pci_vendor_id,
                pci_device_id=adapter.pci_device_id,
            )
        )
    return tuple(listed)


def _compute_cleared(env: Mapping[str, str]) -> tuple[str, ...]:
    cleared_list = list(_BASE_CLEARED_VARS)
    for var in _ALL_GPU_ENV_VARS:
        if var not in env and var not in cleared_list:
            cleared_list.append(var)
    return tuple(cleared_list)


def ollama_child_environment(
    base: Mapping[str, str],
    policy: OllamaDevicePolicy | None,
    *,
    case_insensitive: bool = (os.name == "nt"),
) -> tuple[dict[str, str], tuple[EnvironmentResolution, ...]]:
    """Build child environment dictionary and resolution logs for an Ollama server."""
    if policy is None or policy.target == "unmanaged":
        return dict(base), ()

    child_env = dict(base)
    resolutions: list[EnvironmentResolution] = []

    # Map lookup key to actual inherited keys in base
    base_keys_map: dict[str, list[str]] = {}
    for key in base:
        lookup = key.casefold() if case_insensitive else key
        base_keys_map.setdefault(lookup, []).append(key)

    # 1. Process cleared variables
    for var_name in policy.cleared:
        lookup = var_name.casefold() if case_insensitive else var_name
        if lookup in base_keys_map:
            for actual_key in base_keys_map[lookup]:
                child_env.pop(actual_key, None)
            resolutions.append(EnvironmentResolution(name=var_name, action="cleared"))

    # 2. Process variables to set
    for var_name, value in policy.environment.items():
        lookup = var_name.casefold() if case_insensitive else var_name
        if lookup in base_keys_map:
            for actual_key in base_keys_map[lookup]:
                child_env.pop(actual_key, None)
            child_env[var_name] = str(value)
            resolutions.append(EnvironmentResolution(name=var_name, action="overridden"))
        else:
            child_env[var_name] = str(value)
            resolutions.append(EnvironmentResolution(name=var_name, action="set"))

    return child_env, tuple(resolutions)


def corrected_device_policy(
    policy: OllamaDevicePolicy | None,
    discovered_devices: Sequence[DiscoveredDevice],
) -> OllamaDevicePolicy | None:
    """Build a one-time corrective device policy from discovered device logs."""
    if policy is None or policy.backend not in ("cuda", "rocm", "vulkan") or not policy.adapter_name:
        return None

    normalized_target_name = normalize_device_name(policy.adapter_name)

    candidates: list[DiscoveredDevice] = []
    for rec in discovered_devices:
        if rec.library.casefold() != policy.backend.casefold():
            continue
        if normalize_device_name(rec.description) != normalized_target_name:
            continue
        if policy.pci_bus and rec.pci_id:
            parsed_policy_pci = parse_pci_bus(policy.pci_bus)
            parsed_rec_pci = parse_pci_bus(rec.pci_id)
            if parsed_policy_pci is not None and parsed_rec_pci is not None:
                if parsed_policy_pci != parsed_rec_pci:
                    continue
            elif policy.pci_bus.casefold() != rec.pci_id.casefold():
                continue
        candidates.append(rec)

    if len(candidates) != 1:
        return None

    matched = candidates[0]

    # Find the library directory token other than 'ollama'
    lib_token: str | None = None
    for directory in matched.libdirs:
        if directory.strip().casefold() != "ollama":
            lib_token = directory.strip()
            break
    if not lib_token:
        lib_token = policy.backend.casefold()

    new_env: dict[str, str] = dict(policy.environment)
    new_env["OLLAMA_LLM_LIBRARY"] = lib_token

    filter_id_str = (
        str(matched.filter_id) if matched.filter_id is not None else str(matched.id)
    )

    if policy.backend == "cuda":
        cuda_id = policy.nvidia_uuid if policy.nvidia_uuid else filter_id_str
        new_env["CUDA_VISIBLE_DEVICES"] = cuda_id
        new_env["HIP_VISIBLE_DEVICES"] = "-1"
        new_env["GGML_VK_VISIBLE_DEVICES"] = "-1"
        new_env["OLLAMA_VULKAN"] = "0"
        new_env["OLLAMA_IGPU_ENABLE"] = "0"
    elif policy.backend == "rocm":
        new_env["CUDA_VISIBLE_DEVICES"] = "-1"
        new_env["HIP_VISIBLE_DEVICES"] = filter_id_str
        new_env["GGML_VK_VISIBLE_DEVICES"] = "-1"
        new_env["OLLAMA_VULKAN"] = "0"
        new_env["OLLAMA_IGPU_ENABLE"] = "0"
    elif policy.backend == "vulkan":
        new_env["CUDA_VISIBLE_DEVICES"] = "-1"
        new_env["HIP_VISIBLE_DEVICES"] = "-1"
        new_env["GGML_VK_VISIBLE_DEVICES"] = filter_id_str
        new_env["OLLAMA_VULKAN"] = "1"
        new_env["OLLAMA_IGPU_ENABLE"] = (
            "1" if policy.target == "integrated_gpu" else "0"
        )

    # Base cleared variables (excluding OLLAMA_LLM_LIBRARY since it's now explicitly set)
    cleared = (
        "ROCR_VISIBLE_DEVICES",
        "GPU_DEVICE_ORDINAL",
        "HSA_OVERRIDE_GFX_VERSION",
    )

    return OllamaDevicePolicy(
        target=policy.target,
        backend=policy.backend,
        adapter_name=policy.adapter_name,
        pci_vendor_id=policy.pci_vendor_id,
        pci_device_id=policy.pci_device_id,
        adapter_luid=policy.adapter_luid,
        device_id=policy.device_id,
        pci_bus=matched.pci_id or policy.pci_bus,
        environment=new_env,
        cleared=cleared,
        application=policy.application,
        reason=(
            f"Corrected from Ollama discovery: {policy.backend} on {matched.name} "
            f"(filter_id={matched.filter_id}, lib={lib_token})"
        ),
    )


__all__ = [
    "EnvironmentResolution",
    "OllamaDevicePolicy",
    "OllamaDevicePreference",
    "SelectableAdapter",
    "USER_CHOSEN_CPU_EXECUTION_WARNING",
    "adapter_key",
    "corrected_device_policy",
    "normalize_device_name",
    "ollama_child_environment",
    "parse_pci_bus",
    "selectable_adapters",
    "select_ollama_device_policy",
]
