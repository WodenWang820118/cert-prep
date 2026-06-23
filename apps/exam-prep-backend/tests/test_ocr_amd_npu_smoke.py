from __future__ import annotations

from pathlib import Path
import sys
from typing import Any


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from ocr_amd_npu_inference_smoke import build_inference_smoke, classify_inference_status  # noqa: E402
from ocr_amd_npu_benchmark import classify_benchmark_status  # noqa: E402
from ocr_amd_npu_probe import classify_probe_status, default_output_path  # noqa: E402


def test_amd_npu_probe_reports_ready_for_session_when_bootstrap_and_models_ready() -> None:
    status = classify_probe_status(
        bootstrap={"vitisai_npu_ready": True, "vitisai_ep_registered": True},
        model_artifacts={"ready": True},
        xrt_smi={"npu_detected": True, "power_watts_available": False},
    )

    assert status["state"] == "ready_for_session"
    assert status["power_watts_available"] is False
    assert status["blockers"] == []


def test_amd_npu_probe_blocks_without_vitisai_device() -> None:
    status = classify_probe_status(
        bootstrap={"vitisai_npu_ready": False},
        model_artifacts={"ready": True},
        xrt_smi={"npu_detected": False, "power_watts_available": False},
    )

    assert status["state"] == "blocked"
    assert "amd_npu_session_failed" in status["blockers"]


def test_amd_npu_inference_gate_stays_blocked_without_vitisai_events() -> None:
    session_report: dict[str, Any] = {
        "status": {
            "state": "session_ready",
            "session_ready": True,
            "blockers": [],
            "cpu_fallback_allowed": True,
        },
        "probe": {
            "status": {"vitisai_npu_ready": True},
            "model_artifacts": {"ready": True, "model_dir": "C:/models"},
        },
        "npu_session_smoke": {
            "sessions": [
                {
                    "model": "det/inference.onnx",
                    "providers": ["VitisAIExecutionProvider"],
                },
                {
                    "model": "rec/inference.onnx",
                    "providers": ["VitisAIExecutionProvider"],
                }
            ]
        },
    }

    smoke = build_inference_smoke(
        session_report,
        inference_runner=lambda _session_report: {
            "state": "blocked",
            "reason": "amd_npu_no_profiled_vitisai_compute",
            "device": "amd_npu:vitisai",
            "npu_compute_detected": False,
            "cpu_fallback_allowed": True,
            "cpu_events_detected": True,
            "windowsml_provider_detected": False,
        },
    )
    status = classify_inference_status(session_report["status"], smoke)

    assert smoke["state"] == "blocked"
    assert smoke["reason"] == "amd_npu_no_profiled_vitisai_compute"
    assert status["state"] == "blocked"
    assert status["npu_compute_detected"] is False
    assert status["cpu_fallback_allowed"] is True
    assert status["cpu_events_detected"] is True
    assert "amd_npu_no_profiled_vitisai_compute" in status["blockers"]


def test_amd_npu_inference_gate_passes_with_partial_npu_participation() -> None:
    session_report: dict[str, Any] = {
        "status": {
            "state": "session_ready",
            "session_ready": True,
            "blockers": [],
            "cpu_fallback_allowed": True,
        },
        "probe": {
            "status": {"vitisai_npu_ready": True},
            "model_artifacts": {"ready": True, "model_dir": "C:/models"},
        },
        "npu_session_smoke": {"sessions": []},
    }

    smoke = build_inference_smoke(
        session_report,
        inference_runner=lambda _session_report: {
            "state": "passed",
            "device": "amd_npu:vitisai",
            "npu_compute_detected": True,
            "cpu_fallback_allowed": True,
            "cpu_events_detected": True,
            "windowsml_provider_detected": False,
            "npu_participating_models": ["ocr_prepass/text_density"],
            "npu_participation_coverage": {"participating": 1, "total": 3},
        },
    )
    status = classify_inference_status(session_report["status"], smoke)

    assert status["state"] == "inference_ready"
    assert status["inference_ready"] is True
    assert status["npu_compute_detected"] is True
    assert status["cpu_events_detected"] is True
    assert status["npu_participating_models"] == ["ocr_prepass/text_density"]
    assert status["npu_participation_coverage"] == {"participating": 1, "total": 3}


def test_amd_npu_benchmark_gate_stays_blocked_without_inference() -> None:
    status = classify_benchmark_status(
        inference_status={
            "state": "blocked",
            "inference_ready": False,
            "blockers": ["amd_npu_session_failed"],
        },
        benchmark={
            "state": "skipped",
            "reason": "blocked",
            "npu_power_or_efficiency_observations": {
                "power_watts_available": True,
            },
        },
    )

    assert status["state"] == "blocked"
    assert status["benchmark_ready"] is False
    assert status["power_watts_available"] is True
    assert "amd_npu_session_failed" in status["blockers"]
    assert "blocked" not in status["blockers"]


def test_amd_npu_probe_default_output_is_benchmark_artifact() -> None:
    output = default_output_path()

    assert output.parent.name == ".benchmarks"
    assert output.name.startswith("ocr-amd-npu-probe-")
    assert output.suffix == ".json"
