"""Taking stock of the machine: CPU, memory, storage and accelerators, cached for a while."""

from __future__ import annotations

from threading import Lock
import time

from cert_prep_backend.platform.config import Settings
from cert_prep_contracts.hardware import MachineInventorySnapshot
from cert_prep_ollama.inventory import collect_machine_inventory


_INVENTORY_CACHE_TTL_SECONDS = 300.0
_inventory_cache_lock = Lock()
# Process-local cache: multi-worker deployments collect once per worker per TTL.
_inventory_cache: dict[tuple[str, float], tuple[float, object]] = {}


class OllamaMachineInventory:
    """The machine inventory Ollama profiles are chosen for, measured where models are stored."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def inventory(self, *, refresh: bool = False) -> MachineInventorySnapshot:
        return collect_ollama_machine_inventory(self._settings, refresh=refresh)


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


__all__ = ["OllamaMachineInventory", "collect_ollama_machine_inventory"]
