from fastapi.testclient import TestClient

from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.mock_exams import ollama_profiles as ollama_profile_module
from cert_prep_backend.domains.mock_exams import provider as provider_module
from cert_prep_backend.domains.mock_exams.fastflowlm_transport import FastFlowLMProvider
from cert_prep_backend.domains.mock_exams.model_fallback import ModelFallbackEngine
from cert_prep_backend.domains.mock_exams.ollama_transport import OllamaProvider
from cert_prep_backend.domains.mock_exams.provider import provider_from_settings
from cert_prep_backend.domains.mock_exams.provider_selection import (
    provider_selection_from_settings,
)
from cert_prep_backend.domains.mock_exams import provider_selection as provider_selection_module
from cert_prep_contracts.hardware import MachineAcceleratorSnapshot, MachineCpuSnapshot
from cert_prep_contracts.llm import LLMProviderName
from cert_prep_ollama.profiles import DEFAULT_PROFILE_ID
from llm_test_fakes import GIB, RecordingDownloadProvider, _profile_inventory


AUTH_HEADERS = {"Authorization": "Bearer test-token"}


def _compatible_xdna2_inventory():
    inventory = _profile_inventory(total_ram=32 * GIB, free_disk=64 * GIB)
    return inventory.__class__(
        platform="Windows",
        platform_version="10.0.26100",
        architecture=inventory.architecture,
        cpu=MachineCpuSnapshot(
            architecture="AMD64",
            name="AMD Ryzen AI 9 H 365",
            logical_cores=20,
        ),
        ram=inventory.ram,
        storage=inventory.storage,
        accelerators=(
            MachineAcceleratorSnapshot(
                kind="npu",
                name="NPU Compute Accelerator Device",
            ),
            MachineAcceleratorSnapshot(
                kind="gpu",
                name="AMD Radeon 880M",
                vendor="amd",
                driver_version="32.0.203.304",
            ),
        ),
    )


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


def test_model_fallback_engine_captures_per_generation_attribution() -> None:
    engine = ModelFallbackEngine(
        primary_model="qwen3.5:4b",
        fallback_models=["qwen3.5:2b"],
    )
    engine.reset_generation_attribution()
    engine.mark_model_unusable("qwen3.5:4b", RuntimeError("model requires more memory"))
    engine.record_model_success("qwen3.5:2b")

    attribution = engine.generation_attribution("fastflowlm")

    assert attribution.effective_provider == "fastflowlm"
    assert attribution.effective_model == "qwen3.5:2b"
    assert "model requires more memory" in attribution.fallback_reason

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


def test_provider_selection_endpoint_reports_configured_and_effective_truth(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setattr(
        provider_selection_module,
        "_cached_machine_inventory",
        lambda _timeout: _compatible_xdna2_inventory(),
    )
    provider = RecordingDownloadProvider(available=True, detail="model available")
    provider.provider = "fastflowlm"
    provider.model = "qwen3.5:2b"
    client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                llm_provider="fastflowlm",
                fastflowlm_terms_accepted_version="0.9.43",
            ),
            llm_provider=provider,
        )
    )

    response = client.get("/llm/provider-selection", headers=AUTH_HEADERS)

    assert response.status_code == 200
    assert response.json()["preference"] == "fastflowlm"
    assert response.json()["selected_provider"] == "fastflowlm"
    assert response.json()["effective_provider"] == "fastflowlm"
    assert response.json()["configured_model"] == "qwen3.5:4b"
    assert response.json()["effective_model"] == "qwen3.5:2b"
    assert response.json()["terms_accepted"] is True
    assert response.json()["terms_version"] == "0.9.43"
    assert response.json()["terms_url"].endswith("/v0.9.43/src/inno/terms.txt")


def test_provider_selection_endpoint_resolves_profile_model_before_health(
    monkeypatch,
    tmp_path,
) -> None:
    resolve_calls = 0
    monkeypatch.setattr(
        provider_selection_module,
        "_cached_machine_inventory",
        lambda _timeout: _profile_inventory(total_ram=16 * GIB, free_disk=64 * GIB),
    )

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
        supports_ollama_runtime_installation=True,
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


def test_fastflowlm_terms_decision_endpoint_persists_exact_accepted_version(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setattr(
        provider_selection_module,
        "_cached_machine_inventory",
        lambda _timeout: _compatible_xdna2_inventory(),
    )
    settings = Settings(
        data_dir=tmp_path,
        api_token="test-token",
        llm_provider="fastflowlm",
    )
    provider = RecordingDownloadProvider(available=False, detail="runtime missing")
    provider.provider = "fastflowlm"
    provider.model = "qwen3.5:4b"
    app = create_app(settings=settings, llm_provider=provider)

    with TestClient(app) as client:
        response = client.post(
            "/llm/provider-selection/fastflowlm-terms-decision",
            headers=AUTH_HEADERS,
            json={"decision": "accepted", "terms_version": "0.9.43"},
        )

    assert response.status_code == 200
    assert response.json()["terms_accepted"] is True
    assert response.json()["terms_version"] == "0.9.43"
    assert settings.fastflowlm_terms_accepted_version == "0.9.43"
    assert settings.fastflowlm_terms_declined is False


def test_fastflowlm_terms_decision_endpoint_rejects_untrusted_version(tmp_path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        api_token="test-token",
        llm_provider="fastflowlm",
    )
    provider = RecordingDownloadProvider(available=False, detail="runtime missing")
    app = create_app(settings=settings, llm_provider=provider)

    with TestClient(app) as client:
        response = client.post(
            "/llm/provider-selection/fastflowlm-terms-decision",
            headers=AUTH_HEADERS,
            json={"decision": "accepted", "terms_version": "0.9.44"},
        )

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"
    assert settings.fastflowlm_terms_accepted_version is None


def test_auto_provider_policy_selects_fastflowlm_only_for_verified_xdna2(
    tmp_path,
) -> None:
    compatible_inventory = _profile_inventory(total_ram=32 * GIB, free_disk=64 * GIB)
    compatible_inventory = compatible_inventory.__class__(
        platform="Windows",
        platform_version="10.0.26100",
        architecture=compatible_inventory.architecture,
        cpu=MachineCpuSnapshot(
            architecture="AMD64",
            name="AMD Ryzen AI 9 H 365",
            logical_cores=20,
        ),
        ram=compatible_inventory.ram,
        storage=compatible_inventory.storage,
        accelerators=(
            MachineAcceleratorSnapshot(
                kind="npu",
                name="NPU Compute Accelerator Device",
            ),
            MachineAcceleratorSnapshot(
                kind="gpu",
                name="AMD Radeon 880M",
                vendor="amd",
                driver_version="32.0.203.304",
            ),
        ),
    )

    selection = provider_selection_from_settings(
        Settings(data_dir=tmp_path, llm_provider="auto"),
        inventory=compatible_inventory,
    )

    assert selection.selected_provider == LLMProviderName.FASTFLOWLM
    assert selection.configured_model == "qwen3.5:4b"
    assert selection.hardware_compatible is True
    assert selection.requires_terms_acceptance is True

    declined = provider_selection_from_settings(
        Settings(
            data_dir=tmp_path,
            llm_provider="auto",
            fastflowlm_terms_declined=True,
        ),
        inventory=compatible_inventory,
    )
    assert declined.selected_provider == LLMProviderName.OLLAMA
    assert declined.fallback_reason == "FastFlowLM terms were declined."


def test_auto_provider_policy_routes_incompatible_hardware_to_ollama(tmp_path) -> None:
    incompatible_inventory = _profile_inventory(total_ram=16 * GIB, free_disk=64 * GIB)

    selection = provider_selection_from_settings(
        Settings(data_dir=tmp_path, llm_provider="auto"),
        inventory=incompatible_inventory,
    )

    assert selection.selected_provider == LLMProviderName.OLLAMA
    assert selection.model_requirement_kind.value == "ollama_model"
    assert selection.fallback_reason == "No compatible AMD XDNA2 NPU was detected."


def test_explicit_fastflowlm_preference_cannot_override_declined_terms(
    tmp_path,
) -> None:
    compatible_inventory = _profile_inventory(total_ram=32 * GIB, free_disk=64 * GIB)
    compatible_inventory = compatible_inventory.__class__(
        platform="Windows",
        platform_version="10.0.26100",
        architecture=compatible_inventory.architecture,
        cpu=MachineCpuSnapshot(
            architecture="AMD64",
            name="AMD Ryzen AI 9 H 365",
            logical_cores=20,
        ),
        ram=compatible_inventory.ram,
        storage=compatible_inventory.storage,
        accelerators=(
            MachineAcceleratorSnapshot(
                kind="npu",
                name="NPU Compute Accelerator Device",
            ),
            MachineAcceleratorSnapshot(
                kind="gpu",
                name="AMD Radeon 880M",
                vendor="amd",
                driver_version="32.0.203.304",
            ),
        ),
    )

    selection = provider_selection_from_settings(
        Settings(
            data_dir=tmp_path,
            llm_provider="fastflowlm",
            fastflowlm_terms_declined=True,
        ),
        inventory=compatible_inventory,
    )

    assert selection.selected_provider == LLMProviderName.OLLAMA
    assert selection.fallback_reason == "FastFlowLM terms were declined."
    assert selection.requires_terms_acceptance is False


def test_explicit_fastflowlm_preference_fails_closed_on_incompatible_hardware(
    tmp_path,
) -> None:
    selection = provider_selection_from_settings(
        Settings(data_dir=tmp_path, llm_provider="fastflowlm"),
        inventory=_profile_inventory(total_ram=16 * GIB, free_disk=64 * GIB),
    )

    assert selection.selected_provider == LLMProviderName.OLLAMA
    assert selection.fallback_reason == "No compatible AMD XDNA2 NPU was detected."
    assert selection.requires_terms_acceptance is False


def test_provider_from_settings_auto_policy_builds_selected_ollama_provider(
    monkeypatch,
    tmp_path,
) -> None:
    inventory = _profile_inventory(total_ram=16 * GIB, free_disk=64 * GIB)
    monkeypatch.setattr(
        provider_selection_module,
        "_cached_machine_inventory",
        lambda _timeout: inventory,
    )
    monkeypatch.setattr(
        ollama_profile_module,
        "collect_machine_inventory",
        lambda **_kwargs: inventory,
    )

    provider = provider_from_settings(Settings(data_dir=tmp_path, llm_provider="auto"))

    assert isinstance(provider, OllamaProvider)
    assert provider.model == "cert-prep-qwen3.5-4b-study-8k"

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
