"""Shared Python contracts for cert-prep apps and runtime packages."""

from cert_prep_contracts.hardware import (
    MachineAcceleratorSnapshot,
    MachineCpuSnapshot,
    MachineInventorySnapshot,
    MachineRamSnapshot,
    MachineStorageSnapshot,
)
from cert_prep_contracts.llm import ModelPullProgress
from cert_prep_contracts.llm_profiles import (
    OllamaModelProfile,
    OllamaParameterValue,
    OllamaProfileSelection,
    OllamaProfileSupportStatus,
)
from cert_prep_contracts.ocr import OCRHealth, OCRPageResult, OCRProvider
from cert_prep_contracts.runtime import (
    RuntimeInstallationStatus,
    RuntimeInstallProgress,
    RuntimeRequirementKind,
    RuntimeRequirementSnapshot,
)

__all__ = [
    "MachineAcceleratorSnapshot",
    "MachineCpuSnapshot",
    "MachineInventorySnapshot",
    "MachineRamSnapshot",
    "MachineStorageSnapshot",
    "ModelPullProgress",
    "OCRHealth",
    "OCRPageResult",
    "OCRProvider",
    "OllamaModelProfile",
    "OllamaParameterValue",
    "OllamaProfileSelection",
    "OllamaProfileSupportStatus",
    "RuntimeInstallationStatus",
    "RuntimeInstallProgress",
    "RuntimeRequirementKind",
    "RuntimeRequirementSnapshot",
]
