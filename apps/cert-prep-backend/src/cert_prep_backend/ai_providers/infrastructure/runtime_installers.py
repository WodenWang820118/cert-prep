"""Concrete Ollama installer construction; downstream contexts use structural ports."""

from __future__ import annotations

from collections.abc import Callable
from threading import Lock
from typing import TYPE_CHECKING, TypeVar

from cert_prep_backend.ai_providers.application.ports import MachineInventory
from cert_prep_backend.ai_providers.application.use_cases import choose_ollama_profile
from cert_prep_backend.ai_providers.domain.provider import (
    RuntimeInstallationProvider,
    provider_capability,
)
from cert_prep_backend.platform.config import Settings
from cert_prep_backend.platform.errors import ProviderUnavailableError
from cert_prep_contracts.runtime import (
    RuntimeInstallationStatus,
    RuntimeInstallProgress,
    RuntimeRequirementKind,
    RuntimeRequirementSnapshot,
)

if TYPE_CHECKING:
    from cert_prep_ollama.installers import OllamaRuntimeInstaller
    from cert_prep_ollama.profile_installer import OllamaProfileInstaller

TInstaller = TypeVar("TInstaller")


def configured_installer_choices(
    settings: Settings,
    provider: object,
    machine: MachineInventory,
    default_model: Callable[[], TInstaller],
) -> tuple[list[OllamaRuntimeInstaller], TInstaller | LazyOllamaProfileInstaller | OllamaProfileInstaller]:
    from cert_prep_ollama.installers import OllamaRuntimeInstaller

    capability = provider_capability(provider, RuntimeInstallationProvider)
    runtime_kind = capability.runtime_requirement_kind if capability is not None else None
    runtimes = []
    if runtime_kind == RuntimeRequirementKind.OLLAMA:
        runtimes.append(OllamaRuntimeInstaller(
            ollama_host=settings.ollama_host,
            runtime_install_timeout_seconds=settings.runtime_install_timeout_seconds,
        ))
    model = default_model()
    if runtime_kind == RuntimeRequirementKind.OLLAMA and settings.ollama_profile_enabled:
        model = LazyOllamaProfileInstaller(settings, machine)
    elif runtime_kind == RuntimeRequirementKind.OLLAMA:
        selection = getattr(provider, "profile_selection", None)
        if selection is not None:
            from cert_prep_ollama.profile_installer import OllamaProfileInstaller

            model = OllamaProfileInstaller(
                selection.selected_profile,
                host=settings.ollama_host,
                timeout_seconds=settings.ollama_timeout_seconds,
                runtime_install_timeout_seconds=settings.runtime_install_timeout_seconds,
            )
    return runtimes, model


class LazyOllamaProfileInstaller:
    kind = RuntimeRequirementKind.OLLAMA_MODEL
    provider = "ollama"

    def __init__(self, settings: Settings, machine_inventory: MachineInventory) -> None:
        self._settings = settings
        self._machine_inventory = machine_inventory
        self._lock = Lock()
        self._installer: OllamaProfileInstaller | None = None

    @property
    def model(self) -> str:
        installer = self._installer
        if installer is not None:
            return installer.model
        return f"ollama-profile:{self._settings.ollama_profile_id}"

    def requirement(self) -> RuntimeRequirementSnapshot:
        return self._delegate().requirement()

    def validate_installable(self) -> None:
        validate = getattr(self._delegate(), "validate_installable", None)
        if callable(validate):
            validate()

    def install(
        self, progress: Callable[[RuntimeInstallProgress], None]
    ) -> RuntimeInstallationStatus:
        return self._delegate().install(progress)

    def _delegate(self) -> OllamaProfileInstaller:
        installer = self._installer
        if installer is not None:
            return installer
        with self._lock:
            if self._installer is None:
                from cert_prep_ollama.profile_installer import OllamaProfileInstaller

                selection = choose_ollama_profile(
                    self._settings, self._machine_inventory.inventory, provider_selected=True,
                )
                if selection is None:
                    raise ProviderUnavailableError("Ollama profile selection is not available.")
                self._installer = OllamaProfileInstaller(
                    selection.selected_profile,
                    host=self._settings.ollama_host,
                    timeout_seconds=self._settings.ollama_timeout_seconds,
                    runtime_install_timeout_seconds=self._settings.runtime_install_timeout_seconds,
                )
            return self._installer
