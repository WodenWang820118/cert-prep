from __future__ import annotations

from fastapi import APIRouter, Depends

from cert_prep_backend.ai_providers.api.schemas import (
    LLMHealthRead,
    LLMProviderSelectionRead,
    OllamaProfileSelectionRead,
    OllamaProfilesRead,
)
from cert_prep_backend.ai_providers.domain.provider import LLMProvider
from cert_prep_backend.ai_providers.infrastructure.ollama_profiles import (
    profile_catalog_payload,
    profile_selection_payload,
)
from cert_prep_backend.ai_providers.infrastructure.provider_selection import (
    provider_selection_from_settings,
)
from cert_prep_backend.api.dependencies import get_llm_provider
from cert_prep_backend.platform.config import Settings
from cert_prep_backend.platform.dependencies import get_settings


router = APIRouter(prefix="/llm", tags=["llm"])


@router.get("/health", response_model=LLMHealthRead)
def llm_health(provider: LLMProvider = Depends(get_llm_provider)):
    return provider.health()


@router.get("/provider-selection", response_model=LLMProviderSelectionRead)
def llm_provider_selection(
    settings: Settings = Depends(get_settings),
    provider: LLMProvider = Depends(get_llm_provider),
):
    return _provider_selection_response(settings, provider)


def _provider_selection_response(settings: Settings, provider: LLMProvider):
    resolve = getattr(provider, "resolved_provider", None)
    effective_provider = resolve() if callable(resolve) else provider
    return provider_selection_from_settings(
        settings,
        effective_provider=str(getattr(effective_provider, "provider", "")),
        effective_model=str(getattr(effective_provider, "model", "")),
    )


@router.get("/profiles", response_model=OllamaProfilesRead)
def llm_profiles():
    return profile_catalog_payload()


@router.get("/profile-selection", response_model=OllamaProfileSelectionRead)
def llm_profile_selection(settings: Settings = Depends(get_settings)):
    return profile_selection_payload(settings)
