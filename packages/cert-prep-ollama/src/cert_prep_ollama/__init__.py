"""Ollama infrastructure utilities shared across cert-prep projects."""

from cert_prep_ollama.exceptions import OllamaError, ProviderUnavailableError
from cert_prep_ollama.inventory import collect_machine_inventory
from cert_prep_ollama.installers import (
    OllamaModelInstaller,
    OllamaRuntimeInstaller,
    ollama_windows_install_command,
)
from cert_prep_ollama.modelfiles import (
    DEFAULT_CERT_PREP_SYSTEM_PROMPT,
    modelfile_sha256,
    parameters_from_profile,
    render_modelfile,
)
from cert_prep_ollama.models import (
    DEFAULT_OLLAMA_MODEL,
    extract_model_names,
    pull_progress,
)
from cert_prep_ollama.profile_installer import OllamaProfileInstaller
from cert_prep_ollama.profiles import (
    AUTO_PROFILE_ID,
    DEFAULT_OLLAMA_PROFILES,
    DEFAULT_PROFILE_ID,
    fallback_models_for_selection,
    profile_by_id,
    profile_catalog,
    select_ollama_execution_policy,
    select_ollama_profile,
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
    "DEFAULT_OLLAMA_PROFILES",
    "DEFAULT_PROFILE_ID",
    "DEFAULT_CERT_PREP_SYSTEM_PROMPT",
    "AUTO_PROFILE_ID",
    "OLLAMA_API_READY_TIMEOUT_SECONDS",
    "OllamaError",
    "OllamaModelInstaller",
    "OllamaProfileInstaller",
    "OllamaRuntimeInstaller",
    "ProviderUnavailableError",
    "collect_machine_inventory",
    "ensure_ollama_server_running",
    "extract_model_names",
    "fallback_models_for_selection",
    "modelfile_sha256",
    "ollama_api_available",
    "ollama_windows_install_command",
    "parameters_from_profile",
    "profile_by_id",
    "profile_catalog",
    "pull_progress",
    "render_modelfile",
    "resolve_ollama_executable",
    "select_ollama_execution_policy",
    "select_ollama_profile",
]
