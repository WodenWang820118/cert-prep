from __future__ import annotations

from pathlib import Path
from typing import Any


from cert_prep_ocr_windowsml.tools.windowsml.ocr_windowsml_inference_smoke import (
    WindowsGpuTelemetryCapture,
    build_inference_smoke,
    classify_inference_status,
    default_output_path,
    summarize_process_gpu_telemetry,
)


def test_inference_smoke_skips_until_session_ready() -> None:
    session_report = {"status": {"state": "ready_for_model", "session_ready": False}}

    smoke = build_inference_smoke(session_report, inference_runner=_unexpected_runner)
    status = classify_inference_status(session_report["status"], smoke)

    assert smoke["state"] == "skipped"
    assert smoke["reason"] == "ready_for_model"
    assert status["state"] == "ready_for_model"
    assert status["inference_ready"] is False


def test_inference_smoke_reports_recognition_model_ready() -> None:
    session_report = {"status": {"state": "session_ready", "session_ready": True, "blockers": []}}

    smoke = build_inference_smoke(session_report, inference_runner=_passed_runner)
    status = classify_inference_status(session_report["status"], smoke)

    assert smoke["state"] == "passed"
    assert status["state"] == "inference_ready"
    assert status["inference_ready"] is True
    assert status["recognition_model_ready"] is True
    assert status["full_page_ocr_ready"] is True
    assert status["gpu_telemetry_available"] is False
    assert status["igpu_resource_observed"] is False
    assert status["igpu_process_memory_observed"] is False
    assert status["igpu_compute_observed"] is False
    assert status["blockers"] == []


def test_inference_status_reports_igpu_compute_when_telemetry_present() -> None:
    session_report = {"status": {"state": "session_ready", "session_ready": True, "blockers": []}}

    smoke = build_inference_smoke(session_report, inference_runner=_passed_runner_with_igpu_activity)
    status = classify_inference_status(session_report["status"], smoke)

    assert status["state"] == "inference_ready"
    assert status["gpu_telemetry_available"] is True
    assert status["igpu_resource_observed"] is True
    assert status["igpu_process_memory_observed"] is True
    assert status["igpu_compute_observed"] is True
    assert status["nvidia_dgpu_above_gate_observed"] is False


def test_inference_smoke_blocks_on_text_mismatch() -> None:
    session_report = {"status": {"state": "session_ready", "session_ready": True, "blockers": []}}

    smoke = build_inference_smoke(session_report, inference_runner=_mismatch_runner)
    status = classify_inference_status(session_report["status"], smoke)

    assert smoke["state"] == "failed"
    assert status["state"] == "blocked"
    assert status["inference_ready"] is False
    assert "windowsml_inference_text_mismatch" in status["blockers"]


def test_windowsml_inference_default_output_is_benchmark_artifact() -> None:
    output = default_output_path()

    assert output.parent.name == ".benchmarks"
    assert output.name.startswith("ocr-windowsml-inference-smoke-")
    assert output.suffix == ".json"


def test_summarize_process_gpu_telemetry_maps_current_pid_to_amd_luid(tmp_path: Path) -> None:
    telemetry_csv = tmp_path / "gpu.csv"
    telemetry_csv.write_text(
        "\n".join(
            [
                "timestamp,path,pid,luid,metric,value",
                (
                    '2026-06-23T00:00:00Z,"\\\\MSI\\GPU Process Memory'
                    '(pid_123_luid_0x00000000_0x000136c5_phys_0)\\Shared Usage",'
                    "123,0x00000000_0x000136c5,shared_usage,4096"
                ),
                (
                    '2026-06-23T00:00:01Z,"\\\\MSI\\GPU Engine'
                    '(pid_123_luid_0x00000000_0x000136c5_phys_0_eng_2_engtype_Compute 0)'
                    '\\Utilization Percentage",'
                    "123,0x00000000_0x000136c5,engine_utilization_percent,17.5"
                ),
                (
                    '2026-06-23T00:00:01Z,"\\\\MSI\\GPU Process Memory'
                    '(pid_123_luid_0x00000000_0x0001fbc5_phys_0)\\Dedicated Usage",'
                    "123,0x00000000_0x0001fbc5,dedicated_usage,0"
                ),
            ]
        ),
        encoding="utf-8",
    )

    summary = summarize_process_gpu_telemetry(
        csv_path=telemetry_csv,
        target_pid=123,
        target_luid="0x00000000_0x000136c5",
        dxgi_adapters=[
            {"luid": "0x00000000_0x000136c5", "adapter_kind": "amd_igpu"},
            {"luid": "0x00000000_0x0001fbc5", "adapter_kind": "nvidia_dgpu"},
        ],
    )

    assert summary["available"] is True
    assert summary["amd_igpu_resource_observed"] is True
    assert summary["amd_igpu_process_memory_observed"] is True
    assert summary["amd_igpu_compute_observed"] is True
    assert summary["amd_igpu_process_memory_max_bytes"] == 4096
    assert summary["amd_igpu_engine_utilization_percent_max"] == 17.5
    assert summary["nvidia_dgpu_above_gate_observed"] is False


def test_gpu_telemetry_summary_includes_sampler_cleanup(tmp_path: Path) -> None:
    capture = WindowsGpuTelemetryCapture(output_dir=tmp_path, target_pid=123)
    cleanup = capture.stop()

    summary = capture.summary(
        dxgi_adapters=[{"luid": "0x00000000_0x000136c5", "adapter_kind": "amd_igpu"}],
        target_luid="0x00000000_0x000136c5",
    )

    assert cleanup == {
        "attempted": False,
        "reason": "sampler_not_started",
        "terminated": True,
    }
    assert summary["sampler_cleanup"] == cleanup


def _passed_runner(_session_report: dict[str, Any]) -> dict[str, Any]:
    return {
        "state": "passed",
        "scope": "full_page_ocr",
        "device": "amd_windowsml",
        "expected_text": "TEST",
        "text": "TEST",
        "expected_text_matched": True,
        "full_page_ocr_ready": True,
    }


def _passed_runner_with_igpu_activity(_session_report: dict[str, Any]) -> dict[str, Any]:
    return {
        **_passed_runner(_session_report),
        "gpu_telemetry": {
            "available": True,
            "amd_igpu_resource_observed": True,
            "amd_igpu_process_memory_observed": True,
            "amd_igpu_compute_observed": True,
            "nvidia_dgpu_above_gate_observed": False,
        },
    }


def _mismatch_runner(_session_report: dict[str, Any]) -> dict[str, Any]:
    return {
        "state": "failed",
        "reason": "windowsml_inference_text_mismatch",
        "scope": "full_page_ocr",
        "device": "amd_windowsml",
        "expected_text": "TEST",
        "text": "TEXT",
        "expected_text_matched": False,
        "full_page_ocr_ready": False,
    }


def _unexpected_runner(_session_report: dict[str, Any]) -> dict[str, Any]:
    raise AssertionError("inference runner should not be called")
