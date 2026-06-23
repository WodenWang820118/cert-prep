from __future__ import annotations

from cert_prep_backend.domains.runtime_installations.archive import (
    extract_zip_safely,
    resolve_ocr_runtime_artifact,
    verify_file_hash,
)
from cert_prep_backend.domains.runtime_installations.installers import (
    WindowsMLOcrRuntimeInstaller,
    OllamaModelInstaller,
    OllamaRuntimeInstaller,
    PaddleOcrRuntimeInstaller,
)
from cert_prep_backend.domains.runtime_installations.manager import (
    RuntimeInstallationManager,
    RuntimeInstaller,
)
from cert_prep_backend.domains.runtime_installations.manifest import (
    load_ocr_runtime_source_manifest,
    parse_ocr_runtime_manifest,
    write_installed_ocr_manifest,
)
from cert_prep_backend.domains.runtime_installations.models import (
    OcrRuntimeManifest,
    RuntimeInstallationSnapshot,
    RuntimeInstallationStatus,
    RuntimeInstallProgress,
    RuntimeRequirementKind,
    RuntimeRequirementSnapshot,
)
from cert_prep_backend.domains.runtime_installations.ollama import (
    ensure_ollama_server_running,
    resolve_ollama_executable,
)
from cert_prep_backend.domains.runtime_installations.processes import run_ocr_runtime_command

__all__ = [
    "OcrRuntimeManifest",
    "WindowsMLOcrRuntimeInstaller",
    "OllamaModelInstaller",
    "OllamaRuntimeInstaller",
    "PaddleOcrRuntimeInstaller",
    "RuntimeInstallationManager",
    "RuntimeInstallationSnapshot",
    "RuntimeInstallationStatus",
    "RuntimeInstallProgress",
    "RuntimeInstaller",
    "RuntimeRequirementKind",
    "RuntimeRequirementSnapshot",
    "extract_zip_safely",
    "ensure_ollama_server_running",
    "load_ocr_runtime_source_manifest",
    "parse_ocr_runtime_manifest",
    "resolve_ocr_runtime_artifact",
    "resolve_ollama_executable",
    "run_ocr_runtime_command",
    "verify_file_hash",
    "write_installed_ocr_manifest",
]
