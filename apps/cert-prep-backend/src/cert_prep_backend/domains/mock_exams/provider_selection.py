from __future__ import annotations

from cert_prep_backend.core.config import Settings
from cert_prep_contracts.llm import (
    LLMProviderName,
    LLMProviderPreference,
    LLMProviderSelection,
)
from cert_prep_contracts.runtime import RuntimeRequirementKind


def provider_selection_from_settings(
    settings: Settings,
    *,
    inventory=None,
    effective_provider: str | None = None,
    effective_model: str | None = None,
) -> LLMProviderSelection:
    """Resolve the configured provider through the provider-neutral selection seam."""

    del inventory
    preference = LLMProviderPreference(settings.llm_provider)
    selected = (
        LLMProviderName.FAKE
        if preference == LLMProviderPreference.FAKE
        else LLMProviderName.OLLAMA
    )
    effective = _provider_name_or_default(effective_provider, selected)
    return LLMProviderSelection(
        preference=preference,
        selected_provider=selected,
        effective_provider=effective,
        configured_model=settings.ollama_model,
        effective_model=effective_model or settings.ollama_model,
        selection_reason=(
            "Selected fake from the explicit provider preference."
            if selected == LLMProviderName.FAKE
            else "Selected Ollama from the local provider registry."
        ),
        fallback_reason=None,
        runtime_requirement_kind=(
            RuntimeRequirementKind.OLLAMA
            if selected == LLMProviderName.OLLAMA
            else None
        ),
        model_requirement_kind=(
            RuntimeRequirementKind.OLLAMA_MODEL
            if selected == LLMProviderName.OLLAMA
            else None
        ),
    )


def _provider_name_or_default(
    provider: str | None,
    default: LLMProviderName,
) -> LLMProviderName:
    try:
        return LLMProviderName(provider) if provider else default
    except ValueError:
        return default


__all__ = ["provider_selection_from_settings"]
