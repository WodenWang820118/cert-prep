"""Shared Python contracts for cert-prep apps and runtime packages."""

from cert_prep_contracts.hardware import (
    MachineAcceleratorSnapshot,
    MachineCpuSnapshot,
    MachineInventorySnapshot,
    MachineRamSnapshot,
    MachineStorageSnapshot,
)
from cert_prep_contracts.llm import (
    DEFAULT_LLM_LOW_RESOURCE_MODEL,
    DEFAULT_LLM_PRIMARY_MODEL,
    DEFAULT_LLM_RUNTIME_POLICY,
    FASTFLOWLM_RUNTIME_TRUST_POLICY,
    FastFlowLMRuntimeTrustPolicy,
    GenerationAttribution,
    LLMProviderName,
    LLMProviderPreference,
    LLMProviderSelection,
    LLMRuntimePolicy,
    ModelPullProgress,
)
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
    "DEFAULT_LLM_LOW_RESOURCE_MODEL",
    "DEFAULT_LLM_PRIMARY_MODEL",
    "DEFAULT_LLM_RUNTIME_POLICY",
    "FASTFLOWLM_RUNTIME_TRUST_POLICY",
    "FastFlowLMRuntimeTrustPolicy",
    "GenerationAttribution",
    "LLMProviderName",
    "LLMProviderPreference",
    "LLMProviderSelection",
    "LLMRuntimePolicy",
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
