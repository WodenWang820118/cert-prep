from __future__ import annotations

from cert_prep_backend.platform.config import Settings
from cert_prep_backend.ai_providers.infrastructure import machine_inventory as machine_inventory_module
from cert_prep_backend.ai_providers.infrastructure.ollama_transport import OllamaProvider
from cert_prep_backend.ai_providers.infrastructure.provider import (
    _provider_model_hint,
    _selected_provider_from_settings,
    lazy_provider_from_settings,
    provider_from_settings,
)
from cert_prep_backend.ai_providers.domain.selection import select_provider
from cert_prep_contracts.llm import LLMProviderName, LLMProviderPreference
from cert_prep_contracts.runtime import RuntimeRequirementKind
from llm_test_fakes import GIB, _profile_inventory


def test_auto_policy_selects_the_ollama_alpha_lane(tmp_path) -> None:
    settings = Settings(data_dir=tmp_path, llm_provider="auto")
    selection = select_provider(
        LLMProviderPreference(settings.llm_provider),
        configured_model=settings.ollama_model,
    )

    assert selection.preference == LLMProviderPreference.AUTO
    assert selection.selected_provider == LLMProviderName.OLLAMA
    assert selection.runtime_requirement_kind == RuntimeRequirementKind.OLLAMA
    assert selection.model_requirement_kind == RuntimeRequirementKind.OLLAMA_MODEL
    assert selection.fallback_reason is None


def test_explicit_fake_policy_keeps_provider_neutral_selection_shape(tmp_path) -> None:
    settings = Settings(data_dir=tmp_path, llm_provider="fake")
    selection = select_provider(
        LLMProviderPreference(settings.llm_provider),
        configured_model=settings.ollama_model,
        effective_provider="fake",
        effective_model="test-model",
    )

    assert selection.preference == LLMProviderPreference.FAKE
    assert selection.selected_provider == LLMProviderName.FAKE
    assert selection.effective_provider == LLMProviderName.FAKE
    assert selection.effective_model == "test-model"
    assert selection.runtime_requirement_kind is None
    assert selection.model_requirement_kind is None


def test_provider_factory_uses_the_auto_selected_ollama_lane(
    monkeypatch,
    tmp_path,
) -> None:
    inventory = _profile_inventory(total_ram=16 * GIB, free_disk=64 * GIB)
    monkeypatch.setattr(
        machine_inventory_module,
        "collect_machine_inventory",
        lambda **_kwargs: inventory,
    )

    provider = provider_from_settings(Settings(data_dir=tmp_path, llm_provider="auto"))

    assert isinstance(provider, OllamaProvider)
    assert provider.model == "cert-prep-qwen3.5-4b-study-8k"


def _reconfigure_lazy_provider(lazy_provider, settings: Settings) -> None:
    selected_provider = _selected_provider_from_settings(settings).value
    with lazy_provider._lock:
        resolved = lazy_provider._provider
        lazy_provider._provider = None
        lazy_provider._provider_hint = selected_provider
        lazy_provider._model_hint = _provider_model_hint(settings, selected_provider)
        lazy_provider._runtime_requirement_kind = (
            RuntimeRequirementKind.OLLAMA
            if selected_provider == "ollama"
            else None
        )
        lazy_provider._starts_on_generation = False
    if resolved is not None:
        close = getattr(resolved, "close", None)
        if callable(close):
            close()


def test_lazy_provider_reconfigures_through_the_generic_factory_seam(tmp_path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        api_token="test-token",
        llm_provider="fake",
    )
    provider = lazy_provider_from_settings(settings)

    settings.llm_provider = "ollama"
    _reconfigure_lazy_provider(provider, settings)

    assert provider.provider == "ollama"
    assert provider.model
    assert provider.runtime_requirement_kind == RuntimeRequirementKind.OLLAMA
