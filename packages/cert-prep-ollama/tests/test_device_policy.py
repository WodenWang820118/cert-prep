"""Tests for device selection policy, environment configuration, and corrections."""

from __future__ import annotations

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
    corrected_device_policy,
    normalize_device_name,
    ollama_child_environment,
    parse_pci_bus,
    select_ollama_device_policy,
)
from cert_prep_ollama.profiles import select_ollama_execution_policy
from cert_prep_ollama.server_log import DiscoveredDevice


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

