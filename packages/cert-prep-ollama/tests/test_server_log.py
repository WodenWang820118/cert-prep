"""Tests for Ollama server log stream parser and record types."""

from __future__ import annotations

from pathlib import Path
import random

from cert_prep_ollama.server_log import (
    BackendLoaded,
    DroppedDevice,
    LayerOffload,
    ModelLoadStarted,
    OllamaLogParser,
    RunnerDevice,
    RunnerStarted,
    SchedulerSelection,
    VisibleDevicesOverride,
    parse_bytes,
)

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "ollama_0_40_13"


def test_rocm_fixture_records() -> None:
    log_text = (FIXTURES_DIR / "rocm-igpu-selected-with-cuda-present.log").read_text(
        encoding="utf-8"
    )
    parser = OllamaLogParser()
    parser.feed(log_text)

    records = parser.records()
    assert len(records) > 0

    # 1. Dropped integrated Vulkan GPU
    dropped = [r for r in records if isinstance(r, DroppedDevice)]
    assert len(dropped) == 1
    assert dropped[0].library == "Vulkan"
    assert dropped[0].name == "Vulkan0"
    assert dropped[0].description == "AMD Radeon(TM) 880M Graphics"

    # 2. Discovery
    discovered = parser.discovered_devices()
    assert len(discovered) == 2
    assert discovered[0].library == "ROCm"
    assert discovered[0].name == "ROCm0"
    assert discovered[0].description == "AMD Radeon(TM) 880M Graphics"
    assert discovered[0].libdirs == ("ollama", "rocm_v7_1")

    assert discovered[1].library == "CUDA"
    assert discovered[1].name == "CUDA0"
    assert discovered[1].description == "NVIDIA GeForce RTX 4060 Laptop GPU"
    assert discovered[1].pci_id == "0000:63:00.0"
    assert discovered[1].libdirs == ("ollama", "cuda_v13")

    # 3. Scheduler Selection
    selections = [r for r in records if isinstance(r, SchedulerSelection)]
    assert len(selections) == 1
    assert selections[0].library == "ROCm"
    assert selections[0].name == "ROCm0"
    assert selections[0].description == "AMD Radeon(TM) 880M Graphics"

    # 4. Model load boundary
    boundaries = [r for r in records if isinstance(r, ModelLoadStarted)]
    assert len(boundaries) >= 1

    # 5. Latest load records
    load_records = parser.latest_load()
    assert len(load_records) > 0
    assert isinstance(load_records[0], SchedulerSelection)
    assert load_records[0].name == "ROCm0"
    assert load_records[0].library == "ROCm"
    assert load_records[0].description == "AMD Radeon(TM) 880M Graphics"

    runner_devices = [r for r in load_records if isinstance(r, RunnerDevice)]
    assert len(runner_devices) == 1
    assert runner_devices[0].device_name == "ROCm0"
    assert runner_devices[0].description == "AMD Radeon(TM) 880M Graphics"
    assert runner_devices[0].pci_bus == "0000:65:00.0"

    backends = [r for r in load_records if isinstance(r, BackendLoaded)]
    assert any(b.library == "ROCm" and b.token == "rocm_v7_1" for b in backends)

    offloads = [r for r in load_records if isinstance(r, LayerOffload)]
    assert len(offloads) == 1
    assert offloads[0].offloaded_layers == 34
    assert offloads[0].total_layers == 34

    starters = [r for r in load_records if isinstance(r, RunnerStarted)]
    assert len(starters) == 1
    assert starters[0].duration_seconds == 8.05


def test_cuda_fixture_records() -> None:
    log_text = (FIXTURES_DIR / "cuda-dgpu-hip-hidden.log").read_text(encoding="utf-8")
    parser = OllamaLogParser()
    parser.feed(log_text)

    records = parser.records()

    # Visible device overrides
    overrides = [r for r in records if isinstance(r, VisibleDevicesOverride)]
    assert len(overrides) >= 1
    assert any(o.variable == "HIP_VISIBLE_DEVICES" and o.value == "-1" for o in overrides)

    # Discovery
    discovered = parser.discovered_devices()
    assert any(d.library == "CUDA" and d.name == "CUDA0" for d in discovered)

    # Latest load
    load_records = parser.latest_load()
    runner_devices = [r for r in load_records if isinstance(r, RunnerDevice)]
    assert len(runner_devices) == 1
    assert runner_devices[0].device_name == "CUDA0"
    assert runner_devices[0].description == "NVIDIA GeForce RTX 4060 Laptop GPU"
    assert runner_devices[0].pci_bus == "0000:63:00.0"

    backends = [r for r in load_records if isinstance(r, BackendLoaded)]
    assert any(b.library == "CUDA" and b.token == "cuda_v13" for b in backends)

    offloads = [r for r in load_records if isinstance(r, LayerOffload)]
    assert len(offloads) == 1
    assert offloads[0].offloaded_layers == 34
    assert offloads[0].total_layers == 34


def test_vulkan_fixture_records() -> None:
    log_text = (FIXTURES_DIR / "vulkan-igpu-enabled.log").read_text(encoding="utf-8")
    parser = OllamaLogParser()
    parser.feed(log_text)

    load_records = parser.latest_load()
    runner_devices = [r for r in load_records if isinstance(r, RunnerDevice)]
    assert len(runner_devices) == 1
    assert runner_devices[0].device_name == "Vulkan0"
    assert runner_devices[0].description == "AMD Radeon(TM) 880M Graphics"
    assert runner_devices[0].pci_bus is None  # (unknown id) becomes None

    backends = [r for r in load_records if isinstance(r, BackendLoaded)]
    assert any(b.library == "Vulkan" and b.token == "vulkan" for b in backends)


def test_cpu_fixture_records() -> None:
    log_text = (FIXTURES_DIR / "cpu-all-gpus-hidden.log").read_text(encoding="utf-8")
    parser = OllamaLogParser()
    parser.feed(log_text)

    # Discovery has CPU
    discovered = parser.discovered_devices()
    assert any(d.library == "cpu" and d.id == "cpu" for d in discovered)

    load_records = parser.latest_load()
    # No GPU runner device or GPU layer offload in CPU mode
    assert not any(isinstance(r, RunnerDevice) for r in load_records)
    assert not any(isinstance(r, LayerOffload) for r in load_records)

    backends = [r for r in load_records if isinstance(r, BackendLoaded)]
    assert any(b.library == "CPU" and b.token == "ollama" for b in backends)

    starters = [r for r in load_records if isinstance(r, RunnerStarted)]
    assert len(starters) == 1
    assert starters[0].duration_seconds == 5.03


def test_random_chunk_sizes_feed_identical_records() -> None:
    log_text = (FIXTURES_DIR / "rocm-igpu-selected-with-cuda-present.log").read_text(
        encoding="utf-8"
    )

    p1 = OllamaLogParser()
    p1.feed(log_text)
    expected_records = p1.records()

    # Feed via random slice chunks
    rng = random.Random(42)
    p2 = OllamaLogParser()
    index = 0
    while index < len(log_text):
        chunk_size = rng.randint(1, 128)
        chunk = log_text[index : index + chunk_size]
        p2.feed(chunk)
        index += chunk_size

    assert p2.records() == expected_records


def test_quoted_values_escapes_and_units() -> None:
    # Test bytes parser
    assert parse_bytes("12.2 GiB") == int(12.2 * 1024**3)
    assert parse_bytes("8.0 GiB") == 8 * 1024**3
    assert parse_bytes("512 MiB") == 512 * 1024**2
    assert parse_bytes("0 B") == 0
    assert parse_bytes(None) is None
    assert parse_bytes("") is None

    # Line with escaped quotes and spaces
    line = (
        'time=2026-10-29T17:42:30.310+08:00 level=INFO source=types.go:32 msg="inference compute" '
        'id=0 filter_id=0 library=CUDA compute=8.9 name=CUDA0 description="NVIDIA GeForce \\"RTX 4060\\" Laptop GPU" '
        'libdirs=ollama,cuda_v13 driver=13.5 pci_id="" type=discrete total="8.0 GiB" available="6.9 GiB"\n'
    )
    parser = OllamaLogParser()
    parser.feed(line)
    discovered = parser.discovered_devices()

    assert len(discovered) == 1
    assert discovered[0].description == 'NVIDIA GeForce "RTX 4060" Laptop GPU'
    assert discovered[0].pci_id is None  # empty pci_id becomes None
    assert discovered[0].total == 8 * 1024**3


def test_overlong_line_dropped() -> None:
    parser = OllamaLogParser()
    normal_line = (
        'time=2026-10-29T17:42:30.310+08:00 level=INFO source=types.go:32 msg="inference compute" '
        'id=0 filter_id=0 library=CPU name=cpu description=cpu libdirs=ollama total="16 GiB"\n'
    )
    overlong_line = "a" * 9000 + "\n"

    parser.feed(normal_line)
    parser.feed(overlong_line)
    parser.feed(normal_line)

    records = parser.records()
    assert len(records) == 2


def test_512_record_capacity_cap() -> None:
    parser = OllamaLogParser()
    line_template = (
        'time=2026-10-29T17:42:30.310+08:00 level=INFO source=types.go:32 msg="inference compute" '
        'id={0} filter_id={0} library=CUDA name=CUDA{0} description="GPU {0}" libdirs=ollama\n'
    )
    for i in range(600):
        parser.feed(line_template.format(i))

    records = parser.records()
    assert len(records) == 512
    # Oldest records were dropped; newest remains
    assert records[-1].id == "599"


def test_no_record_repr_contains_users_or_dll() -> None:
    for filename in (
        "rocm-igpu-selected-with-cuda-present.log",
        "cuda-dgpu-hip-hidden.log",
        "vulkan-igpu-enabled.log",
        "cpu-all-gpus-hidden.log",
    ):
        text = (FIXTURES_DIR / filename).read_text(encoding="utf-8")
        parser = OllamaLogParser()
        parser.feed(text)
        for record in parser.records():
            representation = repr(record)
            assert "Users" not in representation, f"Found 'Users' in {representation}"
            assert ".dll" not in representation, f"Found '.dll' in {representation}"


def test_selection_followed_by_runner_started_not_included_in_next_load() -> None:
    parser = OllamaLogParser()
    parser.feed(
        'time=2026-10-29T17:42:49.529+08:00 level=INFO source=sched.go:1049 '
        'msg="selecting single GPU for llama-server model" library=ROCm name=ROCm0 '
        'description="AMD Radeon(TM) 880M Graphics" integrated=false id=0 filter_id=0\n'
    )
    parser.feed("llama-server started in 5.03 seconds\n")
    parser.feed(
        'time=2026-10-29T17:42:50.000+08:00 level=INFO source=server.go:107 '
        'msg="using llama-server for model"\n'
    )

    new_load = parser.latest_load()
    assert new_load == ()


def test_overlong_line_tail_discarded_across_chunks() -> None:
    parser = OllamaLogParser()
    valid_line = (
        "llama_prepare_model_devices: using device CUDA0 (NVIDIA GeForce RTX 4060 Laptop GPU) "
        "(0000:63:00.0) - 7106 MiB free\n"
    )

    # 1. Feed 9,000 characters with no newline
    overlong_chunk = "x" * 9000
    res1 = parser.feed(overlong_chunk)
    assert res1 == ()
    assert parser.records() == ()

    # 2. Feed the tail of that line containing valid line text + \n
    res2 = parser.feed(valid_line)
    assert res2 == ()
    assert parser.records() == ()

    # 3. A full valid line after that still parses
    res3 = parser.feed(valid_line)
    assert len(res3) == 1
    assert isinstance(res3[0], RunnerDevice)
    assert res3[0].device_name == "CUDA0"
    assert res3[0].description == "NVIDIA GeForce RTX 4060 Laptop GPU"
    assert res3[0].pci_bus == "0000:63:00.0"
    assert len(parser.records()) == 1
