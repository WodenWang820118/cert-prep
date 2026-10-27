"""Which provider a learner's preference selects, and what that provider needs installed."""

from __future__ import annotations

from cert_prep_contracts.llm import (
    LLMProviderName,
    LLMProviderPreference,
    LLMProviderSelection,
)
from cert_prep_contracts.runtime import RuntimeRequirementKind


def select_provider(
    preference: LLMProviderPreference,
    *,
    configured_model: str,
    effective_provider: str | None = None,
    effective_model: str | None = None,
) -> LLMProviderSelection:
    """Select the provider for a preference: the fake one only when asked for, else Ollama."""

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
        configured_model=configured_model,
        effective_model=effective_model or configured_model,
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


__all__ = ["select_provider"]
