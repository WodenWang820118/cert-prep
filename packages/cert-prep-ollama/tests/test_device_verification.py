"""Tests for device execution verification against selected policies."""

from __future__ import annotations

from pathlib import Path

from cert_prep_ollama.device_policy import OllamaDevicePolicy
from cert_prep_ollama.device_verification import verify_device_execution
from cert_prep_ollama.server_log import (
    BackendLoaded,
    DiscoveredDevice,
    LayerOffload,
    OllamaLogParser,
    RunnerDevice,
    SchedulerSelection,
)

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "ollama_0_40_13"


def test_cuda_target_with_rocm_fixture_gives_mismatch() -> None:
    text = (FIXTURES_DIR / "rocm-igpu-selected-with-cuda-present.log").read_text(
        encoding="utf-8"
    )
    parser = OllamaLogParser()
    parser.feed(text)

    cuda_policy = OllamaDevicePolicy(
        target="dedicated_gpu",
        backend="cuda",
        adapter_name="NVIDIA GeForce RTX 4060 Laptop GPU",
        pci_bus="0000:63:00.0",
    )

    execution = verify_device_execution(
        cuda_policy,
        parser.latest_load(),
        parser.discovered_devices(),
    )

    assert execution.state == "mismatch"
    assert execution.target == "dedicated_gpu"
    assert execution.backend == "cuda"
    assert execution.observed_library == "ROCm0"
    assert execution.observed_description == "AMD Radeon(TM) 880M Graphics"


def test_cuda_target_with_cuda_fixture_gives_verified() -> None:
    text = (FIXTURES_DIR / "cuda-dgpu-hip-hidden.log").read_text(encoding="utf-8")
    parser = OllamaLogParser()
    parser.feed(text)

    cuda_policy = OllamaDevicePolicy(
        target="dedicated_gpu",
        backend="cuda",
        adapter_name="NVIDIA GeForce RTX 4060 Laptop GPU",
        pci_bus="0000:63:00.0",
    )

    execution = verify_device_execution(
        cuda_policy,
        parser.latest_load(),
        parser.discovered_devices(),
    )

    assert execution.state == "verified"
    assert execution.target == "dedicated_gpu"
    assert execution.backend == "cuda"
    assert execution.observed_library == "CUDA0"
    assert execution.observed_description == "NVIDIA GeForce RTX 4060 Laptop GPU"
    assert execution.observed_pci_bus == "0000:63:00.0"
    assert execution.offloaded_layers == 34
    assert execution.total_layers == 34


def test_igpu_target_with_vulkan_fixture_gives_verified() -> None:
    text = (FIXTURES_DIR / "vulkan-igpu-enabled.log").read_text(encoding="utf-8")
    parser = OllamaLogParser()
    parser.feed(text)

    vulkan_policy = OllamaDevicePolicy(
        target="integrated_gpu",
        backend="vulkan",
        adapter_name="AMD Radeon(TM) 880M Graphics",
    )

    execution = verify_device_execution(
        vulkan_policy,
        parser.latest_load(),
        parser.discovered_devices(),
    )

    assert execution.state == "verified"
    assert execution.target == "integrated_gpu"
    assert execution.backend == "vulkan"
    assert execution.observed_library == "Vulkan0"
    assert execution.observed_description == "AMD Radeon(TM) 880M Graphics"


def test_cpu_target_with_cpu_fixture_gives_verified() -> None:
    text = (FIXTURES_DIR / "cpu-all-gpus-hidden.log").read_text(encoding="utf-8")
    parser = OllamaLogParser()
    parser.feed(text)

    cpu_policy = OllamaDevicePolicy(
        target="cpu",
        backend="cpu",
    )

    execution = verify_device_execution(
        cpu_policy,
        parser.latest_load(),
        parser.discovered_devices(),
    )

    assert execution.state == "verified"
    assert execution.target == "cpu"
    assert execution.backend == "cpu"
    assert execution.observed_library == "CPU"
    assert execution.offloaded_layers is None


def test_cpu_target_with_gpu_offload_gives_mismatch() -> None:
    cpu_policy = OllamaDevicePolicy(
        target="cpu",
        backend="cpu",
    )

    # Synthetic load records where GPU layers were offloaded
    load_records = [
        RunnerDevice(device_name="CUDA0", description="RTX 4060", pci_bus="0000:63:00.0"),
        LayerOffload(offloaded_layers=34, total_layers=34),
    ]

    execution = verify_device_execution(
        cpu_policy,
        load_records,
        (),
    )

    assert execution.state == "mismatch"
    assert "layers offloaded to GPU" in execution.detail


def test_discovery_only_gives_selected_unverified() -> None:
    policy = OllamaDevicePolicy(
        target="dedicated_gpu",
        backend="cuda",
        adapter_name="NVIDIA GeForce RTX 4060 Laptop GPU",
    )
    discovered = [
        DiscoveredDevice(
            library="CUDA",
            id="0",
            filter_id="0",
            name="CUDA0",
            description="NVIDIA GeForce RTX 4060 Laptop GPU",
            pci_id="0000:63:00.0",
            type="discrete",
            total=8 * 1024**3,
            available=7 * 1024**3,
            libdirs=("ollama", "cuda_v13"),
        )
    ]

    execution = verify_device_execution(policy, (), discovered)

    assert execution.state == "selected_unverified"


def test_empty_evidence_gives_unknown() -> None:
    policy = OllamaDevicePolicy(
        target="dedicated_gpu",
        backend="cuda",
        adapter_name="RTX 4060",
    )
    execution = verify_device_execution(policy, (), ())
    assert execution.state == "unknown"


def test_unmanaged_policy_gives_unknown() -> None:
    policy = OllamaDevicePolicy(target="unmanaged", backend=None)
    load_records = [
        RunnerDevice(device_name="CUDA0", description="RTX 4060", pci_bus="0000:63:00.0"),
        LayerOffload(offloaded_layers=34, total_layers=34),
    ]
    execution = verify_device_execution(policy, load_records, ())
    assert execution.state == "unknown"


def test_partial_offload_is_still_verified() -> None:
    policy = OllamaDevicePolicy(
        target="dedicated_gpu",
        backend="cuda",
        adapter_name="NVIDIA GeForce RTX 4060 Laptop GPU",
    )
    load_records = [
        BackendLoaded(library="CUDA", token="cuda_v13"),
        RunnerDevice(
            device_name="CUDA0",
            description="NVIDIA GeForce RTX 4060 Laptop GPU",
            pci_bus=None,
        ),
        LayerOffload(offloaded_layers=32, total_layers=33),
    ]

    execution = verify_device_execution(policy, load_records, ())

    assert execution.state == "verified"
    assert execution.offloaded_layers == 32
    assert execution.total_layers == 33


def test_cuda_target_with_zero_offload_gives_mismatch() -> None:
    policy = OllamaDevicePolicy(
        target="dedicated_gpu",
        backend="cuda",
        adapter_name="NVIDIA GeForce RTX 4060 Laptop GPU",
        pci_bus="0000:63:00.0",
    )
    load_records = [
        BackendLoaded(library="CUDA", token="cuda_v13"),
        RunnerDevice(
            device_name="CUDA0",
            description="NVIDIA GeForce RTX 4060 Laptop GPU",
            pci_bus="0000:63:00.0",
        ),
        LayerOffload(offloaded_layers=0, total_layers=34),
    ]

    execution = verify_device_execution(policy, load_records, ())

    assert execution.state == "mismatch"
    assert execution.offloaded_layers == 0
    assert execution.total_layers == 34
    assert "no layers were offloaded to the gpu" in execution.detail.lower()
    assert "model runs on the CPU" in execution.detail


def test_cuda_target_with_scheduler_selection_only_gives_mismatch() -> None:
    cuda_policy = OllamaDevicePolicy(
        target="dedicated_gpu",
        backend="cuda",
        adapter_name="NVIDIA GeForce RTX 4060 Laptop GPU",
        pci_bus="0000:63:00.0",
    )
    selection = SchedulerSelection(
        library="ROCm",
        name="ROCm0",
        description="AMD Radeon(TM) 880M Graphics",
        integrated=False,
        id="0",
        filter_id="0",
    )
    discovered = [
        DiscoveredDevice(
            library="CUDA",
            id="0",
            filter_id="0",
            name="CUDA0",
            description="NVIDIA GeForce RTX 4060 Laptop GPU",
            pci_id="0000:63:00.0",
            type="discrete",
            total=8 * 1024**3,
            available=7 * 1024**3,
            libdirs=("ollama", "cuda_v13"),
        )
    ]

    execution = verify_device_execution(cuda_policy, (selection,), discovered)

    assert execution.state == "mismatch"
    assert execution.observed_library == "ROCm"
    assert execution.observed_description == "AMD Radeon(TM) 880M Graphics"


def test_device_verification_pci_bus_hex_formats() -> None:
    policy = OllamaDevicePolicy(
        target="dedicated_gpu",
        backend="cuda",
        adapter_name="NVIDIA GeForce RTX 4060 Laptop GPU",
        pci_bus="0000:63:00.0",
    )

    # 1. 00000000:63:00.0 matches 0000:63:00.0
    rec_8digit = [
        RunnerDevice(
            device_name="CUDA0",
            description="NVIDIA GeForce RTX 4060 Laptop GPU",
            pci_bus="00000000:63:00.0",
        )
    ]
    exec_8digit = verify_device_execution(policy, rec_8digit, ())
    assert exec_8digit.state == "verified"

    # 2. Upper-case hex 0000:63:00.0 matches
    rec_upper = [
        RunnerDevice(
            device_name="CUDA0",
            description="NVIDIA GeForce RTX 4060 Laptop GPU",
            pci_bus="0000:63:00.0".upper(),
        )
    ]
    exec_upper = verify_device_execution(policy, rec_upper, ())
    assert exec_upper.state == "verified"

    # 3. 0000:65:00.0 does NOT match
    rec_different = [
        RunnerDevice(
            device_name="CUDA0",
            description="NVIDIA GeForce RTX 4060 Laptop GPU",
            pci_bus="0000:65:00.0",
        )
    ]
    exec_different = verify_device_execution(policy, rec_different, ())
    assert exec_different.state == "mismatch"
