from fastapi.testclient import TestClient

from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.mock_exams import ollama_profiles as ollama_profile_module
from cert_prep_backend.domains.mock_exams import provider as provider_module
from cert_prep_backend.domains.mock_exams.fastflowlm_transport import FastFlowLMProvider
from cert_prep_backend.domains.mock_exams.model_fallback import ModelFallbackEngine
from cert_prep_backend.domains.mock_exams.ollama_transport import OllamaProvider
from cert_prep_backend.domains.mock_exams.provider import provider_from_settings
from cert_prep_contracts.llm import LLMProviderName
from cert_prep_ollama.profiles import DEFAULT_PROFILE_ID
from llm_test_fakes import GIB, RecordingDownloadProvider, _profile_inventory


AUTH_HEADERS = {"Authorization": "Bearer test-token"}


def test_model_fallback_engine_records_runtime_fallback_reason() -> None:
    engine = ModelFallbackEngine(
        primary_model="qwen3.5:4b",
        fallback_models=["qwen3.5:2b"],
        retry_after_seconds=300,
    )

    engine.mark_model_unusable("qwen3.5:4b", RuntimeError("transient OOM"))
    assert engine.available_model_candidates({"qwen3.5:4b", "qwen3.5:2b"}) == ("qwen3.5:2b",)

    engine.record_model_success("qwen3.5:2b")

    assert engine.fallback_reason("qwen3.5:2b") == (
        "Configured model qwen3.5:4b was unavailable during generation "
        "(transient OOM); using fallback qwen3.5:2b."
    )

    engine.record_model_success("qwen3.5:4b")

    assert engine.runtime_unusable_models() == set()
    assert engine.fallback_reason("qwen3.5:4b") is None

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

def test_settings_parse_comma_separated_ollama_fallback_models(tmp_path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        ollama_fallback_models="qwen3.5:2b, gemma4:12b, ",
    )

    assert settings.ollama_fallback_models == ["qwen3.5:2b", "gemma4:12b"]

def test_settings_parse_env_ollama_fallback_models(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("CERT_PREP_DATA_DIR", str(tmp_path))
    monkeypatch.setenv(
        "CERT_PREP_OLLAMA_FALLBACK_MODELS",
        "qwen3.5:2b, gemma4:12b, ",
    )

    settings = Settings()

    assert settings.ollama_fallback_models == ["qwen3.5:2b", "gemma4:12b"]

def test_settings_parse_comma_separated_fastflowlm_fallback_models(tmp_path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        fastflowlm_fallback_models="qwen3.5:2b, qwen3.5:0.8b, ",
    )

    assert settings.fastflowlm_fallback_models == ["qwen3.5:2b", "qwen3.5:0.8b"]

def test_provider_from_settings_can_select_fastflowlm(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(
        provider_module,
        "_selected_provider_from_settings",
        lambda _settings: LLMProviderName.FASTFLOWLM,
    )
    provider = provider_from_settings(
        Settings(
            data_dir=tmp_path,
            llm_provider="fastflowlm",
            fastflowlm_model="qwen3.5:4b",
            fastflowlm_fallback_models=["qwen3.5:2b"],
            fastflowlm_base_url="http://127.0.0.1:52625/v1/",
        )
    )

    assert isinstance(provider, FastFlowLMProvider)
    assert provider.provider == "fastflowlm"
    assert provider.model == "qwen3.5:4b"
    assert provider.fallback_models == ("qwen3.5:2b",)
    assert provider.base_url == "http://127.0.0.1:52625/v1"
    assert provider.auto_start_server is True
    assert provider.owned_server_idle_timeout_seconds == 5.0

def test_settings_parse_ollama_profile_controls(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("CERT_PREP_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("CERT_PREP_OLLAMA_PROFILE_ENABLED", "false")
    monkeypatch.setenv("CERT_PREP_OLLAMA_PROFILE_ID", "qwen3.5-2b-study-4k")
    monkeypatch.setenv("CERT_PREP_OLLAMA_PROFILE_INVENTORY_TIMEOUT_SECONDS", "1.5")

    settings = Settings()

    assert settings.ollama_profile_enabled is False
    assert settings.ollama_profile_id == "qwen3.5-2b-study-4k"
    assert settings.ollama_profile_inventory_timeout_seconds == 1.5

def test_settings_normalizes_ollama_profile_id(tmp_path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        ollama_profile_id="  qwen3.5-2b-study-4k  ",
    )
    auto_settings = Settings(data_dir=tmp_path, ollama_profile_id="   ")

    assert settings.ollama_profile_id == "qwen3.5-2b-study-4k"
    assert auto_settings.ollama_profile_id == "auto"

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
    assert provider.fallback_models == ("cert-prep-qwen3.5-2b-study-4k",)

def test_provider_from_settings_preserves_raw_ollama_model_when_profile_disabled(
    tmp_path,
) -> None:
    provider = provider_from_settings(
        Settings(
            data_dir=tmp_path,
            llm_provider="ollama",
            ollama_profile_enabled=False,
            ollama_model="custom-local:latest",
            ollama_fallback_models=["fallback-local:latest"],
        )
    )

    assert isinstance(provider, OllamaProvider)
    assert provider.profile_selection is None
    assert provider.model == "custom-local:latest"
    assert provider.fallback_models == ("fallback-local:latest",)
