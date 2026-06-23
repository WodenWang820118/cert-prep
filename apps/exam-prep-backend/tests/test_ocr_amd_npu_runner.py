from __future__ import annotations

from pathlib import Path
import sys


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from exam_prep_backend.domains.source_documents.adapters.amd_npu import (  # noqa: E402
    classify_strict_npu_status,
    ep_device_metadata,
    select_vitisai_npu_device,
)


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
