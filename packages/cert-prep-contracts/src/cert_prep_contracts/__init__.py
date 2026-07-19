"""Shared Python contracts for cert-prep apps and runtime packages."""

from cert_prep_contracts.documents import (
    DOCUMENT_STATUS_VALUES,
    DocumentOperationPhase,
    DocumentOperationRead,
    DocumentOperationStatus,
    SourceDocumentStatus,
    SourceDocumentStatusValue,
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
from cert_prep_contracts.ocr import OCRHealth, OCRPageResult, OCRProvider
from cert_prep_contracts.runtime import (
    RuntimeInstallationStatus,
    RuntimeInstallProgress,
    RuntimeRequirementKind,
    RuntimeRequirementSnapshot,
)
from cert_prep_contracts.transcription import (
    MAX_AUDIO_DURATION_MS,
    TranscriptSegment,
    TranscriptionCanceledError,
    TranscriptionProvider,
    TranscriptionResult,
)

__all__ = [
    "DEFAULT_LLM_PRIMARY_MODEL",
    "DEFAULT_LLM_RUNTIME_POLICY",
    "DOCUMENT_STATUS_VALUES",
    "DocumentOperationPhase",
    "DocumentOperationRead",
    "DocumentOperationStatus",
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
    "SourceDocumentStatus",
    "SourceDocumentStatusValue",
    "TranscriptSegment",
    "TranscriptionCanceledError",
    "TranscriptionProvider",
    "TranscriptionResult",
]
