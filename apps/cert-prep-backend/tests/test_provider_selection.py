from __future__ import annotations

import pytest

from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.mock_exams import (
    ollama_profiles as ollama_profile_module,
)
from cert_prep_backend.domains.mock_exams import (
    provider_selection as provider_selection_module,
)
from cert_prep_backend.domains.mock_exams.ollama_transport import OllamaProvider
from cert_prep_backend.domains.mock_exams.provider import provider_from_settings
from cert_prep_backend.domains.mock_exams.provider_selection import (
    fastflowlm_hardware_compatibility,
    provider_selection_from_settings,
)
from cert_prep_contracts.hardware import (
    MachineAcceleratorSnapshot,
    MachineCpuSnapshot,
    MachineInventorySnapshot,
)
from cert_prep_contracts.llm import LLMProviderName
from llm_test_fakes import GIB, _profile_inventory


def _compatible_xdna2_inventory() -> MachineInventorySnapshot:
    base = _profile_inventory(total_ram=32 * GIB, free_disk=64 * GIB)
    return MachineInventorySnapshot(
        platform="Windows",
        platform_version="10.0.26100",
        architecture=base.architecture,
        cpu=MachineCpuSnapshot(
            architecture="AMD64",
            name="AMD Ryzen AI 9 H 365",
            logical_cores=20,
        ),
        ram=base.ram,
        storage=base.storage,
        accelerators=(
            MachineAcceleratorSnapshot(
                kind="npu",
                name="NPU Compute Accelerator Device",
                vendor="amd",
                driver_version="32.0.203.304",
            ),
            MachineAcceleratorSnapshot(
                kind="gpu",
                name="AMD Radeon 880M",
                vendor="amd",
                driver_version="32.0.203.304",
            ),
        ),
    )


def test_auto_policy_selects_fastflowlm_only_for_verified_xdna2(tmp_path) -> None:
    selection = provider_selection_from_settings(
        Settings(data_dir=tmp_path, llm_provider="auto"),
        inventory=_compatible_xdna2_inventory(),
    )

    assert selection.selected_provider == LLMProviderName.FASTFLOWLM
    assert selection.configured_model == "qwen3.5:4b"
    assert selection.hardware_compatible is True
    assert selection.requires_terms_acceptance is True


def test_auto_policy_routes_declined_terms_to_ollama(tmp_path) -> None:
    selection = provider_selection_from_settings(
        Settings(
            data_dir=tmp_path,
            llm_provider="auto",
            fastflowlm_terms_declined=True,
        ),
        inventory=_compatible_xdna2_inventory(),
    )

    assert selection.selected_provider == LLMProviderName.OLLAMA
    assert selection.fallback_reason == "FastFlowLM terms were declined."


def test_auto_policy_routes_incompatible_hardware_to_ollama(tmp_path) -> None:
    selection = provider_selection_from_settings(
        Settings(data_dir=tmp_path, llm_provider="auto"),
        inventory=_profile_inventory(total_ram=16 * GIB, free_disk=64 * GIB),
    )

    assert selection.selected_provider == LLMProviderName.OLLAMA
    assert selection.model_requirement_kind is not None
    assert selection.model_requirement_kind.value == "ollama_model"
    assert selection.fallback_reason == "No compatible AMD XDNA2 NPU was detected."


def test_explicit_fastflowlm_cannot_override_declined_terms(tmp_path) -> None:
    selection = provider_selection_from_settings(
        Settings(
            data_dir=tmp_path,
            llm_provider="fastflowlm",
            fastflowlm_terms_declined=True,
        ),
        inventory=_compatible_xdna2_inventory(),
    )

    assert selection.selected_provider == LLMProviderName.OLLAMA
    assert selection.fallback_reason == "FastFlowLM terms were declined."
    assert selection.requires_terms_acceptance is False


def test_explicit_fastflowlm_fails_closed_on_incompatible_hardware(tmp_path) -> None:
    selection = provider_selection_from_settings(
        Settings(data_dir=tmp_path, llm_provider="fastflowlm"),
        inventory=_profile_inventory(total_ram=16 * GIB, free_disk=64 * GIB),
    )

    assert selection.selected_provider == LLMProviderName.OLLAMA
    assert selection.fallback_reason == "No compatible AMD XDNA2 NPU was detected."
    assert selection.requires_terms_acceptance is False


def test_provider_factory_uses_the_auto_selected_ollama_lane(
    monkeypatch,
    tmp_path,
) -> None:
    inventory = _profile_inventory(total_ram=16 * GIB, free_disk=64 * GIB)
    monkeypatch.setattr(
        provider_selection_module,
        "_cached_machine_inventory",
        lambda _timeout: inventory,
    )
    monkeypatch.setattr(
        ollama_profile_module,
        "collect_machine_inventory",
        lambda **_kwargs: inventory,
    )

    provider = provider_from_settings(Settings(data_dir=tmp_path, llm_provider="auto"))

    assert isinstance(provider, OllamaProvider)
    assert provider.model == "cert-prep-qwen3.5-4b-study-8k"


def test_provider_factory_cannot_bypass_a_declined_fastflowlm_terms_decision(
    monkeypatch,
    tmp_path,
) -> None:
    inventory = _compatible_xdna2_inventory()
    monkeypatch.setattr(
        provider_selection_module,
        "_cached_machine_inventory",
        lambda _timeout: inventory,
    )
    monkeypatch.setattr(
        ollama_profile_module,
        "collect_machine_inventory",
        lambda **_kwargs: inventory,
    )

    provider = provider_from_settings(
        Settings(
            data_dir=tmp_path,
            llm_provider="fastflowlm",
            fastflowlm_terms_declined=True,
        )
    )

    assert isinstance(provider, OllamaProvider)


def test_gpu_driver_cannot_substitute_for_an_unverified_npu_driver() -> None:
    inventory = _compatible_xdna2_inventory()
    inventory = MachineInventorySnapshot(
        platform=inventory.platform,
        platform_version=inventory.platform_version,
        architecture=inventory.architecture,
        cpu=inventory.cpu,
        ram=inventory.ram,
        storage=inventory.storage,
        accelerators=(
            MachineAcceleratorSnapshot(
                kind="npu",
                name="NPU Compute Accelerator Device",
                vendor="amd",
            ),
            MachineAcceleratorSnapshot(
                kind="gpu",
                name="AMD Radeon 880M",
                vendor="amd",
                driver_version="99.0.999.999",
            ),
        ),
    )

    compatible, reason = fastflowlm_hardware_compatibility(inventory)

    assert compatible is False
    assert reason == "The AMD accelerator driver version could not be verified."


def test_non_amd_npu_cannot_substitute_for_xdna2() -> None:
    inventory = _compatible_xdna2_inventory()
    inventory = MachineInventorySnapshot(
        platform=inventory.platform,
        platform_version=inventory.platform_version,
        architecture=inventory.architecture,
        cpu=inventory.cpu,
        ram=inventory.ram,
        storage=inventory.storage,
        accelerators=(
            MachineAcceleratorSnapshot(
                kind="npu",
                name="Intel NPU",
                vendor="intel",
                driver_version="99.0.999.999",
            ),
        ),
    )

    compatible, reason = fastflowlm_hardware_compatibility(inventory)

    assert compatible is False
    assert reason == "No compatible AMD XDNA2 NPU was detected."


@pytest.mark.parametrize(
    "cpu_name",
    [
        "AMD Ryzen AI 9 HX 370",
        "AMD Ryzen AI 7 350",
        "AMD Ryzen AI 5 340",
        "AMD Ryzen AI Max+ PRO 395",
    ],
)
def test_supported_ryzen_ai_300_families_identify_a_generic_xdna2_npu(
    cpu_name: str,
) -> None:
    inventory = _compatible_xdna2_inventory()
    inventory = MachineInventorySnapshot(
        platform=inventory.platform,
        platform_version=inventory.platform_version,
        architecture=inventory.architecture,
        cpu=MachineCpuSnapshot(
            architecture="AMD64",
            name=cpu_name,
            logical_cores=20,
        ),
        ram=inventory.ram,
        storage=inventory.storage,
        accelerators=(
            MachineAcceleratorSnapshot(
                kind="npu",
                name="NPU Compute Accelerator Device",
                vendor="amd",
                driver_version="32.0.203.304",
            ),
        ),
    )

    compatible, reason = fastflowlm_hardware_compatibility(inventory)

    assert compatible is True
    assert "minimum driver" in reason
