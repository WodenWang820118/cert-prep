"""Hardware-free regression fixtures for native GPU classification and identity."""

from dataclasses import replace
from types import SimpleNamespace
import ctypes
import subprocess

import pytest

from cert_prep_contracts.hardware import (
    MachineAcceleratorSnapshot,
    MachineCpuSnapshot,
    MachineInventorySnapshot,
    MachineRamSnapshot,
    MachineStorageSnapshot,
)
from cert_prep_contracts.llm import LLMExecutionMode
from cert_prep_ollama import _native_gpu_inventory as native, inventory
from cert_prep_ollama.profiles import (
    DEFAULT_PROFILE_ID,
    GIB,
    profile_by_id,
    profile_requirement_warnings,
    select_ollama_execution_policy,
    select_ollama_profile,
)


@pytest.fixture
def laptop(monkeypatch):
    records = (
        native._NativeAdapter(
            0,
            "AMD Radeon(TM) 880M Graphics",
            "1002",
            "150e",
            "0000000000012fd0",
            298_012_672,
            16_706_365_440,
            False,
            True,
        ),
        native._NativeAdapter(
            1,
            "NVIDIA GeForce RTX 4060 Laptop GPU",
            "10de",
            "28a0",
            "000000000001a69c",
            8_342_470_656,
            16_706_365_440,
            False,
            False,
        ),
        native._NativeAdapter(
            2,
            "Microsoft Basic Render Driver",
            "1414",
            "008c",
            "000000000001a625",
            0,
            16_706_365_440,
            True,
            None,
        ),
    )
    monkeypatch.setattr(native, "_native_enumerate_adapters", lambda: records)
    return records


def _machine(accelerators):
    return MachineInventorySnapshot(
        platform="Windows",
        platform_version="",
        architecture="AMD64",
        cpu=MachineCpuSnapshot(architecture="AMD64"),
        ram=MachineRamSnapshot(32 * GIB, 16 * GIB),
        storage=MachineStorageSnapshot("fixture", 64 * GIB, 128 * GIB),
        accelerators=tuple(accelerators),
    )


def test_exact_laptop_native_table_and_reserved_integrated_memory(laptop):
    warnings = []
    snapshots = native._native_gpu_accelerators(warnings)
    assert warnings == []
    assert [item.classification for item in snapshots] == ["integrated", "dedicated", "software"]
    assert [item.dedicated_memory_bytes for item in snapshots] == [298_012_672, 8_342_470_656, 0]
    assert all(item.shared_memory_bytes == 16_706_365_440 for item in snapshots)
    assert all(item.classification_source == "native_dxgi" for item in snapshots)
    assert snapshots[1].pci_vendor_id == "10de"
    assert snapshots[1].pci_device_id == "28a0"
    assert snapshots[1].adapter_luid == "000000000001a69c"
    # Only physical GPUs count, even though software remains visible diagnostically.
    assert sum(item.kind == "gpu" and item.classification != "software" for item in snapshots) == 2
    assert select_ollama_execution_policy(_machine([snapshots[2]])).mode == LLMExecutionMode.CPU


@pytest.mark.parametrize("claim", ["rocm", "ollama"])
def test_false_discrete_claim_never_overrides_native_uma(laptop, claim):
    false_report = MachineAcceleratorSnapshot(
        kind="gpu",
        name=laptop[0].name,
        memory_bytes=12 * GIB,
        classification="dedicated",
        classification_source="vendor_tool",
    )
    result = inventory._merge_accelerator_sources(
        [[false_report], native._native_gpu_accelerators([])], []
    )
    assert result[0].classification == "integrated", claim
    assert result[0].classification_source == "native_dxgi"
    assert result[0].memory_bytes == 12 * GIB  # Keep the legacy observation unchanged.
    assert result[0].dedicated_memory_bytes == 298_012_672


def test_nvidia_cim_and_native_join_once_and_keep_all_identifiers(monkeypatch, laptop):
    monkeypatch.setattr(inventory.shutil, "which", lambda _: "nvidia-smi")
    monkeypatch.setattr(
        inventory.subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(
            args[0], 0, f"{laptop[1].name}, 8188, 581.80, GPU-fixture, 0x28A010DE\n", ""
        ),
    )
    nvidia = inventory._nvidia_smi_accelerators(1)
    pnp = r"PCI\VEN_10DE&DEV_28A0&SUBSYS_12345678\4&123&0&0009"
    monkeypatch.setattr(
        inventory,
        "_run_windows_powershell_json",
        lambda *args: {
            "Name": laptop[1].name,
            "PNPDeviceID": pnp,
            "AdapterRAM": 1_048_576,
            "DriverVersion": "32.0.15.8180",
        },
    )
    cim = inventory._windows_video_accelerators(1, [])
    result = inventory._merge_accelerator_sources(
        [nvidia, cim, native._native_gpu_accelerators([])], []
    )
    assert len(result) == 3
    rtx = next(item for item in result if item.classification == "dedicated")
    assert rtx.device_id == "GPU-fixture"
    assert rtx.pnp_device_id == pnp
    assert rtx.adapter_luid == laptop[1].adapter_luid
    assert rtx.memory_bytes == 8188 * 1024 * 1024
    assert rtx.dedicated_memory_bytes == 8_342_470_656  # Not truncated CIM AdapterRAM.
    assert rtx.driver_version == "581.80"


def test_matching_pci_joins_driver_name_variants(laptop):
    cim = MachineAcceleratorSnapshot(
        kind="gpu",
        name="NVIDIA GeForce RTX4060",
        pci_vendor_id="10de",
        pci_device_id="28a0",
    )
    assert len(inventory._merge_accelerator_sources([[cim], [laptop[1].snapshot()]], [])) == 1


def test_missing_nvidia_memory_uses_cim_legacy_value_before_native_fallback(laptop):
    nvidia = MachineAcceleratorSnapshot(kind="gpu", name=laptop[1].name, device_id="GPU-1")
    cim = replace(nvidia, device_id="PCI-1", pnp_device_id="PCI-1", memory_bytes=GIB)
    result = inventory._merge_accelerator_sources([[nvidia], [cim], [laptop[1].snapshot()]], [])
    assert len(result) == 1
    assert result[0].memory_bytes == GIB
    assert result[0].dedicated_memory_bytes == 8_342_470_656
    assert result[0].device_id == "GPU-1"
    assert result[0].pnp_device_id == "PCI-1"


def test_duplicate_names_and_ambiguous_identities_are_not_collapsed(laptop):
    first = laptop[1].snapshot()
    second = replace(first, adapter_luid="0000000000000002")
    source = MachineAcceleratorSnapshot(kind="gpu", name=first.name, device_id="GPU-ambiguous")
    warnings = []
    result = inventory._merge_accelerator_sources([[first, second], [source]], warnings)
    assert len(result) == 2
    assert "Ambiguous GPU identity" in warnings[0]
    assert all(item.device_id is None for item in result)
    assert "GPU-ambiguous" in warnings[0]


def test_two_nvidia_uuids_contending_for_one_native_row_are_order_independent(laptop):
    native_gpu = laptop[1].snapshot()
    observations = [
        MachineAcceleratorSnapshot(
            kind="gpu",
            name=native_gpu.name,
            device_id=f"GPU-{number}",
            pci_vendor_id=native_gpu.pci_vendor_id,
            pci_device_id=native_gpu.pci_device_id,
        )
        for number in (1, 2)
    ]
    warnings = []
    result = inventory._merge_accelerator_sources([observations, [native_gpu]], warnings)
    reversed_warnings = []
    reversed_result = inventory._merge_accelerator_sources(
        [observations[::-1], [native_gpu]], reversed_warnings
    )

    assert result == reversed_result
    assert len(result) == 3
    assert result[0] == native_gpu
    assert {item.device_id for item in result[1:]} == {"GPU-1", "GPU-2"}
    assert all(item.adapter_luid is None for item in result[1:])
    assert all(item.classification == "unknown" for item in result[1:])
    assert warnings == reversed_warnings
    assert len(warnings) == 1
    assert all(value in warnings[0] for value in ("Ambiguous GPU identity", "GPU-1", "GPU-2"))


@pytest.mark.parametrize("identifier", ["device_id", "adapter_luid", "pnp_device_id"])
def test_exact_identifier_separates_observations_contending_for_one_row(laptop, identifier):
    native_gpu = replace(laptop[1].snapshot(), **{identifier: "exact-identity"})
    exact = MachineAcceleratorSnapshot(
        kind="gpu", name=native_gpu.name, **{identifier: "exact-identity"}
    )
    unmatched = MachineAcceleratorSnapshot(kind="gpu", name=native_gpu.name, device_id="GPU-other")
    warnings = []
    result = inventory._merge_accelerator_sources([[unmatched, exact], [native_gpu]], warnings)
    reversed_result = inventory._merge_accelerator_sources([[exact, unmatched], [native_gpu]], [])

    assert result == reversed_result
    assert len(result) == 2
    assert result[0].classification == "dedicated"
    assert getattr(result[0], identifier) == "exact-identity"
    assert result[1].device_id == "GPU-other"
    assert result[1].classification == "unknown"
    assert warnings == []


def test_repeated_exact_identity_is_deduplicated_within_one_source(laptop):
    first = MachineAcceleratorSnapshot(kind="gpu", name=laptop[1].name, device_id="GPU-1")
    repeated = replace(first, name=first.name.swapcase())
    warnings = []
    result = inventory._merge_accelerator_sources([[first, repeated], [laptop[1].snapshot()]], warnings)

    assert len(result) == 1
    assert result[0].device_id == "GPU-1"
    assert result[0].classification == "dedicated"
    assert warnings == []


@pytest.mark.parametrize("device_ids", [("GPU-1", "GPU-2"), (None, None), ("", "")])
def test_same_source_identical_gpus_without_a_shared_nonempty_id_stay_separate(device_ids):
    observations = [
        MachineAcceleratorSnapshot(kind="gpu", name="identical GPU", device_id=device_id)
        for device_id in device_ids
    ]
    result = inventory._merge_accelerator_sources([observations], [])

    assert len(result) == 2
    assert [item.device_id for item in result] == list(device_ids)


@pytest.mark.parametrize(
    "nvidia_driver,cim_driver,expected",
    [("581.80", "32.0.15.8180", "581.80"), (None, "32.0.15.8180", "32.0.15.8180"),
     (None, None, "native-driver")],
)
def test_driver_precedence_without_nvidia_uuid(laptop, nvidia_driver, cim_driver, expected):
    native_gpu = replace(laptop[1].snapshot(), driver_version="native-driver")
    nvidia = MachineAcceleratorSnapshot(
        kind="gpu", name=native_gpu.name, driver_version=nvidia_driver, memory_bytes=8 * GIB
    )
    cim = replace(nvidia, device_id="PCI-1", driver_version=cim_driver, memory_bytes=GIB)
    result = inventory._merge_accelerator_sources([[nvidia], [cim], [native_gpu]], [])

    assert len(result) == 1
    assert result[0].driver_version == expected
    assert result[0].memory_bytes == 8 * GIB
    assert result[0].device_id == "PCI-1"
    assert result[0].classification == "dedicated"


def test_two_identical_gpus_stay_two_when_all_three_sources_report_them(laptop):
    first = laptop[1].snapshot()
    second = replace(first, adapter_luid="0000000000000002")
    nvidia = [
        replace(first, adapter_luid=None, classification_source=None, device_id=f"GPU-{i}")
        for i in range(2)
    ]
    cim = [
        replace(
            first,
            adapter_luid=None,
            classification_source=None,
            device_id=f"PCI-{i}",
            pnp_device_id=f"PCI-{i}",
        )
        for i in range(2)
    ]
    warnings = []
    result = inventory._merge_accelerator_sources([nvidia, cim, [first, second]], warnings)
    assert len(result) == 2
    assert {item.adapter_luid for item in result} == {first.adapter_luid, second.adapter_luid}
    assert all(item.classification == "dedicated" for item in result)
    assert len(warnings) == 4


def test_same_name_with_different_pci_devices_stays_separate(laptop):
    other = replace(laptop[1].snapshot(), pci_device_id="ffff", adapter_luid=None)
    assert len(inventory._merge_accelerator_sources([[laptop[1].snapshot()], [other]], [])) == 2


def test_normalized_name_fallback_without_pci_ids(laptop):
    source = MachineAcceleratorSnapshot(kind="gpu", name="AMD Radeon 880M Graphics")
    result = inventory._merge_accelerator_sources([[source], [laptop[0].snapshot()]], [])
    assert len(result) == 1
    assert result[0].classification == "integrated"


def test_cim_access_denied_and_unavailable_native_degrade_to_unknown(monkeypatch, laptop):
    monkeypatch.setattr(inventory, "os", SimpleNamespace(name="nt"))
    monkeypatch.setattr(
        inventory,
        "_nvidia_smi_accelerators",
        lambda _: [
            MachineAcceleratorSnapshot(kind="gpu", name=laptop[1].name, device_id="GPU-fixture")
        ],
    )
    monkeypatch.setattr(inventory, "_windows_npu_accelerators", lambda *args: [])
    monkeypatch.setattr(inventory, "_resolve_windows_powershell", lambda: "powershell")
    monkeypatch.setattr(
        inventory.subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 1, "", "HRESULT 0x80041003"),
    )

    def unavailable():
        raise OSError("DXGI unavailable in sandbox")

    monkeypatch.setattr(native, "_native_enumerate_adapters", unavailable)
    warnings = []
    result = inventory._accelerators(1, warnings)
    assert len(result) == 1
    assert result[0].classification == "unknown"
    assert result[0].classification_source == "unknown"
    assert "Unable to collect Windows GPU inventory." in warnings
    assert any("Native GPU classification unavailable" in note for note in warnings)


def test_non_windows_inventory_retains_unknown_vendor_gpu_with_evidence_note(monkeypatch):
    monkeypatch.setattr(native.sys, "platform", "linux")
    monkeypatch.setattr(inventory, "os", SimpleNamespace(name="posix"))
    monkeypatch.setattr(
        inventory,
        "_nvidia_smi_accelerators",
        lambda _: [MachineAcceleratorSnapshot(kind="gpu", name="NVIDIA GPU", memory_bytes=8 * GIB)],
    )
    warnings = []
    result = inventory._accelerators(1, warnings)
    assert result[0].classification == "unknown"
    assert "unavailable on this platform" in warnings[0]


def test_missing_native_architecture_has_named_unknown_evidence(monkeypatch, laptop):
    monkeypatch.setattr(
        native,
        "_native_enumerate_adapters",
        lambda: [replace(laptop[0], uma=None, evidence_note="D3D12 unavailable")],
    )
    warnings = []
    result = native._native_gpu_accelerators(warnings)
    assert result[0].classification == "unknown"
    assert result[0].dedicated_memory_bytes == 298_012_672
    assert "AMD Radeon" in warnings[0] and "D3D12 unavailable" in warnings[0]


@pytest.mark.parametrize("uma,coherent,expected", [(1, 1, True), (0, 0, False), (0, 1, None)])
def test_native_architecture_and_contradiction(monkeypatch, uma, coherent, expected):
    released = []

    def create_device(adapter, level, interface, output):
        assert level == 0xB000
        output._obj.value = 123
        return 0

    def check_feature(device, feature, output, size):
        assert feature == 1
        assert size == ctypes.sizeof(native._Architecture)
        output._obj.uma = uma
        output._obj.cache_coherent_uma = coherent
        return 0

    monkeypatch.setattr(
        native.ctypes,
        "WinDLL",
        lambda _: SimpleNamespace(D3D12CreateDevice=create_device),
        raising=False,
    )
    monkeypatch.setattr(native, "_com_method", lambda *args: check_feature)
    monkeypatch.setattr(native, "_release_com", lambda value: released.append(value.value))
    result, note = native._native_adapter_uma(ctypes.c_void_p(456))
    assert result is expected
    assert (note is not None) == (expected is None)
    assert released == [123]


@pytest.mark.parametrize("failure", ["device", "feature", "library"])
def test_d3d12_unavailability_retains_evidence_and_releases_device(monkeypatch, failure):
    released = []

    def create_device(adapter, level, interface, output):
        if failure == "device":
            return -2147467259  # E_FAIL
        output._obj.value = 123
        return 0

    def load_library(name):
        if failure == "library":
            raise OSError("D3D12 unavailable")
        return SimpleNamespace(D3D12CreateDevice=create_device)

    monkeypatch.setattr(native.ctypes, "WinDLL", load_library, raising=False)
    monkeypatch.setattr(native, "_com_method", lambda *args: lambda *values: -2147467259)
    monkeypatch.setattr(native, "_release_com", lambda value: released.append(value.value))
    result, note = native._native_adapter_uma(ctypes.c_void_p(456))
    assert result is None
    assert "unavailable" in note
    assert released == ([123] if failure == "feature" else [None])


@pytest.mark.parametrize(
    "classification,memory,expected",
    [
        ("dedicated", 8 * GIB, True),
        ("dedicated", None, True),
        ("integrated", 298_012_672, False),
        ("software", 0, False),
        ("unknown", None, True),
        (None, None, True),
    ],
)
def test_profile_vram_uses_dedicated_memory_or_unknown_legacy_fallback(
    classification,
    memory,
    expected,
):
    gpu = MachineAcceleratorSnapshot(
        kind="gpu",
        name="fixture",
        memory_bytes=12 * GIB,
        classification=classification,
        dedicated_memory_bytes=memory,
        shared_memory_bytes=16 * GIB,
    )
    profile = replace(profile_by_id(DEFAULT_PROFILE_ID), min_vram_bytes=6 * GIB)
    warnings = profile_requirement_warnings(profile, _machine([gpu]))
    assert (not warnings) is expected


def test_unknown_gpu_memory_cannot_outweigh_confirmed_dedicated_memory():
    unknown = MachineAcceleratorSnapshot(
        kind="gpu", name="unknown GPU", classification="unknown", memory_bytes=12 * GIB
    )
    dedicated = MachineAcceleratorSnapshot(
        kind="gpu", name="dedicated GPU", classification="dedicated",
        memory_bytes=12 * GIB, dedicated_memory_bytes=8 * GIB,
    )
    profile = replace(profile_by_id(DEFAULT_PROFILE_ID), min_vram_bytes=10 * GIB)

    for accelerators in ([unknown, dedicated], [dedicated, unknown]):
        assert profile_requirement_warnings(profile, _machine(accelerators)) == (
            f"Accelerator memory is below {DEFAULT_PROFILE_ID} target ({8 * GIB} < {10 * GIB}).",
        )


@pytest.mark.parametrize("classification", [None, "unknown"])
def test_unknown_only_gpu_keeps_legacy_memory_for_vram_requirements(classification):
    gpu = MachineAcceleratorSnapshot(
        kind="gpu", name="legacy GPU", classification=classification,
        memory_bytes=12 * GIB, dedicated_memory_bytes=GIB,
    )
    profile = replace(profile_by_id(DEFAULT_PROFILE_ID), min_vram_bytes=10 * GIB)

    assert profile_requirement_warnings(profile, _machine([gpu])) == ()


def test_integrated_only_gpu_has_unknown_vram():
    gpu = MachineAcceleratorSnapshot(
        kind="gpu", name="integrated GPU", classification="integrated",
        memory_bytes=12 * GIB, dedicated_memory_bytes=GIB,
    )
    profile = replace(profile_by_id(DEFAULT_PROFILE_ID), min_vram_bytes=10 * GIB)

    assert profile_requirement_warnings(profile, _machine([gpu])) == (
        "Accelerator memory is unknown.",
    )


def test_dedicated_gpu_without_any_memory_does_not_fall_back_to_unknown_gpu():
    unknown = MachineAcceleratorSnapshot(
        kind="gpu", name="unknown GPU", classification="unknown", memory_bytes=12 * GIB
    )
    dedicated = MachineAcceleratorSnapshot(
        kind="gpu", name="dedicated GPU", classification="dedicated"
    )
    profile = replace(profile_by_id(DEFAULT_PROFILE_ID), min_vram_bytes=10 * GIB)

    assert profile_requirement_warnings(profile, _machine([unknown, dedicated])) == (
        "Accelerator memory is unknown.",
    )


def test_shared_igpu_memory_cannot_outweigh_rtx_and_fixed_profile_is_preserved(laptop):
    machine = _machine(native._native_gpu_accelerators([]))
    profile = replace(profile_by_id(DEFAULT_PROFILE_ID), min_vram_bytes=10 * GIB)
    assert "8342470656 < 10737418240" in profile_requirement_warnings(profile, machine)[0]
    selection = select_ollama_profile(machine)
    assert selection.profile_id == DEFAULT_PROFILE_ID
    assert selection.selected_profile.base_model == "qwen3.5:4b"
    assert selection.fallback_profiles == ()
