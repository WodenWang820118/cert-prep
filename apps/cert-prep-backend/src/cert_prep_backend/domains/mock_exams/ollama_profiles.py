from __future__ import annotations

from dataclasses import asdict
from threading import Lock
import time
from typing import Any

from cert_prep_backend.core.config import Settings
from cert_prep_contracts.llm_profiles import (
    OllamaModelProfile,
    OllamaProfileSelection,
    OllamaProfileSupportStatus,
)
from cert_prep_ollama.inventory import collect_machine_inventory
from cert_prep_ollama.profiles import (
    fallback_models_for_selection,
    profile_catalog,
    select_ollama_profile,
)


_INVENTORY_CACHE_TTL_SECONDS = 300.0
_inventory_cache_lock = Lock()
# Process-local cache: multi-worker deployments collect once per worker per TTL.
_inventory_cache: dict[tuple[str, float], tuple[float, object]] = {}


def collect_ollama_machine_inventory(settings: Settings, *, refresh: bool = False):
    """Collect machine inventory using backend settings for timeout and storage path."""

    cache_key = (
        str(settings.data_dir.resolve()),
        settings.ollama_profile_inventory_timeout_seconds,
    )
    now = time.monotonic()
    if not refresh:
        with _inventory_cache_lock:
            cached = _inventory_cache.get(cache_key)
            if cached is not None and now - cached[0] < _INVENTORY_CACHE_TTL_SECONDS:
                return cached[1]

    inventory = collect_machine_inventory(
        model_storage_path=settings.data_dir,
        timeout_seconds=settings.ollama_profile_inventory_timeout_seconds,
    )
    with _inventory_cache_lock:
        _inventory_cache[cache_key] = (time.monotonic(), inventory)
    return inventory


def ollama_profile_selection_from_settings(
    settings: Settings,
) -> OllamaProfileSelection | None:
    """Resolve selected Ollama profile when profile selection is enabled."""

    if settings.llm_provider != "ollama" or not settings.ollama_profile_enabled:
        return None
    inventory = collect_ollama_machine_inventory(settings)
    return select_ollama_profile(inventory, profile_id=settings.ollama_profile_id)


def profile_catalog_payload() -> dict[str, Any]:
    """Return profile catalog payload for the read-only API."""

    return {"items": [_profile_payload(profile) for profile in profile_catalog()]}


def profile_selection_payload(settings: Settings) -> dict[str, Any]:
    """Return profile selection payload, including disabled/raw-model mode."""

    selection = ollama_profile_selection_from_settings(settings)
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
            "fallback_models": list(settings.ollama_fallback_models),
            "warnings": [],
            "inventory": None,
            "modelfile_sha256": None,
            "effective_model": settings.ollama_model,
            "base_model": None,
        }
    return _selection_payload(selection)


def _selection_payload(selection: OllamaProfileSelection) -> dict[str, Any]:
    profile = selection.selected_profile
    return {
        "profile_enabled": True,
        "profile_id": selection.profile_id,
        "selected_profile": _profile_payload(profile),
        "support_status": selection.support_status.value,
        "reason": selection.reason,
        "fallback_profiles": [
            _profile_payload(fallback) for fallback in selection.fallback_profiles
        ],
        "fallback_models": list(fallback_models_for_selection(selection)),
        "warnings": list(selection.warnings),
        "inventory": asdict(selection.inventory) if selection.inventory is not None else None,
        "modelfile_sha256": selection.modelfile_sha256,
        "effective_model": profile.local_model,
        "base_model": profile.base_model,
    }


def _profile_payload(profile: OllamaModelProfile) -> dict[str, Any]:
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


__all__ = [
    "collect_ollama_machine_inventory",
    "ollama_profile_selection_from_settings",
    "profile_catalog_payload",
    "profile_selection_payload",
]
