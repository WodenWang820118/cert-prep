from __future__ import annotations

from pathlib import Path

import pytest

from exam_prep_backend.config import Settings
from exam_prep_backend.domains.source_documents.ocr import ocr_provider_from_settings
from exam_prep_backend.errors import ProviderUnavailableError


def test_directml_provider_is_explicitly_blocked_until_gate_passes(tmp_path: Path) -> None:
    provider = ocr_provider_from_settings(
        Settings(
            data_dir=tmp_path,
            api_token="test-token",
            ocr_provider="directml",
            ocr_runtime_mode="inprocess",
        )
    )

    health = provider.health()

    assert health.provider == "directml"
    assert health.available is False
    assert health.unavailable_reason in {
        "directml_runtime_missing",
        "directml_provider_unavailable",
        "directml_ocr_not_ready",
    }
    with pytest.raises(ProviderUnavailableError, match="DirectML OCR is gated"):
        provider.extract_page_text(b"\x89PNG page", 1)


def test_directml_external_provider_reports_missing_runtime_without_cpu_fallback(
    tmp_path: Path,
) -> None:
    provider = ocr_provider_from_settings(
        Settings(
            data_dir=tmp_path,
            api_token="test-token",
            ocr_provider="directml",
            directml_ocr_runtime_dir=tmp_path / "missing-directml-runtime",
        )
    )

    health = provider.health()

    assert health.provider == "directml"
    assert health.available is False
    assert health.unavailable_reason == "directml_runtime_missing"
    assert health.model_cache_dir == str(tmp_path / "missing-directml-runtime")
    with pytest.raises(ProviderUnavailableError, match="AMD DirectML OCR runtime is not installed."):
        provider.extract_page_text(b"\x89PNG page", 1)
