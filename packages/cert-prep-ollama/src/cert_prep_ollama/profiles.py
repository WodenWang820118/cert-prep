"""Ollama profile catalog and machine-aware selection policy."""

from __future__ import annotations

from collections.abc import Iterable, Sequence
import platform

from cert_prep_contracts.hardware import MachineInventorySnapshot
from cert_prep_contracts.llm import LLMExecutionMode, LLMExecutionPolicy
from cert_prep_contracts.llm_profiles import (
    OllamaModelProfile,
    OllamaProfileSelection,
    OllamaProfileSupportStatus,
)
from cert_prep_ollama.modelfiles import DEFAULT_CERT_PREP_SYSTEM_PROMPT, modelfile_sha256


GIB = 1024 * 1024 * 1024
AUTO_PROFILE_ID = "auto"
DEFAULT_PROFILE_ID = "qwen3.5-4b-study-8k"
WINDOWS_CPU_EXECUTION_WARNING = (
    "Windows accelerator inventory did not confirm a GPU; "
    "Ollama is running in forced CPU mode."
)

DEFAULT_OLLAMA_PROFILES: tuple[OllamaModelProfile, ...] = (
    OllamaModelProfile.from_mapping(
        profile_id=DEFAULT_PROFILE_ID,
        display_name="Qwen 3.5 4B Study 8K",
        base_model="qwen3.5:4b",
        local_model="cert-prep-qwen3.5-4b-study-8k",
        context_window=8192,
        system_prompt=DEFAULT_CERT_PREP_SYSTEM_PROMPT,
        parameters={"temperature": 0, "num_predict": 4096},
        min_total_ram_bytes=8 * GIB,
        min_available_ram_bytes=4 * GIB,
        min_free_disk_bytes=8 * GIB,
        description="Default local study profile for OCR-to-question workflows.",
    ),
)


def profile_catalog() -> tuple[OllamaModelProfile, ...]:
    """Return the fixed cert-prep Ollama profile catalog."""

    return DEFAULT_OLLAMA_PROFILES


def profile_by_id(
    profile_id: str,
    *,
    catalog: Sequence[OllamaModelProfile] = DEFAULT_OLLAMA_PROFILES,
) -> OllamaModelProfile:
    """Return a profile from the catalog by id."""

    normalized = profile_id.strip()
    for profile in catalog:
        if profile.profile_id == normalized:
            return profile
    raise ValueError(f"Unknown Ollama profile id: {profile_id}")


def select_ollama_execution_policy(
    inventory: MachineInventorySnapshot | None,
    *,
    platform_name: str | None = None,
) -> LLMExecutionPolicy:
    """Choose a conservative execution mode without claiming GPU use."""

    resolved_platform = (
        inventory.platform if inventory is not None else platform_name or platform.system()
    )
    if resolved_platform.casefold() != "windows":
        return LLMExecutionPolicy()
    if inventory is not None and any(
        accelerator.kind.casefold() == "gpu"
        for accelerator in inventory.accelerators
    ):
        return LLMExecutionPolicy()
    return LLMExecutionPolicy(
        mode=LLMExecutionMode.CPU,
        warning=WINDOWS_CPU_EXECUTION_WARNING,
    )


def select_ollama_profile(
    inventory: MachineInventorySnapshot | None,
    *,
    profile_id: str = AUTO_PROFILE_ID,
    catalog: Sequence[OllamaModelProfile] = DEFAULT_OLLAMA_PROFILES,
) -> OllamaProfileSelection:
    """Select an Ollama profile for a machine snapshot."""

    normalized_id = (profile_id or "").strip() or AUTO_PROFILE_ID
    if normalized_id == AUTO_PROFILE_ID:
        return _auto_selection(inventory, catalog)

    profile = profile_by_id(normalized_id, catalog=catalog)
    requirement_warnings = profile_requirement_warnings(profile, inventory)
    status = (
        OllamaProfileSupportStatus.SUPPORTED
        if not requirement_warnings
        else OllamaProfileSupportStatus.WARNING
    )
    reason = f"Explicit fixed Ollama profile {profile.profile_id} selected."
    return _selection(
        profile,
        catalog=catalog,
        inventory=inventory,
        support_status=status,
        reason=reason,
        warnings=requirement_warnings,
    )


def profile_requirement_warnings(
    profile: OllamaModelProfile,
    inventory: MachineInventorySnapshot | None,
) -> tuple[str, ...]:
    """Return profile requirement warnings for a snapshot without rejecting selection."""

    if inventory is None:
        return ("Machine inventory is unavailable; using conservative defaults.",)

    warnings = list(inventory.warnings)
    ram_total = inventory.ram.total_bytes
    ram_available = inventory.ram.available_bytes
    disk_free = inventory.storage.free_bytes
    vram = _max_accelerator_memory(inventory)

    if profile.min_total_ram_bytes is not None:
        if ram_total is None:
            warnings.append("Total RAM is unknown.")
        elif ram_total < profile.min_total_ram_bytes:
            warnings.append(
                f"Total RAM is below {profile.profile_id} requirement "
                f"({ram_total} < {profile.min_total_ram_bytes})."
            )
    if profile.min_available_ram_bytes is not None:
        if ram_available is None:
            warnings.append("Available RAM is unknown.")
        elif ram_available < profile.min_available_ram_bytes:
            warnings.append(
                f"Available RAM is below {profile.profile_id} requirement "
                f"({ram_available} < {profile.min_available_ram_bytes})."
            )
    if profile.min_free_disk_bytes is not None:
        if disk_free is None:
            warnings.append("Free disk space is unknown.")
        elif disk_free < profile.min_free_disk_bytes:
            warnings.append(
                f"Free disk space is below {profile.profile_id} requirement "
                f"({disk_free} < {profile.min_free_disk_bytes})."
            )
    if profile.min_vram_bytes is not None:
        if vram is None:
            warnings.append("Accelerator memory is unknown.")
        elif vram < profile.min_vram_bytes:
            warnings.append(
                f"Accelerator memory is below {profile.profile_id} target "
                f"({vram} < {profile.min_vram_bytes})."
            )
    return tuple(dict.fromkeys(warnings))


def fallback_models_for_selection(selection: OllamaProfileSelection) -> tuple[str, ...]:
    """Return local model names for a profile selection's fallback profiles."""

    return tuple(profile.local_model for profile in selection.fallback_profiles)


def _auto_selection(
    inventory: MachineInventorySnapshot | None,
    catalog: Sequence[OllamaModelProfile],
) -> OllamaProfileSelection:
    profile = profile_by_id(DEFAULT_PROFILE_ID, catalog=catalog)
    if inventory is None:
        return _selection(
            profile,
            catalog=catalog,
            inventory=inventory,
            support_status=OllamaProfileSupportStatus.WARNING,
            reason="Auto profile used the default 4B profile because inventory is unavailable.",
            warnings=("Machine inventory is unavailable; using default 4B profile.",),
        )

    warnings = profile_requirement_warnings(profile, inventory)
    return _selection(
        profile,
        catalog=catalog,
        inventory=inventory,
        support_status=(
            OllamaProfileSupportStatus.WARNING
            if warnings
            else OllamaProfileSupportStatus.SUPPORTED
        ),
        reason="Auto profile selected the fixed 4B profile.",
        warnings=warnings,
    )


def _selection(
    profile: OllamaModelProfile,
    *,
    catalog: Sequence[OllamaModelProfile],
    inventory: MachineInventorySnapshot | None,
    support_status: OllamaProfileSupportStatus,
    reason: str,
    warnings: Iterable[str] = (),
) -> OllamaProfileSelection:
    del catalog
    return OllamaProfileSelection(
        profile_id=profile.profile_id,
        selected_profile=profile,
        support_status=support_status,
        reason=reason,
        fallback_profiles=(),
        warnings=tuple(dict.fromkeys(warnings)),
        inventory=inventory,
        modelfile_sha256=modelfile_sha256(profile),
    )


def _max_accelerator_memory(inventory: MachineInventorySnapshot) -> int | None:
    values = [
        accelerator.memory_bytes
        for accelerator in inventory.accelerators
        if accelerator.kind.lower() == "gpu" and accelerator.memory_bytes is not None
    ]
    if not values:
        return None
    return max(values)


__all__ = [
    "AUTO_PROFILE_ID",
    "DEFAULT_OLLAMA_PROFILES",
    "DEFAULT_PROFILE_ID",
    "GIB",
    "fallback_models_for_selection",
    "profile_by_id",
    "profile_catalog",
    "profile_requirement_warnings",
    "select_ollama_execution_policy",
    "select_ollama_profile",
    "WINDOWS_CPU_EXECUTION_WARNING",
]
