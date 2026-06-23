from __future__ import annotations

from pathlib import Path

import pytest

from exam_prep_backend.config import Settings
from exam_prep_backend.domains.source_documents.ocr import ocr_provider_from_settings
from exam_prep_backend.errors import ProviderUnavailableError


def test_windowsml_provider_is_explicitly_blocked_until_gate_passes(tmp_path: Path) -> None:
    provider = ocr_provider_from_settings(
        Settings(
            data_dir=tmp_path,
            api_token="test-token",
            ocr_provider="windowsml",
            ocr_runtime_mode="inprocess",
        )
    )

    health = provider.health()

    assert health.provider == "windowsml"
    assert health.available is False
    assert health.unavailable_reason in {
        "windowsml_runtime_missing",
        "windowsml_provider_unavailable",
        "windowsml_ocr_not_ready",
    }
    with pytest.raises(ProviderUnavailableError, match="WindowsML OCR is gated"):
        provider.extract_page_text(b"\x89PNG page", 1)


def test_windowsml_external_provider_reports_missing_runtime_without_cpu_fallback(
    tmp_path: Path,
) -> None:
    provider = ocr_provider_from_settings(
        Settings(
            data_dir=tmp_path,
            api_token="test-token",
            ocr_provider="windowsml",
            windowsml_ocr_runtime_dir=tmp_path / "missing-windowsml-runtime",
        )
    )

    health = provider.health()

    assert health.provider == "windowsml"
    assert health.available is False
    assert health.unavailable_reason == "windowsml_runtime_missing"
    assert health.model_cache_dir == str(tmp_path / "missing-windowsml-runtime")
    with pytest.raises(ProviderUnavailableError, match="WindowsML OCR runtime is not installed."):
        provider.extract_page_text(b"\x89PNG page", 1)
