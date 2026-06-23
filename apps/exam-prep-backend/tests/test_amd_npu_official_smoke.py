from __future__ import annotations

from pathlib import Path
import sys


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from amd_npu_official_smoke import classify_smoke_status, default_output_path  # noqa: E402


def test_official_smoke_status_allows_cpu_events_when_vitisai_ran() -> None:
    status = classify_smoke_status(
        bootstrap={"vitisai_npu_ready": True},
        execution={
            "state": "profiled",
            "npu_compute_detected": True,
            "vitisai_event_count": 1,
            "cpu_event_count": 2,
            "cpu_fallback_allowed": True,
            "cpu_events_detected": True,
        },
    )

    assert status["state"] == "npu_active"
    assert status["npu_active"] is True
    assert status["directml_provider_in_session"] is False
    assert status["nvidia_ep_device_bound"] is False
    assert status["cpu_events_detected"] is True
    assert status["blockers"] == []


def test_official_smoke_status_blocks_without_vitisai_profile_events() -> None:
    status = classify_smoke_status(
        bootstrap={"vitisai_npu_ready": True},
        execution={
            "state": "profiled",
            "npu_compute_detected": False,
            "vitisai_event_count": 0,
            "cpu_event_count": 2,
            "cpu_fallback_allowed": True,
            "cpu_events_detected": True,
        },
    )

    assert status["state"] == "blocked"
    assert status["npu_active"] is False
    assert "amd_npu_no_profiled_vitisai_compute" in status["blockers"]


def test_official_smoke_default_output_is_benchmark_artifact() -> None:
    output = default_output_path()

    assert output.parent.name == ".benchmarks"
    assert output.name.startswith("amd-npu-official-smoke-")
    assert output.suffix == ".json"
