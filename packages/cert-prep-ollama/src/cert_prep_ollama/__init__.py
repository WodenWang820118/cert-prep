"""Ollama infrastructure utilities shared across cert-prep projects."""

from cert_prep_contracts.llm import ModelPullProgress
from cert_prep_contracts.runtime import (
    RuntimeInstallationStatus,
    RuntimeInstallProgress,
    RuntimeRequirementKind,
    RuntimeRequirementSnapshot,
)
from cert_prep_ollama.exceptions import OllamaError, ProviderUnavailableError
from cert_prep_ollama.installers import (
    OllamaModelInstaller,
    OllamaRuntimeInstaller,
    ollama_windows_install_command,
)
from cert_prep_ollama.models import (
    DEFAULT_OLLAMA_MODEL,
    extract_model_names,
    pull_progress,
)
from cert_prep_ollama.server import (
    DEFAULT_OLLAMA_HOST,
    OLLAMA_API_READY_TIMEOUT_SECONDS,
    ensure_ollama_server_running,
    ollama_api_available,
    resolve_ollama_executable,
)

__all__ = [
    "DEFAULT_OLLAMA_HOST",
    "DEFAULT_OLLAMA_MODEL",
    "ModelPullProgress",
    "OLLAMA_API_READY_TIMEOUT_SECONDS",
    "OllamaError",
    "OllamaModelInstaller",
    "OllamaRuntimeInstaller",
    "ProviderUnavailableError",
    "RuntimeInstallProgress",
    "RuntimeInstallationStatus",
    "RuntimeRequirementKind",
    "RuntimeRequirementSnapshot",
    "ensure_ollama_server_running",
    "extract_model_names",
    "ollama_api_available",
    "ollama_windows_install_command",
    "pull_progress",
    "resolve_ollama_executable",
]
