from __future__ import annotations

from pathlib import Path

import pytest

from cert_prep_backend.api.errors import ProviderUnavailableError
from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.source_documents.adapters import external_paddle
from cert_prep_backend.domains.source_documents.adapters.external_windowsml import (
    ExternalWindowsMLOCRProvider,
)


CPU_FALLBACK_WARNING = (
    "WindowsML OCR acceleration could not be confirmed because DML prediction failed; "
    "using CPU OCR, which may be slower."
)


def test_windowsml_health_keeps_cached_cpu_fallback_from_primary_prewarm(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    provider = _provider(tmp_path)
    entrypoint = tmp_path / "runtime.exe"
    worker = _FallbackPrewarmWorker()
    monkeypatch.setattr(provider, "_entrypoint", lambda: entrypoint)
    monkeypatch.setattr(
        provider,
        "_run_json",
        lambda _entrypoint, _args: _windowsml_health_payload(),
    )
    monkeypatch.setattr(
        external_paddle._OcrWorkerPool,
        "_create_worker",
        lambda _pool: worker,
    )

    try:
        first = provider.health()
        second = provider.health()
    finally:
        provider.close()

    assert worker.extract_calls == 1
    for health in (first, second):
        assert health.available is True
        assert health.selected_device == "cpu"
        assert health.fallback_reason == CPU_FALLBACK_WARNING
        assert health.detail == CPU_FALLBACK_WARNING
        assert health.unavailable_reason is None


def test_windowsml_health_keeps_cpu_fallback_observed_during_real_extraction(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    provider = _provider(tmp_path)
    entrypoint = tmp_path / "runtime.exe"
    worker = _RuntimeFallbackWorker()
    monkeypatch.setattr(provider, "_entrypoint", lambda: entrypoint)
    monkeypatch.setattr(
        provider,
        "_run_json",
        lambda _entrypoint, _args: _windowsml_health_payload(),
    )
    monkeypatch.setattr(
        external_paddle._OcrWorkerPool,
        "_create_worker",
        lambda _pool: worker,
    )

    try:
        first_health = provider.health()
        cpu_result = provider.extract_page_text(b"\x89PNG page", 7)
        dml_result = provider.extract_page_text(b"\x89PNG page", 8)
        second_health = provider.health()
    finally:
        provider.close()

    assert first_health.available is True
    assert first_health.selected_device == "amd_windowsml:0"
    assert first_health.fallback_reason is None
    assert cpu_result.device == "cpu"
    assert cpu_result.fallback_reason == CPU_FALLBACK_WARNING
    assert dml_result.device == "amd_windowsml:0"
    assert dml_result.fallback_reason is None
    assert second_health.available is True
    assert second_health.selected_device == "cpu"
    assert second_health.fallback_reason == CPU_FALLBACK_WARNING
    assert second_health.detail == CPU_FALLBACK_WARNING
    assert worker.page_numbers == [1, 7, 8]


def test_windowsml_health_reports_unavailable_when_primary_prewarm_fails(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    provider = _provider(tmp_path)
    entrypoint = tmp_path / "runtime.exe"
    pool = _FailingPrewarmPool()
    monkeypatch.setattr(provider, "_entrypoint", lambda: entrypoint)
    monkeypatch.setattr(
        provider,
        "_run_json",
        lambda _entrypoint, _args: _windowsml_health_payload(),
    )
    monkeypatch.setattr(provider, "_worker_pool_for", lambda *_args, **_kwargs: pool)

    health = provider.health()

    assert health.available is False
    assert health.selected_device is None
    assert health.fallback_reason is None
    assert health.unavailable_reason == "windowsml_runtime_unhealthy"
    assert "CPU retry failed" in health.detail
    with pytest.raises(ProviderUnavailableError, match="CPU retry failed"):
        provider.prepare_for_document_ocr()
    assert pool.prewarm_calls == 2


def _provider(tmp_path: Path) -> ExternalWindowsMLOCRProvider:
    return ExternalWindowsMLOCRProvider(
        Settings(
            data_dir=tmp_path,
            api_token="test-token",
            windowsml_ocr_runtime_dir=tmp_path / "windowsml-runtime",
            ocr_page_workers=1,
            ocr_runtime_timeout_seconds=2,
        )
    )


def _windowsml_health_payload() -> dict[str, object]:
    return {
        "provider": "windowsml",
        "engine": "paddleocr-3.7-onnxruntime-windowsml",
        "available": True,
        "detail": "WindowsML OCR runtime is ready.",
        "python_version": "3.12.test",
        "paddle_version": None,
        "paddleocr_version": "3.7.0",
        "selected_device": "amd_windowsml:0",
        "cuda_available": False,
        "gpu_count": 0,
        "model_cache_dir": "test-cache",
        "fallback_reason": None,
        "unavailable_reason": None,
    }


class _FallbackPrewarmWorker:
    def __init__(self) -> None:
        self.extract_calls = 0

    def extract_page_text(self, *, image_path: Path, page_number: int) -> dict[str, object]:
        assert image_path.is_file()
        assert page_number == 1
        self.extract_calls += 1
        return {
            "text": "OCR TEST",
            "extraction_method": "windowsml_ocr",
            "device": "cpu",
            "fallback_reason": CPU_FALLBACK_WARNING,
            "duration_ms": 7,
        }

    def close(self) -> None:
        pass


class _RuntimeFallbackWorker:
    def __init__(self) -> None:
        self.page_numbers: list[int] = []

    def extract_page_text(self, *, image_path: Path, page_number: int) -> dict[str, object]:
        assert image_path.is_file()
        self.page_numbers.append(page_number)
        if page_number == 7:
            return {
                "text": "CPU OCR",
                "extraction_method": "windowsml_ocr",
                "device": "cpu",
                "fallback_reason": CPU_FALLBACK_WARNING,
                "duration_ms": 9,
            }
        return {
            "text": "DML OCR",
            "extraction_method": "windowsml_ocr",
            "device": "amd_windowsml:0",
            "fallback_reason": None,
            "duration_ms": 7,
        }

    def close(self) -> None:
        pass


class _FailingPrewarmPool:
    def __init__(self) -> None:
        self.prewarm_calls = 0

    def prewarm_primary_worker(self) -> None:
        self.prewarm_calls += 1
        raise ProviderUnavailableError("DML and CPU retry failed")
