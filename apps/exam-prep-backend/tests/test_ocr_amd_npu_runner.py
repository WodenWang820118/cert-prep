from __future__ import annotations

from pathlib import Path
import sys


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from exam_prep_backend.domains.source_documents.adapters import amd_npu  # noqa: E402
from exam_prep_backend.domains.source_documents.adapters.amd_npu import (  # noqa: E402
    AmdNpuRuntimeOCRProvider,
    classify_strict_npu_status,
    ep_device_metadata,
    select_vitisai_npu_device,
)


def test_amd_npu_runtime_provider_health_requires_model_artifacts(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        amd_npu,
        "_onnxruntime_state",
        lambda: (["DmlExecutionProvider", "CPUExecutionProvider"], "1.24.6", None),
    )
    monkeypatch.setattr(amd_npu, "_paddleocr_state", lambda: ("3.7.0", None))
    monkeypatch.setattr(
        amd_npu,
        "npu_preferred_session_report",
        lambda **_kwargs: _session_report(state="session_ready"),
    )
    provider = AmdNpuRuntimeOCRProvider(model_dir=tmp_path, directml_device_id=0)

    health = provider.health()

    assert health.available is False
    assert health.unavailable_reason == "amd_npu_runtime_missing"
    assert "model artifacts are missing" in health.detail


def test_amd_npu_runtime_provider_allows_cpu_fallback_until_real_ocr_gate(
    monkeypatch,
    tmp_path: Path,
) -> None:
    _write_paddleocr37_model_files(tmp_path)
    monkeypatch.setattr(
        amd_npu,
        "_onnxruntime_state",
        lambda: (["DmlExecutionProvider", "CPUExecutionProvider"], "1.24.6", None),
    )
    monkeypatch.setattr(amd_npu, "_paddleocr_state", lambda: ("3.7.0", None))
    monkeypatch.setattr(
        amd_npu,
        "npu_preferred_session_report",
        lambda **_kwargs: _session_report(
            state="session_ready",
            blockers=[],
            cpu_fallback_allowed=True,
        ),
    )
    provider = AmdNpuRuntimeOCRProvider(model_dir=tmp_path, directml_device_id=0)

    health = provider.health()

    assert health.available is True
    assert health.unavailable_reason is None
    assert "hybrid OCR runtime is ready" in health.detail


def test_amd_npu_runtime_provider_extracts_with_npu_prepass(monkeypatch, tmp_path: Path) -> None:
    _write_paddleocr37_model_files(tmp_path)
    monkeypatch.setattr(
        amd_npu,
        "_onnxruntime_state",
        lambda: (["DmlExecutionProvider", "CPUExecutionProvider"], "1.24.6", None),
    )
    monkeypatch.setattr(amd_npu, "_paddleocr_state", lambda: ("3.7.0", None))
    monkeypatch.setattr(
        amd_npu,
        "npu_preferred_session_report",
        lambda **_kwargs: _session_report(
            state="session_ready",
            blockers=[],
            cpu_fallback_allowed=True,
        ),
    )
    provider = AmdNpuRuntimeOCRProvider(model_dir=tmp_path, directml_device_id=0)
    provider._prepass_runner = _FakePrepassRunner()
    provider._ocr_runner = _FakeOcrRunner()

    result = provider.extract_page_text(b"fake-png", page_number=1)

    assert result.text == "OCR TEST"
    assert result.extraction_method == "amd_npu_ocr"
    assert result.device == "amd_npu:vitisai+amd_directml:0"
    assert result.fallback_reason == (
        "npu_prepass=text_density_vitisai;vitisai_events=1;paddleocr_det_rec=directml"
    )
    assert result.duration_ms == 15


def test_strict_npu_status_records_cpu_fallback_as_blocker() -> None:
    status = classify_strict_npu_status(
        bootstrap={"vitisai_npu_ready": True},
        missing_files=[],
        session_smoke={
            "state": "session_failed",
            "reason": "amd_npu_cpu_fallback_detected",
            "cpu_fallback_detected": True,
        },
    )

    assert status["state"] == "session_failed"
    assert status["cpu_fallback_detected"] is True
    assert status["blockers"] == ["amd_npu_cpu_fallback_detected"]


def test_ep_device_metadata_reads_nested_ort_hardware_device() -> None:
    device = _FakeOrtEpDevice()
    ort = _FakeOrt([device])

    metadata = ep_device_metadata(ort)

    assert metadata[0]["ep_name"] == "VitisAIExecutionProvider"
    assert metadata[0]["device_type"] == "NPU"
    assert metadata[0]["device_vendor"] == "AMD"
    assert metadata[0]["device_id"] == "6128"
    assert metadata[0]["device_description"] == "NPU Compute Accelerator Device"
    assert metadata[0]["ep_library_path"].endswith("onnxruntime_vitisai_ep.dll")
    assert select_vitisai_npu_device(ort) is device


def _session_report(
    *,
    state: str,
    blockers: list[str] | None = None,
    cpu_fallback_detected: bool = False,
    cpu_fallback_allowed: bool = False,
) -> dict[str, object]:
    return {
        "status": {
            "state": state,
            "session_ready": state == "session_ready",
            "cpu_fallback_detected": cpu_fallback_detected,
            "cpu_fallback_allowed": cpu_fallback_allowed,
            "blockers": blockers or [],
        }
    }


def _write_paddleocr37_model_files(model_dir: Path) -> None:
    for name in amd_npu.AMD_NPU_REQUIRED_MODEL_FILES:
        path = model_dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("stub", encoding="utf-8")


class _FakeEnum:
    name = "NPU"


class _FakeHardwareDevice:
    type = _FakeEnum()
    vendor = "AMD"
    device_id = 6128
    vendor_id = 0x1022
    metadata = {
        "Description": "NPU Compute Accelerator Device",
        "LUID": "143006",
    }


class _FakeEpMetadata:
    library_path = "C:/WinML/ExecutionProvider/onnxruntime_vitisai_ep.dll"
    version = "1.8.62.0"


class _FakeOrtEpDevice:
    ep_name = "VitisAIExecutionProvider"
    ep_vendor = "AMD"
    device = _FakeHardwareDevice()
    ep_metadata = _FakeEpMetadata()


class _FakeOrt:
    def __init__(self, devices: list[object]) -> None:
        self._devices = devices

    def get_ep_devices(self) -> list[object]:
        return self._devices


class _FakePrepassRunner:
    def run(self, _image_png: bytes) -> amd_npu.AmdNpuPrepassResult:
        return amd_npu.AmdNpuPrepassResult(
            duration_ms=5,
            vitisai_event_count=1,
            cpu_event_count=1,
            features_checksum=1.0,
            profile_path="profile.json",
        )


class _FakeOcrTextResult:
    text = "OCR TEST"
    duration_ms = 10
    device = "amd_directml:0"


class _FakeOcrRunner:
    def extract_text(self, _image_png: bytes) -> _FakeOcrTextResult:
        return _FakeOcrTextResult()
