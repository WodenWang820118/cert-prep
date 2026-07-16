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
    OLLAMA = "ollama"
    FAKE = "fake"


class LLMProviderName(StrEnum):
    """Concrete providers that can execute local draft generation."""

    OLLAMA = "ollama"
    FAKE = "fake"


class LLMExecutionMode(StrEnum):
    """How a local LLM provider is instructed to choose compute hardware."""

    AUTO = "auto"
    CPU = "cpu"


@dataclass(frozen=True, slots=True)
class LLMExecutionPolicy:
    """Execution mode and any non-blocking warning exposed to local clients."""

    mode: LLMExecutionMode = LLMExecutionMode.AUTO
    warning: str | None = None

    def __post_init__(self) -> None:
        warning = self.warning.strip() if self.warning is not None else None
        if self.mode == LLMExecutionMode.CPU and not warning:
            raise ValueError("CPU execution mode requires a warning.")
        if self.mode == LLMExecutionMode.AUTO and self.warning is not None:
            raise ValueError("Auto execution mode must not claim an execution warning.")


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
    runtime_requirement_kind: RuntimeRequirementKind | None
    model_requirement_kind: RuntimeRequirementKind | None


@dataclass(frozen=True, slots=True)
class GenerationAttribution:
    """Provider/model truth captured from one completed generation call."""

    effective_provider: str | None
    effective_model: str | None
    fallback_reason: str | None = None


DEFAULT_LLM_RUNTIME_POLICY = LLMRuntimePolicy()


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
    "GenerationAttribution",
    "LLMExecutionMode",
    "LLMExecutionPolicy",
    "LLMProviderName",
    "LLMProviderPreference",
    "LLMProviderSelection",
    "LLMRuntimePolicy",
    "ModelPullProgress",
]
