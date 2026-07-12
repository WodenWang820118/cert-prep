from __future__ import annotations

from functools import lru_cache
import re

from cert_prep_backend.core.config import Settings
from cert_prep_contracts.hardware import (
    MachineAcceleratorSnapshot,
    MachineInventorySnapshot,
)
from cert_prep_contracts.llm import (
    FASTFLOWLM_RUNTIME_TRUST_POLICY,
    LLMProviderName,
    LLMProviderPreference,
    LLMProviderSelection,
)
from cert_prep_contracts.runtime import RuntimeRequirementKind
from cert_prep_ollama.inventory import collect_machine_inventory


def provider_selection_from_settings(
    settings: Settings,
    *,
    inventory: MachineInventorySnapshot | None = None,
    effective_provider: str | None = None,
    effective_model: str | None = None,
) -> LLMProviderSelection:
    """Select a concrete local provider and explain the decision."""

    preference = LLMProviderPreference(settings.llm_provider)
    compatible, compatibility_reason = fastflowlm_hardware_compatibility(
        inventory or _cached_machine_inventory(settings.ollama_profile_inventory_timeout_seconds)
    )
    terms_declined = settings.fastflowlm_terms_declined
    selected = _selected_provider(preference, compatible, terms_declined)
    selected_model = (
        settings.fastflowlm_model
        if selected == LLMProviderName.FASTFLOWLM
        else settings.ollama_model
    )
    terms_accepted = (
        settings.fastflowlm_terms_accepted_version
        == FASTFLOWLM_RUNTIME_TRUST_POLICY.version
    )
    selected_effective_provider = _provider_name_or_default(effective_provider, selected)
    selected_effective_model = effective_model or selected_model
    fallback_reason = None
    if selected == LLMProviderName.OLLAMA and preference in {
        LLMProviderPreference.AUTO,
        LLMProviderPreference.FASTFLOWLM,
    }:
        fallback_reason = (
            "FastFlowLM terms were declined."
            if terms_declined
            else compatibility_reason
        )

    return LLMProviderSelection(
        preference=preference,
        selected_provider=selected,
        effective_provider=selected_effective_provider,
        configured_model=selected_model,
        effective_model=selected_effective_model,
        selection_reason=_selection_reason(
            preference,
            selected,
            compatibility_reason,
            terms_declined,
        ),
        fallback_reason=fallback_reason,
        hardware_compatible=compatible,
        requires_terms_acceptance=selected == LLMProviderName.FASTFLOWLM,
        terms_accepted=terms_accepted,
        terms_version=(
            FASTFLOWLM_RUNTIME_TRUST_POLICY.version
            if selected == LLMProviderName.FASTFLOWLM
            else None
        ),
        terms_url=(
            FASTFLOWLM_RUNTIME_TRUST_POLICY.terms_url
            if selected == LLMProviderName.FASTFLOWLM
            else None
        ),
        runtime_requirement_kind=_runtime_kind(selected),
        model_requirement_kind=_model_kind(selected),
    )


def fastflowlm_hardware_compatibility(
    inventory: MachineInventorySnapshot,
) -> tuple[bool, str]:
    """Return whether inventory satisfies the pinned FastFlowLM Windows lane."""

    if inventory.platform.casefold() != "windows" or not _is_windows_11(
        inventory.platform_version
    ):
        return False, "FastFlowLM requires Windows 11."

    if not _has_xdna2_accelerator(inventory):
        return False, "No compatible AMD XDNA2 NPU was detected."

    driver_versions = [
        accelerator.driver_version
        for accelerator in inventory.accelerators
        if _is_xdna2_npu(accelerator, inventory.cpu.name)
        and accelerator.driver_version
    ]
    if not driver_versions:
        return False, "The AMD accelerator driver version could not be verified."
    minimum = FASTFLOWLM_RUNTIME_TRUST_POLICY.minimum_windows_driver_version
    if not any(_version_at_least(version, minimum) for version in driver_versions):
        return False, f"The AMD accelerator driver must be at least {minimum}."
    return True, "Windows 11, AMD XDNA2, and the minimum driver were detected."


def _selected_provider(
    preference: LLMProviderPreference,
    compatible: bool,
    terms_declined: bool,
) -> LLMProviderName:
    if preference == LLMProviderPreference.FAKE:
        return LLMProviderName.FAKE
    if terms_declined:
        return LLMProviderName.OLLAMA
    if preference == LLMProviderPreference.FASTFLOWLM:
        return (
            LLMProviderName.FASTFLOWLM
            if compatible
            else LLMProviderName.OLLAMA
        )
    if preference == LLMProviderPreference.OLLAMA:
        return LLMProviderName.OLLAMA
    return (
        LLMProviderName.FASTFLOWLM
        if compatible and not terms_declined
        else LLMProviderName.OLLAMA
    )


def _selection_reason(
    preference: LLMProviderPreference,
    selected: LLMProviderName,
    compatibility_reason: str,
    terms_declined: bool,
) -> str:
    if preference == LLMProviderPreference.AUTO:
        if selected == LLMProviderName.FASTFLOWLM:
            return f"Auto-selected FastFlowLM: {compatibility_reason}"
        if terms_declined:
            return "Auto-selected Ollama because FastFlowLM terms were declined."
        return f"Auto-selected Ollama: {compatibility_reason}"
    if preference == LLMProviderPreference.FASTFLOWLM:
        if selected == LLMProviderName.OLLAMA:
            if terms_declined:
                return (
                    "Selected Ollama because FastFlowLM terms were declined, "
                    "overriding the explicit FastFlowLM preference."
                )
            return (
                "Selected Ollama because the explicit FastFlowLM preference "
                f"failed hardware preflight: {compatibility_reason}"
            )
        return (
            "Selected fastflowlm from the explicit provider preference. "
            f"Hardware preflight: {compatibility_reason}"
        )
    return f"Selected {selected.value} from the explicit provider preference."


def _runtime_kind(provider: LLMProviderName) -> RuntimeRequirementKind | None:
    if provider == LLMProviderName.FASTFLOWLM:
        return RuntimeRequirementKind.FASTFLOWLM
    if provider == LLMProviderName.OLLAMA:
        return RuntimeRequirementKind.OLLAMA
    return None


def _model_kind(provider: LLMProviderName) -> RuntimeRequirementKind | None:
    if provider == LLMProviderName.FASTFLOWLM:
        return RuntimeRequirementKind.FASTFLOWLM_MODEL
    if provider == LLMProviderName.OLLAMA:
        return RuntimeRequirementKind.OLLAMA_MODEL
    return None


def _provider_name_or_default(
    provider: str | None,
    default: LLMProviderName,
) -> LLMProviderName:
    try:
        return LLMProviderName(provider) if provider else default
    except ValueError:
        return default


def _is_windows_11(version: str) -> bool:
    if re.search(r"(^|\D)11(\D|$)", version):
        return True
    numbers = [int(value) for value in re.findall(r"\d+", version)]
    return any(value >= 22_000 for value in numbers)


def _has_xdna2_accelerator(inventory: MachineInventorySnapshot) -> bool:
    return any(
        _is_xdna2_npu(accelerator, inventory.cpu.name)
        for accelerator in inventory.accelerators
    )


def _is_xdna2_npu(
    accelerator: MachineAcceleratorSnapshot,
    cpu_name: str | None,
) -> bool:
    if accelerator.kind.casefold() != "npu" or not _is_amd_accelerator(accelerator):
        return False
    name = accelerator.name.casefold()
    return (
        "xdna2" in name
        or "xdna 2" in name
        or _is_known_xdna2_cpu(cpu_name)
    )


def _is_amd_accelerator(accelerator: MachineAcceleratorSnapshot) -> bool:
    identity = " ".join(
        value
        for value in (
            accelerator.vendor,
            accelerator.name,
            accelerator.device_id,
        )
        if value
    ).casefold()
    return "amd" in identity or "ven_1022" in identity


def _is_known_xdna2_cpu(cpu_name: str | None) -> bool:
    return bool(
        re.search(
            r"ryzen\s+ai(?:\s+max\+?)?(?:\s+pro)?(?:\s+[579])?\s+"
            r"(?:(?:hx|h)\s+)?3\d\d",
            (cpu_name or "").casefold(),
        )
    )


def _version_at_least(actual: str, minimum: str) -> bool:
    actual_parts = tuple(int(value) for value in re.findall(r"\d+", actual))
    minimum_parts = tuple(int(value) for value in re.findall(r"\d+", minimum))
    length = max(len(actual_parts), len(minimum_parts))
    return actual_parts + (0,) * (length - len(actual_parts)) >= minimum_parts + (0,) * (
        length - len(minimum_parts)
    )


@lru_cache(maxsize=4)
def _cached_machine_inventory(timeout_seconds: float) -> MachineInventorySnapshot:
    return collect_machine_inventory(timeout_seconds=timeout_seconds)


__all__ = [
    "fastflowlm_hardware_compatibility",
    "provider_selection_from_settings",
]
