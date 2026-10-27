from __future__ import annotations

from dataclasses import asdict
from typing import Any

from fastapi import APIRouter, Depends, Request

from cert_prep_backend.ai_providers.api.schemas import (
    LLMHealthRead,
    LLMProviderSelectionRead,
    OllamaProfileSelectionRead,
    OllamaProfilesRead,
)
from cert_prep_backend.ai_providers.application import use_cases as ai_providers
from cert_prep_backend.ai_providers.application.ports import MachineInventory
from cert_prep_backend.ai_providers.domain.provider import LLMProvider
from cert_prep_backend.platform.config import Settings
from cert_prep_backend.platform.dependencies import get_settings
from cert_prep_contracts.llm_profiles import OllamaModelProfile, OllamaProfileSupportStatus


router = APIRouter(prefix="/llm", tags=["llm"])


def get_llm_provider(request: Request) -> LLMProvider:
    return request.app.state.llm_provider


def get_machine_inventory(request: Request) -> MachineInventory:
    return request.app.state.machine_inventory


@router.get("/health", response_model=LLMHealthRead)
def llm_health(provider: LLMProvider = Depends(get_llm_provider)):
    return ai_providers.check_provider_health(provider)


@router.get("/provider-selection", response_model=LLMProviderSelectionRead)
def llm_provider_selection(
    settings: Settings = Depends(get_settings),
    provider: LLMProvider = Depends(get_llm_provider),
):
    return ai_providers.show_provider_selection(settings, provider)


@router.get("/profiles", response_model=OllamaProfilesRead)
def llm_profiles():
    return {"items": [_profile_read(profile) for profile in ai_providers.list_model_profiles()]}


@router.get("/profile-selection", response_model=OllamaProfileSelectionRead)
def llm_profile_selection(
    settings: Settings = Depends(get_settings),
    machine: MachineInventory = Depends(get_machine_inventory),
):
    return _profile_selection_read(ai_providers.show_profile_selection(settings, machine))


def _profile_selection_read(report: ai_providers.ProfileSelectionReport) -> dict[str, Any]:
    selection = report.selection
    if selection is None:
        return {
            "profile_enabled": False,
            "profile_id": None,
            "selected_profile": None,
            "support_status": OllamaProfileSupportStatus.DISABLED.value,
            "reason": (
                "Ollama profile selection is disabled or the LLM provider is not Ollama; "
                "using the configured raw model."
            ),
            "fallback_profiles": [],
            "fallback_models": [],
            "warnings": [],
            "inventory": None,
            "modelfile_sha256": None,
            "effective_model": report.configured_model,
            "base_model": None,
        }
    profile = selection.selected_profile
    return {
        "profile_enabled": True,
        "profile_id": selection.profile_id,
        "selected_profile": _profile_read(profile),
        "support_status": selection.support_status.value,
        "reason": selection.reason,
        "fallback_profiles": [_profile_read(fallback) for fallback in selection.fallback_profiles],
        "fallback_models": list(report.fallback_models),
        "warnings": list(selection.warnings),
        "inventory": asdict(selection.inventory) if selection.inventory is not None else None,
        "modelfile_sha256": selection.modelfile_sha256,
        "effective_model": profile.local_model,
        "base_model": profile.base_model,
    }


def _profile_read(profile: OllamaModelProfile) -> dict[str, Any]:
    return {
        "profile_id": profile.profile_id,
        "display_name": profile.display_name,
        "description": profile.description,
        "base_model": profile.base_model,
        "local_model": profile.local_model,
        "context_window": profile.context_window,
        "system_prompt": profile.system_prompt,
        "parameters": dict(profile.parameters),
        "min_total_ram_bytes": profile.min_total_ram_bytes,
        "min_available_ram_bytes": profile.min_available_ram_bytes,
        "min_free_disk_bytes": profile.min_free_disk_bytes,
        "min_vram_bytes": profile.min_vram_bytes,
        "auto_selectable": profile.auto_selectable,
        "explicit_opt_in_required": profile.explicit_opt_in_required,
        "fallback_profile_ids": list(profile.fallback_profile_ids),
    }
