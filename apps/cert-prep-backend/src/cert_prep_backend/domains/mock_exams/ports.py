from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Protocol, TypeVar, runtime_checkable

from cert_prep_backend.domains.mock_exams.models import DraftSuggestion, SourceChunk
from cert_prep_contracts.llm import (
    GenerationAttribution,
    ModelPullProgress as _ModelPullProgress,
)
from cert_prep_contracts.runtime import RuntimeRequirementKind

__all__ = [
    "DraftGenerationProvider",
    "FastFirstDraftProvider",
    "GenerationAttributionProvider",
    "ModelOnboardingProvider",
    "ModelDownloadProvider",
    "RuntimeInstallationProvider",
    "ProviderHealth",
    "ReasoningDraftProvider",
    "ResourceReleasingProvider",
    "StartsOnGenerationProvider",
    "StreamingGenerationOptionsProvider",
    "provider_capability",
]

TProvider = TypeVar("TProvider")


@dataclass(frozen=True, slots=True)
class ProviderHealth:
    """Read-only health snapshot for a draft-generation provider."""

    provider: str
    model: str
    available: bool
    detail: str
    unavailable_reason: str | None = None
    configured_model: str | None = None
    effective_model: str | None = None
    fallback_models: tuple[str, ...] = ()
    fallback_reason: str | None = None
    profile_id: str | None = None
    base_model: str | None = None
    modelfile_sha256: str | None = None
    profile_reason: str | None = None
    profile_warnings: tuple[str, ...] = ()


class DraftGenerationProvider(Protocol):
    """Boundary for providers that turn source chunks into draft exam items."""

    provider: str
    model: str

    def health(self) -> ProviderHealth:
        """Return provider and model availability without generating drafts."""
        pass

    def generate_drafts(self, chunks: Sequence[SourceChunk], limit: int) -> list[DraftSuggestion]:
        """Generate up to limit draft suggestions from source chunks."""
        pass


@runtime_checkable
class ReasoningDraftProvider(Protocol):
    """Provider capability for structured reasoning over source chunks."""

    def generate_reasoning_drafts(
        self,
        chunks: Sequence[SourceChunk],
        limit: int,
        **kwargs: Any,
    ) -> list[DraftSuggestion]:
        """Generate drafts through the provider's reasoning path."""
        pass


@runtime_checkable
class FastFirstDraftProvider(Protocol):
    """Provider capability for completing one deterministic draft candidate."""

    def generate_fast_first_draft(
        self,
        source_chunk: SourceChunk,
        candidate: DraftSuggestion,
        **kwargs: Any,
    ) -> DraftSuggestion | None:
        """Complete answer/rationale fields for one deterministic draft."""
        pass


@runtime_checkable
class ModelDownloadProvider(Protocol):
    """Provider capability for explicit model downloads."""

    def pull_model(self, progress: Callable[[_ModelPullProgress], None]) -> None:
        """Pull/install the configured model after explicit user confirmation."""
        pass


@runtime_checkable
class GenerationAttributionProvider(Protocol):
    """Provider capability for per-worker generation truth."""

    def reset_generation_attribution(self) -> None:
        """Clear attribution before one durable generation job."""
        pass

    def generation_attribution(self) -> GenerationAttribution:
        """Return provider/model truth from the latest successful generation call."""
        pass


@runtime_checkable
class ModelOnboardingProvider(Protocol):
    """Provider capability for bounded pre/post model-install readiness probes."""

    def prepare_model_onboarding(
        self,
        progress: Callable[[_ModelPullProgress], None],
    ) -> None:
        """Validate the runtime and inspect installed models before pulling."""
        pass

    def verify_model_onboarding(
        self,
        progress: Callable[[_ModelPullProgress], None],
    ) -> None:
        """Check the model, owned server, model API, and tiny completion."""
        pass


@runtime_checkable
class ResourceReleasingProvider(Protocol):
    """Provider capability for releasing per-job runtime resources."""

    def release_resources(self) -> None:
        """Release resources after a streaming generation job."""
        pass


@runtime_checkable
class StreamingGenerationOptionsProvider(Protocol):
    """Provider-owned streaming keyword arguments for generation calls."""

    def streaming_generation_kwargs(self) -> dict[str, Any]:
        """Return extra provider-specific kwargs for streaming generation calls."""
        pass


@runtime_checkable
class StartsOnGenerationProvider(Protocol):
    """Provider capability for lazy runtime startup during generation."""

    @property
    def starts_on_generation(self) -> bool:
        """Return true when generation can start an unavailable provider runtime."""
        pass


@runtime_checkable
class RuntimeInstallationProvider(Protocol):
    """Provider capability for declaring an installable local runtime."""

    @property
    def runtime_requirement_kind(self) -> RuntimeRequirementKind | None:
        """Return the provider runtime requirement, if it is locally installable."""
        pass


def provider_capability(provider: object, protocol: type[TProvider]) -> TProvider | None:
    """Return a provider capability, resolving lazy providers only when needed."""

    if isinstance(provider, protocol):
        return provider
    resolved_provider = getattr(provider, "resolved_provider", None)
    if not callable(resolved_provider):
        return None
    resolved = resolved_provider()
    return resolved if isinstance(resolved, protocol) else None
