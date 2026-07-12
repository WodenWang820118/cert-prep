"""Shared LLM provider value types."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from cert_prep_contracts.runtime import RuntimeRequirementKind


DEFAULT_LLM_PRIMARY_MODEL = "qwen3.5:4b"
DEFAULT_LLM_LOW_RESOURCE_MODEL = "qwen3.5:2b"


class LLMProviderPreference(StrEnum):
    """User/configuration preference used by the local provider selector."""

    AUTO = "auto"
    FASTFLOWLM = "fastflowlm"
    OLLAMA = "ollama"
    FAKE = "fake"


class LLMProviderName(StrEnum):
    """Concrete providers that can execute local draft generation."""

    FASTFLOWLM = "fastflowlm"
    OLLAMA = "ollama"
    FAKE = "fake"


@dataclass(frozen=True, slots=True)
class LLMRuntimePolicy:
    """Single shared model/provider policy for the desktop product."""

    preference: LLMProviderPreference = LLMProviderPreference.AUTO
    primary_model: str = DEFAULT_LLM_PRIMARY_MODEL
    low_resource_model: str = DEFAULT_LLM_LOW_RESOURCE_MODEL


@dataclass(frozen=True, slots=True)
class LLMProviderSelection:
    """Read-only explanation of the configured and effective provider lane."""

    preference: LLMProviderPreference
    selected_provider: LLMProviderName
    effective_provider: LLMProviderName
    configured_model: str
    effective_model: str
    selection_reason: str
    fallback_reason: str | None
    hardware_compatible: bool
    requires_terms_acceptance: bool
    terms_accepted: bool
    terms_version: str | None
    terms_url: str | None
    runtime_requirement_kind: RuntimeRequirementKind | None
    model_requirement_kind: RuntimeRequirementKind | None


@dataclass(frozen=True, slots=True)
class GenerationAttribution:
    """Provider/model truth captured from one completed generation call."""

    effective_provider: str | None
    effective_model: str | None
    fallback_reason: str | None = None


@dataclass(frozen=True, slots=True)
class FastFlowLMRuntimeTrustPolicy:
    """Pinned official FastFlowLM installer and Authenticode allowlist."""

    version: str
    installer_url: str
    installer_file_name: str
    installer_bytes: int
    installer_sha256: str
    executable_bytes: int
    executable_sha256: str
    signer_subject: str
    signer_thumbprint: str
    terms_url: str
    minimum_windows_driver_version: str


DEFAULT_LLM_RUNTIME_POLICY = LLMRuntimePolicy()
FASTFLOWLM_RUNTIME_TRUST_POLICY = FastFlowLMRuntimeTrustPolicy(
    version="0.9.43",
    installer_url=(
        "https://github.com/FastFlowLM/FastFlowLM/releases/download/"
        "v0.9.43/flm-setup.exe"
    ),
    installer_file_name="flm-setup-v0.9.43.exe",
    installer_bytes=18_577_840,
    installer_sha256="0b0ec2c049222bba8e15f1d4d7093f89f2f25a6beeddd03bdb1fcac69002315e",
    # Captured from flm.exe installed by the exact allowlisted installer above.
    executable_bytes=6_475_264,
    executable_sha256="92ecc734e65251ce79b4e65b9be88c4561c44a8d835f6ccbf341d8491e9ee218",
    # Captured with Get-AuthenticodeSignature from the pinned installer URL on
    # 2026-07-11 after the size and SHA-256 checks above matched.
    signer_subject=(
        "OID.1.3.6.1.4.1.311.60.2.1.3=US, "
        "OID.1.3.6.1.4.1.311.60.2.1.2=Delaware, "
        "OID.2.5.4.15=Private Organization, CN=FastFlowLM Inc., "
        "SERIALNUMBER=10267153, O=FastFlowLM Inc., L=Warwick, "
        "S=Rhode Island, C=US"
    ),
    signer_thumbprint="EBD8F43D1208A9F34CEC082CE94AD98D67BB2FF9",
    terms_url=(
        "https://raw.githubusercontent.com/FastFlowLM/FastFlowLM/"
        "v0.9.43/src/inno/terms.txt"
    ),
    minimum_windows_driver_version="32.0.203.304",
)


@dataclass(frozen=True, slots=True)
class ModelPullProgress:
    """Progress reported by an explicit model download provider."""

    status: str
    completed: int | None = None
    total: int | None = None


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
    "ModelPullProgress",
]
