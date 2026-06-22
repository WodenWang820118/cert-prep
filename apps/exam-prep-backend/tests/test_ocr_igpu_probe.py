from __future__ import annotations

from pathlib import Path
import sys

import pytest


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import ocr_igpu_probe  # noqa: E402
from ocr_igpu_probe import classify_igpu_status, default_output_path  # noqa: E402


def test_ocr_igpu_probe_blocks_cuda_only_paddle_on_amd_laptop() -> None:
    status = classify_igpu_status(
        windows_video_controllers=[
            {"Name": "AMD Radeon(TM) 880M Graphics"},
            {"Name": "NVIDIA GeForce RTX 4060 Laptop GPU"},
        ],
        paddle={
            "compiled_with_cuda": True,
            "compiled_with_rocm": False,
            "available_devices": ["gpu:0"],
            "custom_device_types": [],
        },
        onnxruntime={"available": False, "providers": []},
    )

    assert status["state"] == "blocked"
    assert status["amd_igpu_detected"] is True
    assert status["nvidia_dgpu_detected"] is True
    assert status["paddle_can_target_amd_igpu"] is False
    assert "paddle_wheel_not_rocm" in status["blockers"]
    assert "paddle_devices_are_cuda_only" in status["blockers"]
    assert "onnxruntime_directml_not_available" in status["blockers"]


def test_ocr_igpu_probe_marks_directml_as_alternative_backend_candidate() -> None:
    status = classify_igpu_status(
        windows_video_controllers=[{"Name": "AMD Radeon(TM) 880M Graphics"}],
        paddle={
            "compiled_with_cuda": True,
            "compiled_with_rocm": False,
            "available_devices": ["gpu:0"],
            "custom_device_types": [],
        },
        onnxruntime={"available": True, "providers": ["DmlExecutionProvider"]},
    )

    assert status["state"] == "needs_alternative_backend"
    assert status["paddle_can_target_amd_igpu"] is False
    assert status["onnx_directml_candidate"] is True


def test_ocr_igpu_probe_marks_rocm_paddle_as_candidate() -> None:
    status = classify_igpu_status(
        windows_video_controllers=[{"Name": "AMD Radeon(TM) 880M Graphics"}],
        paddle={
            "compiled_with_cuda": False,
            "compiled_with_rocm": True,
            "available_devices": ["gpu:0"],
            "custom_device_types": [],
        },
        onnxruntime={"available": False, "providers": []},
    )

    assert status["state"] == "candidate"
    assert status["paddle_can_target_amd_igpu"] is True


def test_ocr_igpu_probe_default_output_is_benchmark_artifact() -> None:
    output = default_output_path()

    assert output.parent.name == ".benchmarks"
    assert output.name.startswith("ocr-igpu-probe-")
    assert output.suffix == ".json"


def test_ocr_igpu_probe_resolves_powershell_from_system_root(monkeypatch) -> None:
    monkeypatch.delenv("EXAM_PREP_POWERSHELL_EXE", raising=False)
    monkeypatch.setenv("SystemRoot", "C:\\Windows")
    monkeypatch.setenv("WINDIR", "")

    original_is_file = Path.is_file

    def fake_is_file(path: Path) -> bool:
        if str(path).lower().endswith(
            r"system32\windowspowershell\v1.0\powershell.exe"
        ):
            return True
        return original_is_file(path)

    monkeypatch.setattr(Path, "is_file", fake_is_file)

    assert ocr_igpu_probe.resolve_powershell_executable() == (
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    )


def test_ocr_igpu_probe_prefers_configured_powershell(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EXAM_PREP_POWERSHELL_EXE", "C:\\tools\\pwsh.exe")

    assert ocr_igpu_probe.resolve_powershell_executable() == "C:\\tools\\pwsh.exe"
