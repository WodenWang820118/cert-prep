"""Shared Python contracts for cert-prep apps and runtime packages."""

from cert_prep_contracts.sources import (
    SOURCE_STATUS_VALUES,
    SourceOperationPhase,
    SourceOperationRead,
    SourceOperationStatus,
    SourceStatus,
    SourceStatusValue,
    SourceKind,
)
from cert_prep_contracts.hardware import (
    MachineAcceleratorSnapshot,
    MachineCpuSnapshot,
    MachineInventorySnapshot,
    MachineRamSnapshot,
    MachineStorageSnapshot,
)
from cert_prep_contracts.llm import (
    DEFAULT_LLM_PRIMARY_MODEL,
    DEFAULT_LLM_RUNTIME_POLICY,
    GenerationAttribution,
    LLMExecutionMode,
    LLMExecutionPolicy,
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
from cert_prep_contracts.llm_installation import (
    LLMInstallationStatus,
    LLMInstallProgress,
    LLMRequirementKind,
    LLMRequirementSnapshot,
)
from cert_prep_contracts.transcription import (
    MAX_AUDIO_DURATION_MS,
    TranscriptSegment,
)

__all__ = [
    "DEFAULT_LLM_PRIMARY_MODEL",
    "DEFAULT_LLM_RUNTIME_POLICY",
    "SOURCE_STATUS_VALUES",
    "SourceOperationPhase",
    "SourceOperationRead",
    "SourceOperationStatus",
    "GenerationAttribution",
    "LLMExecutionMode",
    "LLMExecutionPolicy",
    "LLMProviderName",
    "LLMProviderPreference",
    "LLMProviderSelection",
    "LLMRuntimePolicy",
    "MAX_AUDIO_DURATION_MS",
    "MachineAcceleratorSnapshot",
    "MachineCpuSnapshot",
    "MachineInventorySnapshot",
    "MachineRamSnapshot",
    "MachineStorageSnapshot",
    "ModelPullProgress",
    "OllamaModelProfile",
    "OllamaParameterValue",
    "OllamaProfileSelection",
    "OllamaProfileSupportStatus",
    "LLMInstallationStatus",
    "LLMInstallProgress",
    "LLMRequirementKind",
    "LLMRequirementSnapshot",
    "SourceStatus",
    "SourceStatusValue",
    "SourceKind",
    "TranscriptSegment",
]
