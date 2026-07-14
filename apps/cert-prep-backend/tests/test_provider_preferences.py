from __future__ import annotations

from pathlib import Path

import pytest

from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.mock_exams.provider import lazy_provider_from_settings
from cert_prep_backend.domains.mock_exams.provider_preferences import (
    apply_persisted_fastflowlm_terms_decision,
    persist_fastflowlm_terms_decision,
)
from cert_prep_backend.persistence.database import Database
from cert_prep_contracts.llm import FASTFLOWLM_RUNTIME_TRUST_POLICY


def test_fastflowlm_terms_acceptance_persists_across_settings_instances(
    tmp_path: Path,
) -> None:
    settings = Settings(data_dir=tmp_path, api_token="test-token")
    db = Database(settings)

    persist_fastflowlm_terms_decision(
        settings,
        db,
        decision="accepted",
        terms_version=FASTFLOWLM_RUNTIME_TRUST_POLICY.version,
    )
    restarted = Settings(data_dir=tmp_path, api_token="test-token")
    apply_persisted_fastflowlm_terms_decision(restarted, Database(restarted))

    assert restarted.fastflowlm_terms_accepted_version == "0.9.43"
    assert restarted.fastflowlm_terms_declined is False


def test_fastflowlm_terms_decline_replaces_prior_acceptance(tmp_path: Path) -> None:
    settings = Settings(data_dir=tmp_path, api_token="test-token")
    db = Database(settings)
    persist_fastflowlm_terms_decision(
        settings,
        db,
        decision="accepted",
        terms_version=FASTFLOWLM_RUNTIME_TRUST_POLICY.version,
    )

    persist_fastflowlm_terms_decision(
        settings,
        db,
        decision="declined",
        terms_version=FASTFLOWLM_RUNTIME_TRUST_POLICY.version,
    )
    restarted = Settings(data_dir=tmp_path, api_token="test-token")
    apply_persisted_fastflowlm_terms_decision(restarted, Database(restarted))

    assert restarted.fastflowlm_terms_accepted_version is None
    assert restarted.fastflowlm_terms_declined is True


def test_fastflowlm_terms_acceptance_rejects_unknown_version(tmp_path: Path) -> None:
    settings = Settings(data_dir=tmp_path, api_token="test-token")

    with pytest.raises(ValueError, match="must be 0.9.43"):
        persist_fastflowlm_terms_decision(
            settings,
            Database(settings),
            decision="accepted",
            terms_version="future-version",
        )


def test_lazy_provider_reconfigures_after_runtime_preference_change(tmp_path: Path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        api_token="test-token",
        llm_provider="fastflowlm",
    )
    provider = lazy_provider_from_settings(settings)

    settings.llm_provider = "ollama"
    provider.reconfigure_from_settings(settings)

    assert provider.provider == "ollama"
    assert provider.model
    assert provider.supports_ollama_runtime_installation is True
