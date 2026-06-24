from __future__ import annotations

from pathlib import Path

from cert_prep_ocr_windowsml import device as windowsml_device
from cert_prep_ocr_windowsml import runtime as windowsml
from cert_prep_ocr_windowsml.runtime import (
    WindowsMLOCRTextResult,
    WindowsMLRuntimeOCRProvider,
)


def test_windowsml_runtime_provider_health_requires_model_artifacts(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        windowsml,
        "_onnxruntime_state",
        lambda: (["DmlExecutionProvider", "CPUExecutionProvider"], "1.24.4", None),
    )
    monkeypatch.setattr(windowsml, "_paddleocr_state", lambda: ("3.7.0", None))
    provider = WindowsMLRuntimeOCRProvider(model_dir=tmp_path, device_id=0)

    missing = provider.health()

    assert missing.available is False
    assert missing.unavailable_reason == "windowsml_model_artifacts_missing"

    _write_paddleocr37_model_files(tmp_path)

    ready = provider.health()

    assert ready.available is True
    assert ready.unavailable_reason is None
    assert ready.selected_device == "amd_windowsml:0"
    assert ready.fallback_reason is None


def test_windowsml_runtime_provider_health_resolves_auto_amd_igpu(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        windowsml,
        "_onnxruntime_state",
        lambda: (["DmlExecutionProvider", "CPUExecutionProvider"], "1.24.6", None),
    )
    monkeypatch.setattr(windowsml, "_paddleocr_state", lambda: ("3.7.0", None))
    monkeypatch.setattr(windowsml, "resolve_windowsml_device_id", lambda _device_id: 1)
    _write_paddleocr37_model_files(tmp_path)
    provider = WindowsMLRuntimeOCRProvider(model_dir=tmp_path)

    health = provider.health()

    assert health.available is True
    assert health.selected_device == "amd_windowsml:1"
    assert health.fallback_reason is None


def test_windowsml_auto_device_selects_amd_after_nvidia(monkeypatch) -> None:
    monkeypatch.setattr(
        windowsml_device,
        "dxgi_adapter_snapshot",
        lambda: [
            {
                "adapter_index": 0,
                "description": "NVIDIA GeForce RTX 4060 Laptop GPU",
                "adapter_kind": "nvidia_dgpu",
            },
            {
                "adapter_index": 1,
                "description": "AMD Radeon(TM) 880M Graphics",
                "adapter_kind": "amd_igpu",
            },
        ],
    )

    assert windowsml_device.resolve_windowsml_device_id(-1) == 1


def test_windowsml_runtime_provider_engine_config_uses_amd_igpu_provider(
    monkeypatch,
) -> None:
    monkeypatch.setattr(windowsml, "resolve_windowsml_device_id", lambda _device_id: 0)
    runner = windowsml.WindowsMLOCRRunner(model_dir=Path("unused-model-dir"), device_id=0)

    config = runner._engine_config()

    assert config["providers"] == ["DmlExecutionProvider", "CPUExecutionProvider"]
    assert config["provider_options"] == [{"device_id": 0}, {}]
    assert config["enable_mem_pattern"] is False
    assert config["execution_mode"] == "sequential"


def test_windowsml_runtime_provider_records_base_extraction_result(
    monkeypatch,
    tmp_path: Path,
) -> None:
    provider = WindowsMLRuntimeOCRProvider(model_dir=tmp_path, device_id=0)
    monkeypatch.setattr(
        provider._runner,
        "extract_text",
        lambda _image_png: WindowsMLOCRTextResult(
            text="OCRTEST",
            duration_ms=9,
            box_count=1,
            recognized_count=1,
            device="amd_windowsml:0",
        ),
    )

    result = provider.extract_page_text(b"\x89PNG page", 1)

    assert result.text == "OCRTEST"
    assert result.extraction_method == "windowsml_ocr"
    assert result.device == "amd_windowsml:0"
    assert result.duration_ms == 9
    assert result.fallback_reason is None


def test_windowsml_runner_extracts_text_without_fallback_evidence(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(windowsml, "resolve_windowsml_device_id", lambda _device_id: 0)
    runner = windowsml.WindowsMLOCRRunner(model_dir=tmp_path, device_id=0)
    monkeypatch.setattr(runner, "_paddleocr_pipeline", lambda: _FakePaddleOCR())

    result = runner.extract_text(b"\x89PNG page")

    assert result.text == "OCRTEST"
    assert result.device == "amd_windowsml:0"
    assert result.fallback_reason is None


def _write_paddleocr37_model_files(model_dir: Path) -> None:
    for name in windowsml.PADDLEOCR37_REQUIRED_MODEL_FILES:
        path = model_dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("stub", encoding="utf-8")


class _FakePaddleOCR:
    def predict(self, _image_path: str) -> list["_FakePaddleOCRResult"]:
        return [_FakePaddleOCRResult()]


class _FakePaddleOCRResult:
    json = {
        "res": {
            "rec_texts": ["OCRTEST"],
            "dt_polys": [[[0, 0], [1, 0], [1, 1], [0, 1]]],
        }
    }
