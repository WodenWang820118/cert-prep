from __future__ import annotations

from pathlib import Path
from threading import Event, Thread

import pytest
from fastapi.testclient import TestClient

from cert_prep_backend.api.app import create_app
from cert_prep_backend.api.errors import ProviderReconfigurationConflictError
from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.mock_exams.provider import LazyDraftGenerationProvider
from cert_prep_backend.domains.mock_exams.provider_preferences import (
    apply_persisted_fastflowlm_terms_decision,
    fastflowlm_terms_are_accepted,
    persist_fastflowlm_terms_decision,
    read_fastflowlm_terms_decision,
)
from cert_prep_backend.domains.runtime_installations.manager import RuntimeInstallationManager
from cert_prep_backend.persistence.database import Database
from cert_prep_contracts.llm import (
    FASTFLOWLM_RUNTIME_TRUST_POLICY,
    FastFlowLMTermsDecision,
)
from cert_prep_contracts.runtime import (
    RuntimeInstallationStatus,
    RuntimeRequirementKind,
    RuntimeRequirementSnapshot,
)


AUTH_HEADERS = {"Authorization": "Bearer test-token"}


def test_ambient_fastflowlm_acceptance_is_cleared_without_database_decision(
    tmp_path: Path,
) -> None:
    settings = Settings(
        data_dir=tmp_path,
        fastflowlm_terms_accepted_version=FASTFLOWLM_RUNTIME_TRUST_POLICY.version,
    )

    decision = apply_persisted_fastflowlm_terms_decision(settings, Database(settings))

    assert decision is None
    assert settings.fastflowlm_terms_accepted_version is None
    assert settings.fastflowlm_terms_declined is False


@pytest.mark.parametrize(
    "decision",
    [FastFlowLMTermsDecision.ACCEPTED, FastFlowLMTermsDecision.DECLINED],
)
def test_fastflowlm_terms_decision_survives_settings_recreation(
    tmp_path: Path,
    decision: FastFlowLMTermsDecision,
) -> None:
    settings = Settings(data_dir=tmp_path)
    db = Database(settings)
    persist_fastflowlm_terms_decision(
        settings,
        db,
        decision=decision,
        terms_version=FASTFLOWLM_RUNTIME_TRUST_POLICY.version,
    )
    restarted_settings = Settings(data_dir=tmp_path)

    restored = apply_persisted_fastflowlm_terms_decision(
        restarted_settings,
        Database(restarted_settings),
    )

    assert restored is not None
    assert restored.decision == decision
    assert fastflowlm_terms_are_accepted(Database(restarted_settings)) is (
        decision == FastFlowLMTermsDecision.ACCEPTED
    )
    assert restarted_settings.fastflowlm_terms_declined is (
        decision == FastFlowLMTermsDecision.DECLINED
    )


def test_fastflowlm_terms_endpoint_requires_exact_version_and_forbids_extras(
    tmp_path: Path,
) -> None:
    with TestClient(
        create_app(Settings(data_dir=tmp_path, api_token="test-token"))
    ) as client:
        wrong_version = client.post(
            "/llm/provider-selection/fastflowlm-terms-decision",
            headers=AUTH_HEADERS,
            json={"decision": "accepted", "terms_version": "0.9.42"},
        )
        extra_field = client.post(
            "/llm/provider-selection/fastflowlm-terms-decision",
            headers=AUTH_HEADERS,
            json={
                "decision": "accepted",
                "terms_version": FASTFLOWLM_RUNTIME_TRUST_POLICY.version,
                "authorize_install": True,
            },
        )

    assert wrong_version.status_code == 422
    assert wrong_version.json()["code"] == "validation_error"
    assert extra_field.status_code == 422
    assert extra_field.json()["code"] == "validation_error"


def test_fastflowlm_terms_endpoint_persists_acceptance_for_restart(tmp_path: Path) -> None:
    settings = Settings(data_dir=tmp_path, api_token="test-token")
    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/llm/provider-selection/fastflowlm-terms-decision",
            headers=AUTH_HEADERS,
            json={
                "decision": "accepted",
                "terms_version": FASTFLOWLM_RUNTIME_TRUST_POLICY.version,
            },
        )

    restarted = Settings(data_dir=tmp_path, api_token="test-token")
    with TestClient(create_app(restarted)) as client:
        selection = client.get("/llm/provider-selection", headers=AUTH_HEADERS)

    assert response.status_code == 200
    assert response.json()["terms_accepted"] is True
    assert selection.status_code == 200
    assert selection.json()["terms_accepted"] is True
    assert read_fastflowlm_terms_decision(Database(restarted)) is not None


def test_provider_reconfiguration_retires_without_interrupting_resolved_provider(
    tmp_path: Path,
) -> None:
    old_provider = _ClosableProvider()
    new_provider = _ClosableProvider()
    providers = iter([old_provider, new_provider])
    lazy = LazyDraftGenerationProvider(
        lambda: next(providers),
        provider="fake",
        model="fake",
    )
    assert lazy.resolved_provider() is old_provider

    lazy.reconfigure_from_settings(Settings(data_dir=tmp_path, llm_provider="fake"))

    assert old_provider.closed is False
    assert lazy.resolved_provider() is new_provider
    lazy.close()
    assert old_provider.closed is True
    assert new_provider.closed is True


def test_targeted_llm_refresh_preserves_waiting_ocr_job(tmp_path: Path) -> None:
    settings = Settings(data_dir=tmp_path)
    ocr_installer = _WaitingInstaller(RuntimeRequirementKind.WINDOWSML_OCR)
    manager = RuntimeInstallationManager(
        settings=settings,
        llm_provider=_Provider(),
        ocr_provider=_OcrProvider(),
        installers=[ocr_installer],
        async_jobs=False,
    )
    waiting = manager.start_installation(RuntimeRequirementKind.WINDOWSML_OCR)
    applied = False

    def apply_decision() -> None:
        nonlocal applied
        applied = True

    manager.reconfigure_llm_provider(
        _Provider(),
        apply_policy_decision=apply_decision,
    )

    assert applied is True
    assert manager.get_installation(waiting.id).status == RuntimeInstallationStatus.WAITING_FOR_USER
    assert any(
        requirement.kind == RuntimeRequirementKind.WINDOWSML_OCR
        for requirement in manager.requirements()
    )


def test_llm_refresh_rejects_active_llm_install_without_applying_decision(
    tmp_path: Path,
) -> None:
    manager = RuntimeInstallationManager(
        settings=Settings(data_dir=tmp_path),
        llm_provider=_Provider(),
        ocr_provider=_OcrProvider(),
        installers=[_WaitingInstaller(RuntimeRequirementKind.FASTFLOWLM_MODEL)],
        async_jobs=False,
    )
    manager.start_installation(RuntimeRequirementKind.FASTFLOWLM_MODEL)
    applied = False

    def apply_decision() -> None:
        nonlocal applied
        applied = True

    with pytest.raises(ProviderReconfigurationConflictError, match="installation is active"):
        manager.reconfigure_llm_provider(
            _Provider(),
            apply_policy_decision=apply_decision,
        )

    assert applied is False


def test_llm_refresh_cannot_overtake_install_validation(tmp_path: Path) -> None:
    installer = _BlockingValidateInstaller()
    manager = RuntimeInstallationManager(
        settings=Settings(data_dir=tmp_path),
        llm_provider=_Provider(),
        ocr_provider=_OcrProvider(),
        installers=[installer],
        async_jobs=False,
    )
    errors: list[BaseException] = []

    def start_installation() -> None:
        try:
            manager.start_installation(RuntimeRequirementKind.OLLAMA_MODEL)
        except Exception as exc:  # pragma: no cover - asserted below
            errors.append(exc)

    worker = Thread(target=start_installation)
    worker.start()
    assert installer.validation_started.wait(timeout=2)
    applied = False

    def apply_decision() -> None:
        nonlocal applied
        applied = True

    try:
        with pytest.raises(ProviderReconfigurationConflictError, match="installation is active"):
            manager.reconfigure_llm_provider(
                _Provider(),
                apply_policy_decision=apply_decision,
            )
    finally:
        installer.release_validation.set()
        worker.join(timeout=2)

    assert worker.is_alive() is False
    assert errors == []
    assert applied is False


class _ClosableProvider:
    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True


class _Provider:
    provider = "fake"
    model = "fake"


class _OcrProvider:
    provider = "fake"


class _WaitingInstaller:
    provider = "test"
    model = "test"

    def __init__(self, kind: RuntimeRequirementKind) -> None:
        self.kind = kind

    def requirement(self) -> RuntimeRequirementSnapshot:
        return RuntimeRequirementSnapshot(
            kind=self.kind,
            label="waiting",
            available=False,
            detail="waiting",
            unavailable_reason="waiting",
        )

    def install(self, _progress) -> RuntimeInstallationStatus:
        return RuntimeInstallationStatus.WAITING_FOR_USER


class _BlockingValidateInstaller(_WaitingInstaller):
    def __init__(self) -> None:
        super().__init__(RuntimeRequirementKind.OLLAMA_MODEL)
        self.validation_started = Event()
        self.release_validation = Event()

    def validate_installable(self) -> None:
        self.validation_started.set()
        if not self.release_validation.wait(timeout=2):
            raise TimeoutError("test did not release installer validation")
