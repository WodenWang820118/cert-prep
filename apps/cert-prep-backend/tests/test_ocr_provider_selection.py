from __future__ import annotations

from pathlib import Path

import pytest

from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.source_documents.ocr import ocr_provider_from_settings
from cert_prep_backend.api.errors import ProviderUnavailableError


def test_windowsml_provider_rejects_inprocess_mode(tmp_path: Path) -> None:
    with pytest.raises(
        ProviderUnavailableError,
        match="WindowsML provider requires external runtime mode and does not support inprocess.",
    ):
        ocr_provider_from_settings(
            Settings(
                data_dir=tmp_path,
                api_token="test-token",
                ocr_provider="windowsml",
                ocr_runtime_mode="inprocess",
            )
        )


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
