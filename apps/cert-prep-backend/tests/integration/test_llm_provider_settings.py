from dataclasses import replace

from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest

from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.mock_exams import ollama_profiles as ollama_profile_module
from cert_prep_backend.domains.mock_exams import provider as provider_module
from cert_prep_backend.domains.mock_exams.ollama_transport import OllamaProvider
from cert_prep_backend.domains.mock_exams.provider import provider_from_settings
from cert_prep_contracts.hardware import MachineAcceleratorSnapshot
from cert_prep_contracts.llm import LLMExecutionMode
from cert_prep_contracts.runtime import RuntimeRequirementKind
from cert_prep_ollama import profiles as ollama_package_profiles
from cert_prep_ollama.profiles import DEFAULT_PROFILE_ID
from llm_test_fakes import GIB, RecordingDownloadProvider, _profile_inventory


AUTH_HEADERS = {"Authorization": "Bearer test-token"}


def test_llm_health_does_not_pull_missing_ollama_model(tmp_path) -> None:
    provider = RecordingDownloadProvider(available=False, detail="model not found")
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            llm_provider=provider,
            runtime_installation_async_jobs=False,
        )
    )

    response = client.get("/llm/health", headers=AUTH_HEADERS)

    assert response.status_code == 200
    assert response.json()["detail"] == "model not found"
    assert provider.pull_calls == 0


def test_settings_ignore_removed_ollama_fallback_models_argument(tmp_path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        ollama_fallback_models="other-model, gemma4:12b, ",
    )

    assert not hasattr(settings, "ollama_fallback_models")


def test_settings_ignore_removed_ollama_fallback_models_env(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("CERT_PREP_DATA_DIR", str(tmp_path))
    monkeypatch.setenv(
        "CERT_PREP_OLLAMA_FALLBACK_MODELS",
        "other-model, gemma4:12b, ",
    )

    settings = Settings()

    assert not hasattr(settings, "ollama_fallback_models")


def test_provider_selection_endpoint_reports_configured_and_effective_truth(
    tmp_path,
) -> None:
    provider = RecordingDownloadProvider(available=True, detail="model available")
    provider.model = "effective-model"
    client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                llm_provider="ollama",
            ),
            llm_provider=provider,
        )
    )

    response = client.get("/llm/provider-selection", headers=AUTH_HEADERS)

    assert response.status_code == 200
    assert response.json() == {
        "preference": "ollama",
        "selected_provider": "ollama",
        "effective_provider": "ollama",
        "configured_model": "qwen3.5:4b",
        "effective_model": "effective-model",
        "selection_reason": "Selected Ollama from the local provider registry.",
        "fallback_reason": None,
        "runtime_requirement_kind": "ollama",
        "model_requirement_kind": "ollama_model",
    }


def test_provider_selection_endpoint_resolves_profile_model_before_health(
    tmp_path,
) -> None:
    resolve_calls = 0

    class ResolvedOllamaProvider:
        provider = "ollama"
        model = "cert-prep-qwen3.5-4b-study-8k"

    def resolve_provider():
        nonlocal resolve_calls
        resolve_calls += 1
        return ResolvedOllamaProvider()

    provider = provider_module.LazyDraftGenerationProvider(
        resolve_provider,
        provider="ollama",
        model="qwen3.5:4b",
        runtime_requirement_kind=RuntimeRequirementKind.OLLAMA,
    )
    client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                llm_provider="ollama",
            ),
            llm_provider=provider,
        )
    )

    response = client.get("/llm/provider-selection", headers=AUTH_HEADERS)

    assert response.status_code == 200
    assert response.json()["configured_model"] == "qwen3.5:4b"
    assert response.json()["effective_model"] == "cert-prep-qwen3.5-4b-study-8k"
    assert resolve_calls == 1


def test_provider_from_settings_auto_policy_builds_selected_ollama_provider(
    monkeypatch,
    tmp_path,
) -> None:
    inventory = _profile_inventory(total_ram=16 * GIB, free_disk=64 * GIB)
    monkeypatch.setattr(
        ollama_profile_module,
        "collect_machine_inventory",
        lambda **_kwargs: inventory,
    )

    provider = provider_from_settings(Settings(data_dir=tmp_path, llm_provider="auto"))

    assert isinstance(provider, OllamaProvider)
    assert provider.model == "cert-prep-qwen3.5-4b-study-8k"
    assert provider.execution_policy.mode == LLMExecutionMode.CPU


def test_settings_parse_ollama_profile_controls(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("CERT_PREP_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("CERT_PREP_OLLAMA_PROFILE_ENABLED", "false")
    monkeypatch.setenv("CERT_PREP_OLLAMA_PROFILE_ID", DEFAULT_PROFILE_ID)
    monkeypatch.setenv("CERT_PREP_OLLAMA_PROFILE_INVENTORY_TIMEOUT_SECONDS", "1.5")

    settings = Settings()

    assert settings.ollama_profile_enabled is False
    assert settings.ollama_profile_id == DEFAULT_PROFILE_ID
    assert settings.ollama_profile_inventory_timeout_seconds == 1.5


def test_settings_normalizes_ollama_profile_id(tmp_path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        ollama_profile_id=f"  {DEFAULT_PROFILE_ID}  ",
    )
    auto_settings = Settings(data_dir=tmp_path, ollama_profile_id="   ")

    assert settings.ollama_profile_id == DEFAULT_PROFILE_ID
    assert auto_settings.ollama_profile_id == "auto"


def test_settings_rejects_removed_model_and_profile(tmp_path) -> None:
    with pytest.raises(ValidationError):
        Settings(data_dir=tmp_path, ollama_model="qwen3.5:2b")
    with pytest.raises(ValidationError):
        Settings(data_dir=tmp_path, ollama_profile_id="qwen3.5-9b-study-16k")


def test_provider_from_settings_uses_selected_ollama_profile(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setattr(
        ollama_profile_module,
        "collect_machine_inventory",
        lambda **_kwargs: _profile_inventory(total_ram=16 * GIB, free_disk=64 * GIB),
    )

    provider = provider_from_settings(
        Settings(data_dir=tmp_path, llm_provider="ollama", ollama_profile_id="auto")
    )

    assert isinstance(provider, OllamaProvider)
    assert provider.profile_selection is not None
    assert provider.profile_selection.profile_id == DEFAULT_PROFILE_ID
    assert provider.model == "cert-prep-qwen3.5-4b-study-8k"
    assert provider.fallback_models == ()
    assert provider.execution_policy.mode == LLMExecutionMode.CPU


def test_provider_from_settings_keeps_generic_gpu_in_auto_mode(
    monkeypatch,
    tmp_path,
) -> None:
    inventory = replace(
        _profile_inventory(total_ram=16 * GIB, free_disk=64 * GIB),
        accelerators=(
            MachineAcceleratorSnapshot(
                kind="gpu",
                name="Generic Graphics Adapter",
            ),
        ),
    )
    monkeypatch.setattr(
        ollama_profile_module,
        "collect_machine_inventory",
        lambda **_kwargs: inventory,
    )

    provider = provider_from_settings(Settings(data_dir=tmp_path, llm_provider="ollama"))

    assert isinstance(provider, OllamaProvider)
    assert provider.execution_policy.mode == LLMExecutionMode.AUTO
    assert provider.execution_policy.warning is None


def test_provider_from_settings_keeps_fixed_raw_ollama_model_when_profile_disabled(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setattr(
        ollama_profile_module,
        "collect_machine_inventory",
        lambda **_kwargs: _profile_inventory(total_ram=16 * GIB, free_disk=64 * GIB),
    )
    provider = provider_from_settings(
        Settings(
            data_dir=tmp_path,
            llm_provider="ollama",
            ollama_profile_enabled=False,
        )
    )

    assert isinstance(provider, OllamaProvider)
    assert provider.profile_selection is None
    assert provider.model == "qwen3.5:4b"
    assert provider.fallback_models == ()
    assert provider.execution_policy.mode == LLMExecutionMode.CPU
    assert provider.execution_policy.warning is not None


def test_provider_from_settings_forces_cpu_when_windows_inventory_fails(
    monkeypatch,
    tmp_path,
) -> None:
    def fail_inventory(**_kwargs):
        raise RuntimeError("inventory probe failed")

    monkeypatch.setattr(
        ollama_profile_module,
        "collect_machine_inventory",
        fail_inventory,
    )
    monkeypatch.setattr(ollama_package_profiles.platform, "system", lambda: "Windows")

    provider = provider_from_settings(Settings(data_dir=tmp_path, llm_provider="ollama"))

    assert isinstance(provider, OllamaProvider)
    assert provider.profile_selection is not None
    assert provider.profile_selection.inventory is None
    assert provider.execution_policy.mode == LLMExecutionMode.CPU
