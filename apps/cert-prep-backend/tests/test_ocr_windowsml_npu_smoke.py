from __future__ import annotations

from pathlib import Path
import sys


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from runtime.windowsml.ocr_windowsml_npu_smoke import (  # noqa: E402
    NpuSmokeRun,
    assess_npu_scheduling,
    build_report,
    catalog_npu_provider_names_from_registration,
    classify_npu_smoke_status,
)


def test_npu_smoke_assessment_accepts_profiled_vitisai_nodes() -> None:
    assessment = assess_npu_scheduling(
        ort_ep_devices=[],
        session_providers=["VitisAIExecutionProvider", "CPUExecutionProvider"],
        profile_provider_node_counts={
            "VitisAIExecutionProvider": 3,
            "CPUExecutionProvider": 1,
        },
        catalog_npu_provider_names=["VitisAIExecutionProvider"],
    )

    assert assessment.npu_available is True
    assert assessment.npu_scheduled is True
    assert assessment.npu_provider_names == ["VitisAIExecutionProvider"]
    assert "VitisAIExecutionProvider" in assessment.reason


def test_npu_smoke_assessment_rejects_cpu_only_profile() -> None:
    assessment = assess_npu_scheduling(
        ort_ep_devices=[
            {
                "ep_name": "VitisAIExecutionProvider",
                "device_type": "NPU",
                "hardware_name": "NPU Compute Accelerator Device",
            }
        ],
        session_providers=["VitisAIExecutionProvider", "CPUExecutionProvider"],
        profile_provider_node_counts={"CPUExecutionProvider": 5},
    )

    status = classify_npu_smoke_status(
        model_file_present=True,
        run_error=None,
        assessment=assessment,
    )

    assert assessment.npu_available is True
    assert assessment.npu_scheduled is False
    assert "profiled nodes ran on CPUExecutionProvider" in assessment.reason
    assert status["state"] == "not_scheduled"
    assert status["strict_proof_passed"] is False


def test_npu_smoke_assessment_rejects_missing_profile_counts() -> None:
    assessment = assess_npu_scheduling(
        ort_ep_devices=[],
        session_providers=["VitisAIExecutionProvider", "CPUExecutionProvider"],
        profile_provider_node_counts={},
        catalog_npu_provider_names=["VitisAIExecutionProvider"],
    )

    assert assessment.npu_available is True
    assert assessment.npu_scheduled is False
    assert assessment.reason == (
        "NPU provider exists, but no ORT profile provider node data was available."
    )


def test_npu_smoke_keeps_unregistered_catalog_npu_as_availability_signal() -> None:
    provider_names = catalog_npu_provider_names_from_registration(
        {
            "providers": [
                {
                    "name": "VitisAIExecutionProvider",
                    "library_path": "",
                    "registered": False,
                }
            ]
        }
    )
    assessment = assess_npu_scheduling(
        ort_ep_devices=[],
        session_providers=["CPUExecutionProvider"],
        profile_provider_node_counts={"CPUExecutionProvider": 5},
        catalog_npu_provider_names=provider_names,
    )

    assert provider_names == ["VitisAIExecutionProvider"]
    assert assessment.npu_available is True
    assert assessment.npu_scheduled is False
    assert "profiled nodes ran on CPUExecutionProvider" in assessment.reason


def test_npu_smoke_report_blocks_when_prepass_model_is_missing(tmp_path: Path) -> None:
    report = build_report(
        model_dir=tmp_path / "missing-models",
        prepass_runner=_unexpected_runner,
    )

    assert report["npu_scheduled"] is False
    assert report["status"]["state"] == "blocked"
    assert report["status"]["blockers"] == ["npu_prepass_model_missing"]
    assert report["npu_prepass"]["error"] == "npu_prepass_model_missing"


def test_npu_smoke_report_fails_when_profile_has_no_npu_nodes(tmp_path: Path) -> None:
    model_dir = tmp_path / "models"
    model_path = model_dir / "npu-prepass" / "text-density.onnx"
    model_path.parent.mkdir(parents=True)
    model_path.write_text("stub", encoding="utf-8")

    report = build_report(model_dir=model_dir, prepass_runner=_cpu_only_runner)

    assert report["npu_scheduled"] is False
    assert report["status"]["state"] == "not_scheduled"
    assert report["profile_provider_node_counts"] == {"CPUExecutionProvider": 7}


def _cpu_only_runner(
    _model_path: Path,
    _device_policy: str,
    _duration_seconds: float,
    _min_iterations: int,
) -> NpuSmokeRun:
    return NpuSmokeRun(
        state="completed",
        iterations=3,
        duration_ms=12,
        session_providers=["VitisAIExecutionProvider", "CPUExecutionProvider"],
        providers_requested=["PREFER_NPU"],
        profile_files=["profile.json"],
        profile_provider_node_counts={"CPUExecutionProvider": 7},
    )


def _unexpected_runner(
    _model_path: Path,
    _device_policy: str,
    _duration_seconds: float,
    _min_iterations: int,
) -> NpuSmokeRun:
    raise AssertionError("prepass runner should not be called")
