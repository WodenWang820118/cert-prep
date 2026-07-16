from __future__ import annotations

from pathlib import Path
import sys

import pytest
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


def test_windowsml_runtime_provider_health_falls_back_to_cpu_without_dml(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        windowsml,
        "_onnxruntime_state",
        lambda: (["CPUExecutionProvider"], "1.24.6", None),
    )
    monkeypatch.setattr(windowsml, "_paddleocr_state", lambda: ("3.7.0", None))
    _write_paddleocr37_model_files(tmp_path)
    provider = WindowsMLRuntimeOCRProvider(model_dir=tmp_path)

    health = provider.health()

    assert health.available is True
    assert health.unavailable_reason is None
    assert health.selected_device == "cpu"
    _assert_cpu_fallback_warning(health.fallback_reason)
    assert health.detail == health.fallback_reason
    config = provider._runner._engine_config()
    assert config["providers"] == ["CPUExecutionProvider"]
    assert config["provider_options"] == [{}]


def test_windowsml_runtime_provider_hides_cpu_fallback_when_models_are_missing(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        windowsml,
        "_onnxruntime_state",
        lambda: (["CPUExecutionProvider"], "1.24.6", None),
    )
    monkeypatch.setattr(windowsml, "_paddleocr_state", lambda: ("3.7.0", None))
    provider = WindowsMLRuntimeOCRProvider(model_dir=tmp_path)

    health = provider.health()

    assert health.available is False
    assert health.selected_device == "cpu"
    assert health.fallback_reason is None
    assert health.unavailable_reason == "windowsml_model_artifacts_missing"
    assert "model artifacts are missing" in health.detail


def test_windowsml_runtime_provider_falls_back_to_cpu_when_adapter_selection_fails(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        windowsml,
        "_onnxruntime_state",
        lambda: (["DmlExecutionProvider", "CPUExecutionProvider"], "1.24.6", None),
    )
    monkeypatch.setattr(windowsml, "_paddleocr_state", lambda: ("3.7.0", None))

    def fail_device_selection(_device_id: int | None) -> int:
        raise windowsml.WindowsMLDeviceSelectionError("no AMD adapter")

    monkeypatch.setattr(windowsml, "resolve_windowsml_device_id", fail_device_selection)
    _write_paddleocr37_model_files(tmp_path)
    provider = WindowsMLRuntimeOCRProvider(model_dir=tmp_path)
    monkeypatch.setattr(provider._runner, "_paddleocr_pipeline", lambda: _FakePaddleOCR())

    health = provider.health()
    result = provider.extract_page_text(b"\x89PNG page", 1)

    assert health.available is True
    assert health.selected_device == "cpu"
    assert result.device == "cpu"
    assert result.fallback_reason == health.fallback_reason
    _assert_cpu_fallback_warning(result.fallback_reason)
    assert result.fallback_reason is not None
    assert "AMD/DXGI adapter selection failed" in result.fallback_reason
    assert provider._runner._engine_config()["providers"] == ["CPUExecutionProvider"]


def test_windowsml_runtime_provider_is_unavailable_without_cpu_provider(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        windowsml,
        "_onnxruntime_state",
        lambda: (["DmlExecutionProvider"], "1.24.6", None),
    )
    monkeypatch.setattr(windowsml, "_paddleocr_state", lambda: ("3.7.0", None))
    _write_paddleocr37_model_files(tmp_path)
    provider = WindowsMLRuntimeOCRProvider(model_dir=tmp_path, device_id=0)

    health = provider.health()

    assert health.available is False
    assert health.selected_device is None
    assert health.fallback_reason is None
    assert health.unavailable_reason == "cpu_provider_unavailable"
    with pytest.raises(windowsml.ProviderUnavailableError, match="CPUExecutionProvider"):
        provider._runner._engine_config()


def test_windowsml_runtime_provider_logs_cpu_fallback_once_per_instance(
    monkeypatch,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setattr(
        windowsml,
        "_onnxruntime_state",
        lambda: (["CPUExecutionProvider"], "1.24.6", None),
    )
    monkeypatch.setattr(windowsml, "_paddleocr_state", lambda: ("3.7.0", None))
    _write_paddleocr37_model_files(tmp_path)
    provider = WindowsMLRuntimeOCRProvider(model_dir=tmp_path)
    monkeypatch.setattr(provider._runner, "_paddleocr_pipeline", lambda: _FakePaddleOCR())

    with caplog.at_level("WARNING", logger=windowsml.__name__):
        first_health = provider.health()
        provider.health()
        result = provider.extract_page_text(b"\x89PNG page", 1)

    assert result.fallback_reason == first_health.fallback_reason
    messages = [
        record.getMessage()
        for record in caplog.records
        if record.name == windowsml.__name__
        and "WindowsML OCR acceleration warning" in record.getMessage()
    ]
    assert len(messages) == 1
    assert first_health.fallback_reason is not None
    assert first_health.fallback_reason in messages[0]


def test_windowsml_runner_rebuilds_cpu_pipeline_after_dml_constructor_failure(
    monkeypatch,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setattr(
        windowsml,
        "_onnxruntime_state",
        lambda: (["DmlExecutionProvider", "CPUExecutionProvider"], "1.24.6", None),
    )
    monkeypatch.setattr(windowsml, "resolve_windowsml_device_id", lambda _device_id: 0)
    engine_configs: list[dict[str, object]] = []

    def paddleocr_factory(**kwargs):
        engine_config = kwargs["engine_config"]
        engine_configs.append(engine_config)
        if engine_config["providers"][0] == "DmlExecutionProvider":
            raise RuntimeError("DML constructor failed")
        return _FakePaddleOCR()

    monkeypatch.setattr(windowsml, "_import_paddleocr", lambda: paddleocr_factory)
    provider = WindowsMLRuntimeOCRProvider(model_dir=tmp_path, device_id=0)

    with caplog.at_level("WARNING", logger=windowsml.__name__):
        first = provider.extract_page_text(b"\x89PNG page", 1)
        second = provider.extract_page_text(b"\x89PNG page", 2)

    assert [config["providers"] for config in engine_configs] == [
        ["DmlExecutionProvider", "CPUExecutionProvider"],
        ["CPUExecutionProvider"],
    ]
    assert first.device == second.device == "cpu"
    assert first.fallback_reason == second.fallback_reason
    _assert_cpu_fallback_warning(first.fallback_reason)
    assert first.fallback_reason is not None
    assert "pipeline initialization failed with RuntimeError" in first.fallback_reason
    assert _fallback_log_messages(caplog) == [
        f"WindowsML OCR acceleration warning: {first.fallback_reason}"
    ]


def test_windowsml_runner_rebuilds_cpu_pipeline_after_dml_prediction_failure(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        windowsml,
        "_onnxruntime_state",
        lambda: (["DmlExecutionProvider", "CPUExecutionProvider"], "1.24.6", None),
    )
    monkeypatch.setattr(windowsml, "resolve_windowsml_device_id", lambda _device_id: 0)
    engine_configs: list[dict[str, object]] = []

    def paddleocr_factory(**kwargs):
        engine_config = kwargs["engine_config"]
        engine_configs.append(engine_config)
        if engine_config["providers"][0] == "DmlExecutionProvider":
            return _FailingPaddleOCR(RuntimeError("DML prediction failed"))
        return _FakePaddleOCR()

    monkeypatch.setattr(windowsml, "_import_paddleocr", lambda: paddleocr_factory)
    provider = WindowsMLRuntimeOCRProvider(model_dir=tmp_path, device_id=0)

    result = provider.extract_page_text(b"\x89PNG page", 1)

    assert [config["providers"] for config in engine_configs] == [
        ["DmlExecutionProvider", "CPUExecutionProvider"],
        ["CPUExecutionProvider"],
    ]
    assert result.device == "cpu"
    _assert_cpu_fallback_warning(result.fallback_reason)
    assert result.fallback_reason is not None
    assert "prediction failed with RuntimeError" in result.fallback_reason


def test_windowsml_runner_propagates_cpu_retry_failure_without_looping(
    monkeypatch,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setattr(
        windowsml,
        "_onnxruntime_state",
        lambda: (["DmlExecutionProvider", "CPUExecutionProvider"], "1.24.6", None),
    )
    monkeypatch.setattr(windowsml, "resolve_windowsml_device_id", lambda _device_id: 0)
    engine_configs: list[dict[str, object]] = []
    predict_devices: list[str] = []
    cpu_error = ValueError("CPU prediction failed")

    def paddleocr_factory(**kwargs):
        engine_config = kwargs["engine_config"]
        engine_configs.append(engine_config)
        device = (
            "dml"
            if engine_config["providers"][0] == "DmlExecutionProvider"
            else "cpu"
        )
        error = RuntimeError("DML prediction failed") if device == "dml" else cpu_error
        return _FailingPaddleOCR(error, calls=predict_devices, label=device)

    monkeypatch.setattr(windowsml, "_import_paddleocr", lambda: paddleocr_factory)
    provider = WindowsMLRuntimeOCRProvider(model_dir=tmp_path, device_id=0)

    with caplog.at_level("WARNING", logger=windowsml.__name__):
        with pytest.raises(ValueError) as exc_info:
            provider.extract_page_text(b"\x89PNG page", 1)

    assert exc_info.value is cpu_error
    assert [config["providers"] for config in engine_configs] == [
        ["DmlExecutionProvider", "CPUExecutionProvider"],
        ["CPUExecutionProvider"],
    ]
    assert predict_devices == ["dml", "cpu"]
    fallback_reason = provider._runner.fallback_reason
    _assert_cpu_fallback_warning(fallback_reason)
    assert _fallback_log_messages(caplog) == [
        f"WindowsML OCR acceleration warning: {fallback_reason}"
    ]


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
    monkeypatch.setattr(
        windowsml,
        "_onnxruntime_state",
        lambda: (["DmlExecutionProvider", "CPUExecutionProvider"], "1.24.6", None),
    )
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
    monkeypatch.setattr(
        windowsml,
        "_onnxruntime_state",
        lambda: (["DmlExecutionProvider", "CPUExecutionProvider"], "1.24.6", None),
    )
    monkeypatch.setattr(windowsml, "resolve_windowsml_device_id", lambda _device_id: 0)
    runner = windowsml.WindowsMLOCRRunner(model_dir=tmp_path, device_id=0)
    monkeypatch.setattr(runner, "_paddleocr_pipeline", lambda: _FakePaddleOCR())

    result = runner.extract_text(b"\x89PNG page")

    assert result.text == "OCRTEST"
    assert result.device == "amd_windowsml:0"
    assert result.fallback_reason is None


def test_windowsml_runtime_replaces_optional_aistudio_downloader_with_offline_stub(
    monkeypatch,
) -> None:
    for name in (
        "aistudio_sdk",
        "aistudio_sdk.errors",
        "aistudio_sdk.snapshot_download",
    ):
        monkeypatch.delitem(sys.modules, name, raising=False)

    windowsml._install_offline_aistudio_stubs()

    errors = sys.modules["aistudio_sdk.errors"]
    downloads = sys.modules["aistudio_sdk.snapshot_download"]
    assert issubclass(errors.NotExistError, Exception)
    with pytest.raises(RuntimeError, match="bundled model files"):
        downloads.snapshot_download("unused")


def _write_paddleocr37_model_files(model_dir: Path) -> None:
    for name in windowsml.PADDLEOCR37_REQUIRED_MODEL_FILES:
        path = model_dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("stub", encoding="utf-8")


def _assert_cpu_fallback_warning(reason: str | None) -> None:
    assert reason is not None
    assert "acceleration could not be confirmed" in reason
    assert "using CPU OCR" in reason
    assert "may be slower" in reason


def _fallback_log_messages(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [
        record.getMessage()
        for record in caplog.records
        if record.name == windowsml.__name__
        and "WindowsML OCR acceleration warning" in record.getMessage()
    ]


class _FakePaddleOCR:
    def predict(self, _image_path: str) -> list["_FakePaddleOCRResult"]:
        return [_FakePaddleOCRResult()]


class _FailingPaddleOCR:
    def __init__(
        self,
        error: Exception,
        *,
        calls: list[str] | None = None,
        label: str = "",
    ) -> None:
        self._error = error
        self._calls = calls
        self._label = label

    def predict(self, _image_path: str) -> None:
        if self._calls is not None:
            self._calls.append(self._label)
        raise self._error


class _FakePaddleOCRResult:
    json = {
        "res": {
            "rec_texts": ["OCRTEST"],
            "dt_polys": [[[0, 0], [1, 0], [1, 1], [0, 1]]],
        }
    }
