"""Tests for device selection policy, environment configuration, and corrections."""

from __future__ import annotations

from pathlib import Path

import pytest

from cert_prep_contracts.hardware import (
    MachineAcceleratorSnapshot,
    MachineCpuSnapshot,
    MachineInventorySnapshot,
    MachineRamSnapshot,
    MachineStorageSnapshot,
)
from cert_prep_contracts.llm import LLMExecutionMode
from cert_prep_ollama.device_policy import (
    EnvironmentResolution,
    OllamaDevicePolicy,
    OllamaDevicePreference,
    adapter_key,
    corrected_device_policy,
    normalize_device_name,
    ollama_child_environment,
    parse_pci_bus,
    selectable_adapters,
    select_ollama_device_policy,
)
from cert_prep_ollama.profiles import select_ollama_execution_policy
from cert_prep_ollama.server_log import DiscoveredDevice, OllamaLogParser


def _make_inventory(
    accelerators: list[MachineAcceleratorSnapshot],
    platform_name: str = "Windows",
) -> MachineInventorySnapshot:
    return MachineInventorySnapshot(
        platform=platform_name,
        platform_version="10.0.26100",
        architecture="AMD64",
        cpu=MachineCpuSnapshot(architecture="AMD64"),
        ram=MachineRamSnapshot(32 * 1024**3, 16 * 1024**3),
        storage=MachineStorageSnapshot("C:\\", 64 * 1024**3, 128 * 1024**3),
        accelerators=tuple(accelerators),
    )


# -- Policy Table Tests -------------------------------------------------------


def test_laptop_exact_inventory_selects_nvidia_cuda() -> None:
    # Machine: Radeon 880M integrated, RTX 4060 dedicated w/ UUID, Basic Render software
    radeon = MachineAcceleratorSnapshot(
        kind="gpu",
        name="AMD Radeon(TM) 880M Graphics",
        vendor="amd",
        classification="integrated",
        pci_vendor_id="1002",
        pci_device_id="150e",
        adapter_luid="0000000000012fd0",
        dedicated_memory_bytes=298_012_672,
        shared_memory_bytes=16_706_365_440,
    )
    rtx = MachineAcceleratorSnapshot(
        kind="gpu",
        name="NVIDIA GeForce RTX 4060 Laptop GPU",
        vendor="nvidia",
        classification="dedicated",
        pci_vendor_id="10de",
        pci_device_id="28a0",
        device_id="GPU-3c990263-ad20-7ce7-1ad5-cae44a0d9df3",
        adapter_luid="000000000001a69c",
        dedicated_memory_bytes=8_342_470_656,
        shared_memory_bytes=16_706_365_440,
    )
    basic_render = MachineAcceleratorSnapshot(
        kind="gpu",
        name="Microsoft Basic Render Driver",
        classification="software",
        pci_vendor_id="1414",
        pci_device_id="008c",
        adapter_luid="000000000001a625",
        dedicated_memory_bytes=0,
        shared_memory_bytes=16_706_365_440,
    )

    inv = _make_inventory([radeon, rtx, basic_render])
    policy = select_ollama_device_policy(inv)

    assert policy.target == "dedicated_gpu"
    assert policy.backend == "cuda"
    assert policy.adapter_name == "NVIDIA GeForce RTX 4060 Laptop GPU"
    assert policy.environment == {
        "CUDA_VISIBLE_DEVICES": "GPU-3c990263-ad20-7ce7-1ad5-cae44a0d9df3",
        "HIP_VISIBLE_DEVICES": "-1",
        "GGML_VK_VISIBLE_DEVICES": "-1",
        "OLLAMA_VULKAN": "0",
        "OLLAMA_IGPU_ENABLE": "0",
    }
    assert policy.cleared == (
        "ROCR_VISIBLE_DEVICES",
        "GPU_DEVICE_ORDINAL",
        "HSA_OVERRIDE_GFX_VERSION",
        "OLLAMA_LLM_LIBRARY",
    )


def test_intel_igpu_plus_nvidia_selects_nvidia_cuda() -> None:
    intel_igpu = MachineAcceleratorSnapshot(
        kind="gpu",
        name="Intel(R) UHD Graphics 630",
        vendor="intel",
        classification="integrated",
        pci_vendor_id="8086",
        pci_device_id="9bc4",
        dedicated_memory_bytes=128 * 1024**2,
    )
    nvidia_dgpu = MachineAcceleratorSnapshot(
        kind="gpu",
        name="NVIDIA GeForce RTX 3080",
        vendor="nvidia",
        classification="dedicated",
        pci_vendor_id="10de",
        pci_device_id="2206",
        device_id="GPU-11112222-3333-4444-5555-666677778888",
        dedicated_memory_bytes=10 * 1024**3,
    )

    inv = _make_inventory([intel_igpu, nvidia_dgpu])
    policy = select_ollama_device_policy(inv)

    assert policy.target == "dedicated_gpu"
    assert policy.backend == "cuda"
    assert policy.environment["CUDA_VISIBLE_DEVICES"] == "GPU-11112222-3333-4444-5555-666677778888"
    assert policy.environment["HIP_VISIBLE_DEVICES"] == "-1"
    assert policy.environment["GGML_VK_VISIBLE_DEVICES"] == "-1"
    assert policy.environment["OLLAMA_VULKAN"] == "0"
    assert policy.environment["OLLAMA_IGPU_ENABLE"] == "0"


def test_nvidia_without_uuid_leaves_cuda_visible_devices_unset() -> None:
    nvidia_dgpu = MachineAcceleratorSnapshot(
        kind="gpu",
        name="NVIDIA GeForce GTX 1660 Ti",
        vendor="nvidia",
        classification="dedicated",
        pci_vendor_id="10de",
        pci_device_id="2182",
        device_id=None,  # No UUID
        dedicated_memory_bytes=6 * 1024**3,
    )

    inv = _make_inventory([nvidia_dgpu])
    policy = select_ollama_device_policy(inv)

    assert policy.target == "dedicated_gpu"
    assert policy.backend == "cuda"
    assert "CUDA_VISIBLE_DEVICES" not in policy.environment
    assert "CUDA_VISIBLE_DEVICES" in policy.cleared
    assert policy.environment["HIP_VISIBLE_DEVICES"] == "-1"
    assert policy.environment["GGML_VK_VISIBLE_DEVICES"] == "-1"
    assert policy.environment["OLLAMA_VULKAN"] == "0"
    assert policy.environment["OLLAMA_IGPU_ENABLE"] == "0"


def test_amd_dedicated_only_selects_rocm_with_hip_unset() -> None:
    amd_dgpu = MachineAcceleratorSnapshot(
        kind="gpu",
        name="AMD Radeon RX 7600",
        vendor="amd",
        classification="dedicated",
        pci_vendor_id="1002",
        pci_device_id="7480",
        dedicated_memory_bytes=8 * 1024**3,
    )

    inv = _make_inventory([amd_dgpu])
    policy = select_ollama_device_policy(inv)

    assert policy.target == "dedicated_gpu"
    assert policy.backend == "rocm"
    assert policy.environment["CUDA_VISIBLE_DEVICES"] == "-1"
    assert "HIP_VISIBLE_DEVICES" not in policy.environment
    assert "HIP_VISIBLE_DEVICES" in policy.cleared
    assert policy.environment["GGML_VK_VISIBLE_DEVICES"] == "-1"
    assert policy.environment["OLLAMA_VULKAN"] == "0"
    assert policy.environment["OLLAMA_IGPU_ENABLE"] == "0"


def test_dedicated_gpu_other_vendor_selects_vulkan() -> None:
    arc_gpu = MachineAcceleratorSnapshot(
        kind="gpu",
        name="Intel(R) Arc(TM) A770 Graphics",
        vendor="intel",
        classification="dedicated",
        pci_vendor_id="8086",
        pci_device_id="56a0",
        dedicated_memory_bytes=16 * 1024**3,
    )

    inv = _make_inventory([arc_gpu])
    policy = select_ollama_device_policy(inv)

    assert policy.target == "dedicated_gpu"
    assert policy.backend == "vulkan"
    assert policy.environment["CUDA_VISIBLE_DEVICES"] == "-1"
    assert policy.environment["HIP_VISIBLE_DEVICES"] == "-1"
    assert "GGML_VK_VISIBLE_DEVICES" not in policy.environment
    assert "GGML_VK_VISIBLE_DEVICES" in policy.cleared
    assert policy.environment["OLLAMA_VULKAN"] == "1"
    assert policy.environment["OLLAMA_IGPU_ENABLE"] == "0"


def test_igpu_only_selects_vulkan_with_igpu_enable() -> None:
    radeon_igpu = MachineAcceleratorSnapshot(
        kind="gpu",
        name="AMD Radeon(TM) 780M",
        vendor="amd",
        classification="integrated",
        pci_vendor_id="1002",
        pci_device_id="15bf",
        dedicated_memory_bytes=512 * 1024**2,
        shared_memory_bytes=16 * 1024**3,
    )

    inv = _make_inventory([radeon_igpu])
    policy = select_ollama_device_policy(inv)

    assert policy.target == "integrated_gpu"
    assert policy.backend == "vulkan"
    assert policy.environment["CUDA_VISIBLE_DEVICES"] == "-1"
    assert policy.environment["HIP_VISIBLE_DEVICES"] == "-1"
    assert "GGML_VK_VISIBLE_DEVICES" not in policy.environment
    assert "GGML_VK_VISIBLE_DEVICES" in policy.cleared
    assert policy.environment["OLLAMA_VULKAN"] == "1"
    assert policy.environment["OLLAMA_IGPU_ENABLE"] == "1"


def test_unknown_gpu_without_dedicated_returns_unmanaged() -> None:
    unknown_gpu = MachineAcceleratorSnapshot(
        kind="gpu",
        name="Generic Display Adapter",
        classification="unknown",
        pci_vendor_id=None,
    )

    inv = _make_inventory([unknown_gpu])
    policy = select_ollama_device_policy(inv)

    assert policy.target == "unmanaged"
    assert policy.backend is None
    assert policy.environment == {}
    assert policy.cleared == ()


def test_dedicated_wins_over_unknown_gpus() -> None:
    unknown_gpu = MachineAcceleratorSnapshot(
        kind="gpu",
        name="Unknown GPU Adapter",
        classification="unknown",
    )
    dedicated_nvidia = MachineAcceleratorSnapshot(
        kind="gpu",
        name="NVIDIA GeForce RTX 4070",
        vendor="nvidia",
        classification="dedicated",
        pci_vendor_id="10de",
        pci_device_id="2786",
        device_id="GPU-99990000-1111-2222-3333-444455556666",
        dedicated_memory_bytes=12 * 1024**3,
    )

    inv = _make_inventory([unknown_gpu, dedicated_nvidia])
    policy = select_ollama_device_policy(inv)

    assert policy.target == "dedicated_gpu"
    assert policy.backend == "cuda"
    assert policy.adapter_name == "NVIDIA GeForce RTX 4070"


def test_non_windows_platform_returns_unmanaged() -> None:
    dedicated_nvidia = MachineAcceleratorSnapshot(
        kind="gpu",
        name="NVIDIA GeForce RTX 4060",
        classification="dedicated",
        pci_vendor_id="10de",
    )
    inv = _make_inventory([dedicated_nvidia], platform_name="Linux")
    policy = select_ollama_device_policy(inv)

    assert policy.target == "unmanaged"
    assert policy.backend is None
    assert policy.environment == {}
    assert policy.cleared == ()


def test_no_inventory_returns_unmanaged() -> None:
    policy = select_ollama_device_policy(None, platform_name="Windows")
    assert policy.target == "unmanaged"
    assert policy.backend is None


def test_software_only_selects_cpu_and_agrees_with_execution_policy() -> None:
    basic_render = MachineAcceleratorSnapshot(
        kind="gpu",
        name="Microsoft Basic Render Driver",
        classification="software",
        pci_vendor_id="1414",
    )

    inv = _make_inventory([basic_render])
    policy = select_ollama_device_policy(inv)

    assert policy.target == "cpu"
    assert policy.backend == "cpu"
    assert policy.environment == {
        "CUDA_VISIBLE_DEVICES": "-1",
        "HIP_VISIBLE_DEVICES": "-1",
        "GGML_VK_VISIBLE_DEVICES": "-1",
        "OLLAMA_VULKAN": "0",
        "OLLAMA_IGPU_ENABLE": "0",
    }
    assert policy.cleared == (
        "ROCR_VISIBLE_DEVICES",
        "GPU_DEVICE_ORDINAL",
        "HSA_OVERRIDE_GFX_VERSION",
        "OLLAMA_LLM_LIBRARY",
    )

    # Agreement with profiles.select_ollama_execution_policy
    exec_policy = select_ollama_execution_policy(inv)
    assert exec_policy.mode == LLMExecutionMode.CPU


def test_multiple_dedicated_gpus_sorting_rules() -> None:
    # Rule: Largest dedicated_memory_bytes; ties to NVIDIA (10de), then AMD (1002), then name
    amd_8gb = MachineAcceleratorSnapshot(
        kind="gpu",
        name="AMD Radeon RX 6600",
        classification="dedicated",
        pci_vendor_id="1002",
        dedicated_memory_bytes=8 * 1024**3,
    )
    nvidia_8gb = MachineAcceleratorSnapshot(
        kind="gpu",
        name="NVIDIA GeForce RTX 3070",
        classification="dedicated",
        pci_vendor_id="10de",
        device_id="GPU-12345678-0000-0000-0000-000000000000",
        dedicated_memory_bytes=8 * 1024**3,
    )
    intel_16gb = MachineAcceleratorSnapshot(
        kind="gpu",
        name="Intel Arc A770",
        classification="dedicated",
        pci_vendor_id="8086",
        dedicated_memory_bytes=16 * 1024**3,
    )

    # Intel 16GB wins by memory
    inv1 = _make_inventory([amd_8gb, nvidia_8gb, intel_16gb])
    policy1 = select_ollama_device_policy(inv1)
    assert policy1.adapter_name == "Intel Arc A770"

    # Between AMD 8GB and NVIDIA 8GB, NVIDIA wins the tie
    inv2 = _make_inventory([amd_8gb, nvidia_8gb])
    policy2 = select_ollama_device_policy(inv2)
    assert policy2.adapter_name == "NVIDIA GeForce RTX 3070"


# -- Environment Resolution Tests ---------------------------------------------


def test_ollama_child_environment_removes_and_overrides_case_insensitively() -> None:
    base = {
        "PATH": "C:\\Windows\\System32",
        "OLLAMA_MODELS": "C:\\Models",
        "cuda_visible_devices": "1",
        "Hip_Visible_Devices": "0",
        "ROCR_VISIBLE_DEVICES": "0",
        "OLLAMA_LLM_LIBRARY": "rocm_v7_1",
    }
    policy = OllamaDevicePolicy(
        target="dedicated_gpu",
        backend="cuda",
        adapter_name="NVIDIA GeForce RTX 4060 Laptop GPU",
        environment={
            "CUDA_VISIBLE_DEVICES": "GPU-3c990263-ad20-7ce7-1ad5-cae44a0d9df3",
            "HIP_VISIBLE_DEVICES": "-1",
            "GGML_VK_VISIBLE_DEVICES": "-1",
            "OLLAMA_VULKAN": "0",
            "OLLAMA_IGPU_ENABLE": "0",
        },
        cleared=(
            "ROCR_VISIBLE_DEVICES",
            "GPU_DEVICE_ORDINAL",
            "HSA_OVERRIDE_GFX_VERSION",
            "OLLAMA_LLM_LIBRARY",
        ),
    )

    child_env, resolutions = ollama_child_environment(base, policy, case_insensitive=True)

    # Check child_env values
    assert child_env["CUDA_VISIBLE_DEVICES"] == "GPU-3c990263-ad20-7ce7-1ad5-cae44a0d9df3"
    assert child_env["HIP_VISIBLE_DEVICES"] == "-1"
    assert child_env["GGML_VK_VISIBLE_DEVICES"] == "-1"
    assert child_env["OLLAMA_VULKAN"] == "0"
    assert child_env["OLLAMA_IGPU_ENABLE"] == "0"
    assert child_env["PATH"] == "C:\\Windows\\System32"
    assert child_env["OLLAMA_MODELS"] == "C:\\Models"

    # Removed variables
    assert "cuda_visible_devices" not in child_env
    assert "Hip_Visible_Devices" not in child_env
    assert "ROCR_VISIBLE_DEVICES" not in child_env
    assert "OLLAMA_LLM_LIBRARY" not in child_env

    # Base is untouched
    assert base["cuda_visible_devices"] == "1"
    assert "ROCR_VISIBLE_DEVICES" in base

    # Resolutions check: variable name and action only, no inherited values
    res_dict = {r.name: r.action for r in resolutions}
    assert res_dict["ROCR_VISIBLE_DEVICES"] == "cleared"
    assert res_dict["OLLAMA_LLM_LIBRARY"] == "cleared"
    assert res_dict["CUDA_VISIBLE_DEVICES"] == "overridden"
    assert res_dict["HIP_VISIBLE_DEVICES"] == "overridden"
    assert res_dict["GGML_VK_VISIBLE_DEVICES"] == "set"
    assert res_dict["OLLAMA_VULKAN"] == "set"
    assert res_dict["OLLAMA_IGPU_ENABLE"] == "set"

    for r in resolutions:
        assert isinstance(r, EnvironmentResolution)
        assert not hasattr(r, "value")
        assert not hasattr(r, "old_value")


def test_ollama_child_environment_unmanaged_returns_copy_with_no_resolutions() -> None:
    base = {"PATH": "/usr/bin", "FOO": "bar"}
    policy = OllamaDevicePolicy(target="unmanaged", backend=None)
    child_env, resolutions = ollama_child_environment(base, policy)

    assert child_env == base
    assert child_env is not base
    assert resolutions == ()


# -- Correction Tests ---------------------------------------------------------


def test_corrected_device_policy_on_rocm_fixture_discovery_for_rtx_target() -> None:
    # Target was RTX 4060 Laptop GPU on CUDA
    initial_policy = OllamaDevicePolicy(
        target="dedicated_gpu",
        backend="cuda",
        adapter_name="NVIDIA GeForce RTX 4060 Laptop GPU",
        device_id="GPU-3c990263-ad20-7ce7-1ad5-cae44a0d9df3",
        environment={
            "CUDA_VISIBLE_DEVICES": "GPU-3c990263-ad20-7ce7-1ad5-cae44a0d9df3",
            "HIP_VISIBLE_DEVICES": "-1",
            "GGML_VK_VISIBLE_DEVICES": "-1",
            "OLLAMA_VULKAN": "0",
            "OLLAMA_IGPU_ENABLE": "0",
        },
        cleared=(
            "ROCR_VISIBLE_DEVICES",
            "GPU_DEVICE_ORDINAL",
            "HSA_OVERRIDE_GFX_VERSION",
            "OLLAMA_LLM_LIBRARY",
        ),
    )

    discovered = [
        DiscoveredDevice(
            library="ROCm",
            id="0",
            filter_id="0",
            name="ROCm0",
            description="AMD Radeon(TM) 880M Graphics",
            pci_id="",
            type="discrete",
            total=13100140134,
            available=12884901888,
            libdirs=("ollama", "rocm_v7_1"),
        ),
        DiscoveredDevice(
            library="CUDA",
            id="0",
            filter_id="0",
            name="CUDA0",
            description="NVIDIA GeForce RTX 4060 Laptop GPU",
            pci_id="0000:63:00.0",
            type="discrete",
            total=8589934592,
            available=7408844800,
            libdirs=("ollama", "cuda_v13"),
        ),
    ]

    corrected = corrected_device_policy(initial_policy, discovered)
    assert corrected is not None
    assert corrected.target == "dedicated_gpu"
    assert corrected.backend == "cuda"
    assert corrected.environment["CUDA_VISIBLE_DEVICES"] == "GPU-3c990263-ad20-7ce7-1ad5-cae44a0d9df3"
    assert corrected.environment["HIP_VISIBLE_DEVICES"] == "-1"
    assert corrected.environment["GGML_VK_VISIBLE_DEVICES"] == "-1"
    assert corrected.environment["OLLAMA_LLM_LIBRARY"] == "cuda_v13"
    assert corrected.environment["OLLAMA_VULKAN"] == "0"
    assert corrected.environment["OLLAMA_IGPU_ENABLE"] == "0"
    assert corrected.pci_bus == "0000:63:00.0"
    assert corrected.cleared == (
        "ROCR_VISIBLE_DEVICES",
        "GPU_DEVICE_ORDINAL",
        "HSA_OVERRIDE_GFX_VERSION",
    )


def test_corrected_device_policy_two_identical_candidates_returns_none() -> None:
    initial_policy = OllamaDevicePolicy(
        target="dedicated_gpu",
        backend="cuda",
        adapter_name="NVIDIA GeForce RTX 4060 Laptop GPU",
    )
    duplicate_candidates = [
        DiscoveredDevice(
            library="CUDA",
            id="0",
            filter_id="0",
            name="CUDA0",
            description="NVIDIA GeForce RTX 4060 Laptop GPU",
            pci_id="",
            type="discrete",
            total=8589934592,
            available=7408844800,
            libdirs=("ollama", "cuda_v13"),
        ),
        DiscoveredDevice(
            library="CUDA",
            id="1",
            filter_id="1",
            name="CUDA1",
            description="NVIDIA GeForce RTX 4060 Laptop GPU",
            pci_id="",
            type="discrete",
            total=8589934592,
            available=7408844800,
            libdirs=("ollama", "cuda_v13"),
        ),
    ]

    assert corrected_device_policy(initial_policy, duplicate_candidates) is None


def test_normalize_device_name() -> None:
    assert normalize_device_name("AMD Radeon(TM) 880M Graphics") == "amd radeon 880m graphics"
    assert normalize_device_name("NVIDIA GeForce(R) RTX 4060") == "nvidia geforce rtx 4060"


def test_parse_pci_bus() -> None:
    assert parse_pci_bus("0000:63:00.0") == (0, 0x63, 0, 0)
    assert parse_pci_bus("00000000:63:00.0") == (0, 0x63, 0, 0)
    assert parse_pci_bus("0000:63:00.0".upper()) == (0, 0x63, 0, 0)
    assert parse_pci_bus("63:00.0") == (0, 0x63, 0, 0)
    assert parse_pci_bus("0000:65:00.0") == (0, 0x65, 0, 0)
    assert parse_pci_bus("0000:65:00.0") != parse_pci_bus("0000:63:00.0")
    assert parse_pci_bus("unknown id") is None
    assert parse_pci_bus("") is None
    assert parse_pci_bus(None) is None
    assert parse_pci_bus("invalid") is None


def test_corrected_device_policy_pci_bus_hex_formats() -> None:
    # 1. 0000:63:00.0 in policy matches 00000000:63:00.0 in discovery
    policy_4digit = OllamaDevicePolicy(
        target="dedicated_gpu",
        backend="cuda",
        adapter_name="NVIDIA GeForce RTX 4060 Laptop GPU",
        pci_bus="0000:63:00.0",
    )
    discovered_8digit = [
        DiscoveredDevice(
            library="CUDA",
            id="0",
            filter_id="0",
            name="CUDA0",
            description="NVIDIA GeForce RTX 4060 Laptop GPU",
            pci_id="00000000:63:00.0",
            type="discrete",
            total=8589934592,
            available=7408844800,
            libdirs=("ollama", "cuda_v13"),
        )
    ]
    corrected = corrected_device_policy(policy_4digit, discovered_8digit)
    assert corrected is not None

    # 2. Upper-case hex matches
    discovered_upper = [
        DiscoveredDevice(
            library="CUDA",
            id="0",
            filter_id="0",
            name="CUDA0",
            description="NVIDIA GeForce RTX 4060 Laptop GPU",
            pci_id="0000:63:00.0".upper(),
            type="discrete",
            total=8589934592,
            available=7408844800,
            libdirs=("ollama", "cuda_v13"),
        )
    ]
    corrected_upper = corrected_device_policy(policy_4digit, discovered_upper)
    assert corrected_upper is not None

    # 3. 0000:65:00.0 does NOT match
    discovered_diff = [
        DiscoveredDevice(
            library="CUDA",
            id="0",
            filter_id="0",
            name="CUDA0",
            description="NVIDIA GeForce RTX 4060 Laptop GPU",
            pci_id="0000:65:00.0",
            type="discrete",
            total=8589934592,
            available=7408844800,
            libdirs=("ollama", "cuda_v13"),
        )
    ]
    corrected_diff = corrected_device_policy(policy_4digit, discovered_diff)
    assert corrected_diff is None


# -- Preference matrix --------------------------------------------------------

_RTX = "NVIDIA GeForce RTX 4060 Laptop GPU"
_RTX_UUID = "GPU-3c990263-ad20-7ce7-1ad5-cae44a0d9df3"
_RADEON = "AMD Radeon(TM) 880M Graphics"
_RX = "AMD Radeon RX 7600"
_ARC = "Intel(R) Arc(TM) A770 Graphics"
_IGPU = "AMD Radeon(TM) 780M"
_PNP = r"PCI\VEN_10DE&DEV_28A0&SUBSYS_00000000&REV_A1\4&123456&0&0008"

_CHILD_BASE = {"PATH": "C:\\Windows\\System32", "CUDA_VISIBLE_DEVICES": "inherited"}
_BASE_CLEARED = (
    "ROCR_VISIBLE_DEVICES",
    "GPU_DEVICE_ORDINAL",
    "HSA_OVERRIDE_GFX_VERSION",
    "OLLAMA_LLM_LIBRARY",
)


def _gpu(name: str, **kwargs) -> MachineAcceleratorSnapshot:
    return MachineAcceleratorSnapshot(kind="gpu", name=name, **kwargs)


def _rtx(**overrides) -> MachineAcceleratorSnapshot:
    fields = {
        "classification": "dedicated",
        "vendor": "nvidia",
        "pci_vendor_id": "10de",
        "pci_device_id": "28a0",
        "device_id": _RTX_UUID,
        "dedicated_memory_bytes": 8_342_470_656,
    }
    fields.update(overrides)
    return _gpu(_RTX, **fields)


_SHAPES: dict[str, dict[str, object]] = {
    "nvidia": {
        "env": {
            "CUDA_VISIBLE_DEVICES": _RTX_UUID,
            "HIP_VISIBLE_DEVICES": "-1",
            "GGML_VK_VISIBLE_DEVICES": "-1",
            "OLLAMA_VULKAN": "0",
            "OLLAMA_IGPU_ENABLE": "0",
        },
        "child": {
            "PATH": "C:\\Windows\\System32",
            "CUDA_VISIBLE_DEVICES": _RTX_UUID,
            "HIP_VISIBLE_DEVICES": "-1",
            "GGML_VK_VISIBLE_DEVICES": "-1",
            "OLLAMA_VULKAN": "0",
            "OLLAMA_IGPU_ENABLE": "0",
        },
        "cleared": _BASE_CLEARED,
    },
    "amd": {
        "env": {
            "CUDA_VISIBLE_DEVICES": "-1",
            "GGML_VK_VISIBLE_DEVICES": "-1",
            "OLLAMA_VULKAN": "0",
            "OLLAMA_IGPU_ENABLE": "0",
        },
        "child": {
            "PATH": "C:\\Windows\\System32",
            "CUDA_VISIBLE_DEVICES": "-1",
            "GGML_VK_VISIBLE_DEVICES": "-1",
            "OLLAMA_VULKAN": "0",
            "OLLAMA_IGPU_ENABLE": "0",
        },
        "cleared": (*_BASE_CLEARED, "HIP_VISIBLE_DEVICES"),
    },
    "vulkan_dgpu": {
        "env": {
            "CUDA_VISIBLE_DEVICES": "-1",
            "HIP_VISIBLE_DEVICES": "-1",
            "OLLAMA_VULKAN": "1",
            "OLLAMA_IGPU_ENABLE": "0",
        },
        "child": {
            "PATH": "C:\\Windows\\System32",
            "CUDA_VISIBLE_DEVICES": "-1",
            "HIP_VISIBLE_DEVICES": "-1",
            "OLLAMA_VULKAN": "1",
            "OLLAMA_IGPU_ENABLE": "0",
        },
        "cleared": (*_BASE_CLEARED, "GGML_VK_VISIBLE_DEVICES"),
    },
    "igpu": {
        "env": {
            "CUDA_VISIBLE_DEVICES": "-1",
            "HIP_VISIBLE_DEVICES": "-1",
            "OLLAMA_VULKAN": "1",
            "OLLAMA_IGPU_ENABLE": "1",
        },
        "child": {
            "PATH": "C:\\Windows\\System32",
            "CUDA_VISIBLE_DEVICES": "-1",
            "HIP_VISIBLE_DEVICES": "-1",
            "OLLAMA_VULKAN": "1",
            "OLLAMA_IGPU_ENABLE": "1",
        },
        "cleared": (*_BASE_CLEARED, "GGML_VK_VISIBLE_DEVICES"),
    },
    "cpu": {
        "env": {
            "CUDA_VISIBLE_DEVICES": "-1",
            "HIP_VISIBLE_DEVICES": "-1",
            "GGML_VK_VISIBLE_DEVICES": "-1",
            "OLLAMA_VULKAN": "0",
            "OLLAMA_IGPU_ENABLE": "0",
        },
        "child": {
            "PATH": "C:\\Windows\\System32",
            "CUDA_VISIBLE_DEVICES": "-1",
            "HIP_VISIBLE_DEVICES": "-1",
            "GGML_VK_VISIBLE_DEVICES": "-1",
            "OLLAMA_VULKAN": "0",
            "OLLAMA_IGPU_ENABLE": "0",
        },
        "cleared": _BASE_CLEARED,
    },
    "unmanaged": {
        "env": {},
        "child": dict(_CHILD_BASE),
        "cleared": (),
    },
}


def _machine(
    name: str,
) -> tuple[MachineInventorySnapshot | None, dict[str, MachineAcceleratorSnapshot]]:
    if name == "none":
        return None, {}
    if name == "nvidia_igpu":
        radeon = _gpu(
            _RADEON,
            classification="integrated",
            vendor="amd",
            pci_vendor_id="1002",
            pci_device_id="150e",
            dedicated_memory_bytes=298_012_672,
            shared_memory_bytes=16_706_365_440,
        )
        rtx = _rtx()
        software = _gpu(
            "Microsoft Basic Render Driver",
            classification="software",
            pci_vendor_id="1414",
            pci_device_id="008c",
        )
        return _make_inventory([radeon, rtx, software]), {"dgpu": rtx, "igpu": radeon}
    if name == "amd":
        amd = _gpu(
            _RX,
            classification="dedicated",
            vendor="amd",
            pci_vendor_id="1002",
            pci_device_id="7480",
            dedicated_memory_bytes=8 * 1024**3,
        )
        return _make_inventory([amd]), {"dgpu": amd}
    if name == "arc":
        arc = _gpu(
            _ARC,
            classification="dedicated",
            vendor="intel",
            pci_vendor_id="8086",
            pci_device_id="56a0",
            dedicated_memory_bytes=16 * 1024**3,
        )
        return _make_inventory([arc]), {"dgpu": arc}
    if name == "igpu":
        igpu = _gpu(
            _IGPU,
            classification="integrated",
            vendor="amd",
            pci_vendor_id="1002",
            pci_device_id="15bf",
            dedicated_memory_bytes=512 * 1024**2,
            shared_memory_bytes=16 * 1024**3,
        )
        return _make_inventory([igpu]), {"igpu": igpu}
    if name == "unknown":
        unknown = _gpu(
            "Generic Display Adapter",
            classification="unknown",
            pci_vendor_id="1234",
            pci_device_id="5678",
        )
        return _make_inventory([unknown]), {"self": unknown}
    if name == "software":
        basic = _gpu(
            "Microsoft Basic Render Driver",
            classification="software",
            pci_vendor_id="1414",
            pci_device_id="008c",
        )
        return _make_inventory([basic]), {}
    if name == "no_gpu":
        return _make_inventory([]), {}
    if name == "linux":
        rtx = _rtx()
        return _make_inventory([rtx], platform_name="Linux"), {"dgpu": rtx}
    raise AssertionError(name)


def _preference_for(
    choice: str,
    adapters: dict[str, MachineAcceleratorSnapshot],
) -> OllamaDevicePreference:
    if choice == "auto":
        return OllamaDevicePreference()
    if choice == "cpu":
        return OllamaDevicePreference(mode="cpu")
    if choice == "missing":
        return OllamaDevicePreference(
            mode="adapter",
            adapter_key="0123456789abcdef",
            adapter_name="Missing Adapter",
            pci_vendor_id="ffff",
            pci_device_id="ffff",
        )
    adapter = adapters[choice]
    return OllamaDevicePreference(
        mode="adapter",
        adapter_key=adapter_key(adapter),
        adapter_name=adapter.name,
        pci_vendor_id=adapter.pci_vendor_id,
        pci_device_id=adapter.pci_device_id,
    )


def _assert_shape(policy: OllamaDevicePolicy, shape: str) -> None:
    spec = _SHAPES[shape]
    assert list(policy.environment.items()) == list(spec["env"].items())
    assert policy.cleared == spec["cleared"]
    child, _resolutions = ollama_child_environment(
        _CHILD_BASE, policy, case_insensitive=True
    )
    assert list(child.items()) == list(spec["child"].items())


@pytest.mark.parametrize(
    ("machine", "choice", "target", "backend", "shape", "application", "adapter_name"),
    [
        ("nvidia_igpu", "auto", "dedicated_gpu", "cuda", "nvidia", "applied", _RTX),
        ("nvidia_igpu", "cpu", "cpu", "cpu", "cpu", "applied", None),
        ("nvidia_igpu", "dgpu", "dedicated_gpu", "cuda", "nvidia", "applied", _RTX),
        ("nvidia_igpu", "igpu", "integrated_gpu", "vulkan", "igpu", "applied", _RADEON),
        ("nvidia_igpu", "missing", "dedicated_gpu", "cuda", "nvidia", "adapter_missing", _RTX),
        ("amd", "auto", "dedicated_gpu", "rocm", "amd", "applied", _RX),
        ("amd", "cpu", "cpu", "cpu", "cpu", "applied", None),
        ("amd", "dgpu", "dedicated_gpu", "rocm", "amd", "applied", _RX),
        ("amd", "missing", "dedicated_gpu", "rocm", "amd", "adapter_missing", _RX),
        ("arc", "auto", "dedicated_gpu", "vulkan", "vulkan_dgpu", "applied", _ARC),
        ("arc", "cpu", "cpu", "cpu", "cpu", "applied", None),
        ("arc", "dgpu", "dedicated_gpu", "vulkan", "vulkan_dgpu", "applied", _ARC),
        ("arc", "missing", "dedicated_gpu", "vulkan", "vulkan_dgpu", "adapter_missing", _ARC),
        ("igpu", "auto", "integrated_gpu", "vulkan", "igpu", "applied", _IGPU),
        ("igpu", "cpu", "cpu", "cpu", "cpu", "applied", None),
        ("igpu", "igpu", "integrated_gpu", "vulkan", "igpu", "applied", _IGPU),
        ("igpu", "missing", "integrated_gpu", "vulkan", "igpu", "adapter_missing", _IGPU),
        ("unknown", "auto", "unmanaged", None, "unmanaged", "applied", None),
        ("unknown", "cpu", "cpu", "cpu", "cpu", "applied", None),
        ("unknown", "self", "unmanaged", None, "unmanaged", "adapter_missing", None),
        ("software", "auto", "cpu", "cpu", "cpu", "applied", None),
        ("software", "cpu", "cpu", "cpu", "cpu", "applied", None),
        ("software", "missing", "cpu", "cpu", "cpu", "adapter_missing", None),
        ("no_gpu", "auto", "cpu", "cpu", "cpu", "applied", None),
        ("no_gpu", "cpu", "cpu", "cpu", "cpu", "applied", None),
        ("no_gpu", "missing", "cpu", "cpu", "cpu", "adapter_missing", None),
        ("linux", "auto", "unmanaged", None, "unmanaged", "not_applicable", None),
        ("linux", "cpu", "unmanaged", None, "unmanaged", "not_applicable", None),
        ("linux", "dgpu", "unmanaged", None, "unmanaged", "not_applicable", None),
        ("none", "auto", "unmanaged", None, "unmanaged", "not_applicable", None),
        ("none", "cpu", "unmanaged", None, "unmanaged", "not_applicable", None),
        ("none", "missing", "unmanaged", None, "unmanaged", "not_applicable", None),
    ],
)
def test_device_preference_matrix(
    machine: str,
    choice: str,
    target: str,
    backend: str | None,
    shape: str,
    application: str,
    adapter_name: str | None,
) -> None:
    inventory, adapters = _machine(machine)
    kwargs: dict[str, object] = {"preference": _preference_for(choice, adapters)}
    if inventory is None:
        kwargs["platform_name"] = "Windows"
    policy = select_ollama_device_policy(inventory, **kwargs)
    assert policy.target == target
    assert policy.backend == backend
    assert policy.application == application
    assert policy.adapter_name == adapter_name
    _assert_shape(policy, shape)


def test_auto_preference_matches_selection_without_a_preference() -> None:
    for machine in (
        "nvidia_igpu",
        "amd",
        "arc",
        "igpu",
        "unknown",
        "software",
        "no_gpu",
        "linux",
        "none",
    ):
        inventory, _adapters = _machine(machine)
        kwargs: dict[str, object] = {}
        if inventory is None:
            kwargs["platform_name"] = "Windows"
        bare = select_ollama_device_policy(inventory, **kwargs)
        auto = select_ollama_device_policy(
            inventory, preference=OllamaDevicePreference(), **kwargs
        )
        assert auto == bare
        assert list(auto.environment) == list(bare.environment)

    no_uuid = _make_inventory(
        [
            _gpu(
                "NVIDIA GeForce GTX 1660 Ti",
                classification="dedicated",
                vendor="nvidia",
                pci_vendor_id="10de",
                pci_device_id="2182",
                dedicated_memory_bytes=6 * 1024**3,
            )
        ]
    )
    intel = _gpu(
        "Intel Arc A770",
        classification="dedicated",
        pci_vendor_id="8086",
        dedicated_memory_bytes=16 * 1024**3,
    )
    amd_8gb = _gpu(
        "AMD Radeon RX 6600",
        classification="dedicated",
        pci_vendor_id="1002",
        dedicated_memory_bytes=8 * 1024**3,
    )
    nvidia_8gb = _gpu(
        "NVIDIA GeForce RTX 3070",
        classification="dedicated",
        pci_vendor_id="10de",
        device_id="GPU-12345678-0000-0000-0000-000000000000",
        dedicated_memory_bytes=8 * 1024**3,
    )
    unknown = _gpu("Unknown GPU Adapter", classification="unknown")
    rtx_4070 = _gpu(
        "NVIDIA GeForce RTX 4070",
        classification="dedicated",
        vendor="nvidia",
        pci_vendor_id="10de",
        pci_device_id="2786",
        device_id="GPU-99990000-1111-2222-3333-444455556666",
        dedicated_memory_bytes=12 * 1024**3,
    )
    for inventory in (
        no_uuid,
        _make_inventory([amd_8gb, nvidia_8gb, intel]),
        _make_inventory([amd_8gb, nvidia_8gb]),
        _make_inventory([unknown, rtx_4070]),
    ):
        bare = select_ollama_device_policy(inventory)
        auto = select_ollama_device_policy(inventory, preference=OllamaDevicePreference())
        assert auto == bare
        assert list(auto.environment) == list(bare.environment)


def test_auto_ignores_a_stored_adapter_key() -> None:
    inventory, adapters = _machine("nvidia_igpu")
    igpu = adapters["igpu"]
    stale = OllamaDevicePreference(
        mode="auto",
        adapter_key=adapter_key(igpu),
        adapter_name=igpu.name,
        pci_vendor_id=igpu.pci_vendor_id,
        pci_device_id=igpu.pci_device_id,
    )
    assert select_ollama_device_policy(inventory, preference=stale) == (
        select_ollama_device_policy(inventory)
    )


def test_chosen_adapter_is_used_when_auto_would_pick_another() -> None:
    amd = _gpu(
        "AMD Radeon RX 6600",
        classification="dedicated",
        vendor="amd",
        pci_vendor_id="1002",
        pci_device_id="73ff",
        dedicated_memory_bytes=8 * 1024**3,
    )
    nvidia = _gpu(
        "NVIDIA GeForce RTX 4090",
        classification="dedicated",
        vendor="nvidia",
        pci_vendor_id="10de",
        pci_device_id="2684",
        device_id="GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        dedicated_memory_bytes=24 * 1024**3,
    )
    inventory = _make_inventory([amd, nvidia])
    assert select_ollama_device_policy(inventory).adapter_name == nvidia.name
    selected = select_ollama_device_policy(
        inventory, preference=_preference_for("dgpu", {"dgpu": amd})
    )
    assert selected.application == "applied"
    assert selected.adapter_name == amd.name
    assert selected.backend == "rocm"
    assert selected.environment["CUDA_VISIBLE_DEVICES"] == "-1"
    assert "HIP_VISIBLE_DEVICES" not in selected.environment
    assert selected.environment["OLLAMA_VULKAN"] == "0"


def test_adapter_key_ignores_luid_and_survives_losing_nvidia_smi() -> None:
    original = _rtx(pnp_device_id=_PNP, adapter_luid="000000000001a69c")
    new_boot = _rtx(pnp_device_id=_PNP, adapter_luid="00000000000abcde")
    without_smi = _rtx(
        pnp_device_id=_PNP,
        device_id=_PNP,
        adapter_luid="00000000000fffff",
    )
    assert adapter_key(original) == adapter_key(new_boot)
    assert adapter_key(original) == adapter_key(without_smi)
    key = adapter_key(original)
    assert key is not None
    assert len(key) == 16
    assert key == key.lower()
    assert key != "000000000001a69c"

    uuid_only = _rtx(pnp_device_id=None, adapter_luid="0000000000011111")
    uuid_only_next_boot = _rtx(pnp_device_id=None, adapter_luid="0000000000022222")
    assert adapter_key(uuid_only) == adapter_key(uuid_only_next_boot)
    assert adapter_key(uuid_only) != key


def test_identical_adapter_keys_are_not_selectable() -> None:
    first = _gpu(
        "NVIDIA GeForce RTX 3070",
        classification="dedicated",
        pci_vendor_id="10de",
        pci_device_id="2484",
        dedicated_memory_bytes=8 * 1024**3,
        adapter_luid="aaaa",
    )
    second = _gpu(
        "NVIDIA GeForce RTX 3070",
        classification="dedicated",
        pci_vendor_id="10de",
        pci_device_id="2484",
        dedicated_memory_bytes=8 * 1024**3,
        adapter_luid="bbbb",
    )
    assert adapter_key(first) == adapter_key(second)
    assert adapter_key(first) is not None
    inventory = _make_inventory([first, second])
    selected = select_ollama_device_policy(
        inventory, preference=_preference_for("dgpu", {"dgpu": first})
    )
    auto = select_ollama_device_policy(inventory)
    assert selected.application == "adapter_missing"
    assert selected.target == auto.target
    assert selected.backend == auto.backend
    assert list(selected.environment.items()) == list(auto.environment.items())


def test_vendor_and_device_id_select_the_adapter_when_the_key_changed() -> None:
    original = _rtx(pnp_device_id=_PNP, adapter_luid="000000000001a69c")
    moved = _rtx(
        pnp_device_id=_PNP.replace("0008", "0009"),
        adapter_luid="0000000000099999",
    )
    assert adapter_key(moved) != adapter_key(original)
    inventory = _make_inventory([moved])
    preference = OllamaDevicePreference(
        mode="adapter",
        adapter_key=adapter_key(original),
        adapter_name="old label",
        pci_vendor_id="10DE",
        pci_device_id="28A0",
    )
    selected = select_ollama_device_policy(inventory, preference=preference)
    assert selected.application == "applied"
    assert selected.adapter_name == moved.name
    assert selected.backend == "cuda"
    assert selected.environment["CUDA_VISIBLE_DEVICES"] == _RTX_UUID

    native_only = _rtx(pnp_device_id=None, device_id=None, adapter_luid="abc")
    assert adapter_key(native_only) != adapter_key(original)
    native_selected = select_ollama_device_policy(
        _make_inventory([native_only]), preference=preference
    )
    assert native_selected.application == "applied"
    assert native_selected.backend == "cuda"
    assert "CUDA_VISIBLE_DEVICES" not in native_selected.environment


def test_two_adapters_with_the_same_pci_ids_do_not_fall_back() -> None:
    first = _rtx(pnp_device_id=_PNP + "A")
    second = _rtx(
        pnp_device_id=_PNP + "B",
        device_id="GPU-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    )
    inventory = _make_inventory([first, second])
    preference = OllamaDevicePreference(
        mode="adapter",
        adapter_key="0123456789abcdef",
        adapter_name=_RTX,
        pci_vendor_id="10de",
        pci_device_id="28a0",
    )
    selected = select_ollama_device_policy(inventory, preference=preference)
    auto = select_ollama_device_policy(inventory)
    assert selected.application == "adapter_missing"
    assert list(selected.environment.items()) == list(auto.environment.items())


def test_blank_adapter_key_falls_back_to_vendor_and_device() -> None:
    inventory, adapters = _machine("amd")
    preference = OllamaDevicePreference(
        mode="adapter",
        adapter_key=None,
        adapter_name="renamed",
        pci_vendor_id="1002",
        pci_device_id="7480",
    )
    selected = select_ollama_device_policy(inventory, preference=preference)
    assert selected.application == "applied"
    assert selected.adapter_name == adapters["dgpu"].name
    assert selected.backend == "rocm"


def _discovered_from_fixture(name: str) -> tuple[DiscoveredDevice, ...]:
    path = Path(__file__).parent / "fixtures" / "ollama_0_40_13" / name
    parser = OllamaLogParser()
    parser.feed(path.read_text(encoding="utf-8"))
    return parser.discovered_devices()


def test_correction_pins_the_igpu_a_preference_selected() -> None:
    inventory, adapters = _machine("nvidia_igpu")
    policy = select_ollama_device_policy(
        inventory, preference=_preference_for("igpu", adapters)
    )
    assert policy.application == "applied"
    assert "GGML_VK_VISIBLE_DEVICES" not in policy.environment
    corrected = corrected_device_policy(policy, _discovered_from_fixture("vulkan-igpu-enabled.log"))
    assert corrected is not None
    assert corrected.application == "applied"
    assert corrected.target == "integrated_gpu"
    assert corrected.backend == "vulkan"
    assert corrected.environment["GGML_VK_VISIBLE_DEVICES"] == "0"
    assert corrected.environment["OLLAMA_IGPU_ENABLE"] == "1"
    assert corrected.environment["CUDA_VISIBLE_DEVICES"] == "-1"
    assert corrected.environment["HIP_VISIBLE_DEVICES"] == "-1"
    assert corrected.environment["OLLAMA_LLM_LIBRARY"] == "vulkan"


def test_correction_keeps_adapter_missing_on_the_auto_fallback() -> None:
    inventory, _adapters = _machine("nvidia_igpu")
    policy = select_ollama_device_policy(
        inventory, preference=_preference_for("missing", {})
    )
    assert policy.application == "adapter_missing"
    corrected = corrected_device_policy(
        policy, _discovered_from_fixture("cuda-dgpu-hip-hidden.log")
    )
    assert corrected is not None
    assert corrected.application == "adapter_missing"
    assert corrected.environment["CUDA_VISIBLE_DEVICES"] == _RTX_UUID
    assert corrected.environment["OLLAMA_LLM_LIBRARY"] == "cuda_v13"
    assert corrected.environment["HIP_VISIBLE_DEVICES"] == "-1"
    assert corrected.environment["GGML_VK_VISIBLE_DEVICES"] == "-1"


def test_selectable_adapters_lists_dedicated_and_integrated_and_skips_software() -> None:
    inventory, adapters = _machine("nvidia_igpu")
    listed = selectable_adapters(inventory)
    assert [item.name for item in listed] == [adapters["igpu"].name, adapters["dgpu"].name]
    dedicated = listed[1]
    integrated = listed[0]
    assert dedicated.selectable is True
    assert dedicated.classification == "dedicated"
    assert dedicated.backend == "cuda"
    assert dedicated.adapter_key == adapter_key(adapters["dgpu"])
    assert integrated.selectable is True
    assert integrated.classification == "integrated"
    assert integrated.backend == "vulkan"
    assert integrated.adapter_key == adapter_key(adapters["igpu"])


def test_selectable_adapters_on_an_igpu_only_machine() -> None:
    inventory, adapters = _machine("igpu")
    listed = selectable_adapters(inventory)
    assert len(listed) == 1
    assert listed[0].name == adapters["igpu"].name
    assert listed[0].selectable is True
    assert listed[0].classification == "integrated"
    assert listed[0].backend == "vulkan"


def test_selectable_adapters_lists_an_unknown_adapter_as_not_selectable() -> None:
    inventory, adapters = _machine("unknown")
    listed = selectable_adapters(inventory)
    assert len(listed) == 1
    assert listed[0].name == adapters["self"].name
    assert listed[0].selectable is False
    assert listed[0].classification == "unknown"
    assert listed[0].backend is None
    assert listed[0].adapter_key == adapter_key(adapters["self"])


def test_selectable_adapters_marks_a_duplicate_key_not_selectable() -> None:
    first = _rtx(pnp_device_id=_PNP)
    second = _gpu(
        "NVIDIA GeForce RTX 4060 Laptop GPU Copy",
        classification="dedicated",
        vendor="nvidia",
        pci_vendor_id="10de",
        pci_device_id="28a0",
        device_id="GPU-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        pnp_device_id=_PNP,
    )
    listed = selectable_adapters(_make_inventory([first, second]))
    assert len(listed) == 2
    assert listed[0].adapter_key == listed[1].adapter_key
    assert listed[0].adapter_key is not None
    assert all(item.selectable is False for item in listed)
    assert all(item.backend == "cuda" for item in listed)


def test_selectable_adapters_is_empty_off_windows_and_without_inventory() -> None:
    linux, _adapters = _machine("linux")
    assert selectable_adapters(linux) == ()
    assert selectable_adapters(None) == ()

