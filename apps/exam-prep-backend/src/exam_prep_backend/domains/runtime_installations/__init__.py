from __future__ import annotations

from exam_prep_backend.domains.runtime_installations.archive import (
    extract_zip_safely,
    resolve_ocr_runtime_artifact,
    verify_file_hash,
)
from exam_prep_backend.domains.runtime_installations.installers import (
    OllamaModelInstaller,
    OllamaRuntimeInstaller,
    PaddleOcrRuntimeInstaller,
)
from exam_prep_backend.domains.runtime_installations.manager import (
    RuntimeInstallationManager,
    RuntimeInstaller,
)
from exam_prep_backend.domains.runtime_installations.manifest import (
    load_ocr_runtime_source_manifest,
    parse_ocr_runtime_manifest,
    write_installed_ocr_manifest,
)
from exam_prep_backend.domains.runtime_installations.models import (
    OcrRuntimeManifest,
    RuntimeInstallationSnapshot,
    RuntimeInstallationStatus,
    RuntimeInstallProgress,
    RuntimeRequirementKind,
    RuntimeRequirementSnapshot,
)
from exam_prep_backend.domains.runtime_installations.ollama import resolve_ollama_executable
from exam_prep_backend.domains.runtime_installations.processes import run_ocr_runtime_command

__all__ = [
    "OcrRuntimeManifest",
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
    "load_ocr_runtime_source_manifest",
    "parse_ocr_runtime_manifest",
    "resolve_ocr_runtime_artifact",
    "resolve_ollama_executable",
    "run_ocr_runtime_command",
    "verify_file_hash",
    "write_installed_ocr_manifest",
]
