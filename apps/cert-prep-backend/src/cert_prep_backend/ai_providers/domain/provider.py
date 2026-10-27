"""The language model a learner's app uses, and what each provider can do besides answering.

A provider always reports its health. Every other ability is an optional capability that
callers look up with ``provider_capability``; a lazily created provider is resolved only when
a capability is asked for.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final, Protocol, TypeVar, runtime_checkable

from cert_prep_contracts.llm import (
    GenerationAttribution,
    LLMExecutionMode,
    ModelPullProgress as _ModelPullProgress,
)
from cert_prep_contracts.runtime import RuntimeRequirementKind

__all__ = [
    "DEFAULT_KEEP_ALIVE",
    "GenerationAttributionProvider",
    "JsonChat",
    "JsonChatProvider",
    "LLMProvider",
    "ModelDownloadProvider",
    "ModelOnboardingProvider",
    "ProviderHealth",
    "ResourceReleasingProvider",
    "RuntimeInstallationProvider",
    "StartsOnGenerationProvider",
    "StreamingGenerationOptionsProvider",
    "StructuredJsonGenerationProvider",
    "provider_capability",
]

# How long a local model stays loaded after a call when the caller does not say.
DEFAULT_KEEP_ALIVE: Final = "5m"

TProvider = TypeVar("TProvider")
TReply = TypeVar("TReply")


@dataclass(frozen=True, slots=True)
class ProviderHealth:
    """Read-only health snapshot for a language model provider."""

    provider: str
    model: str
    available: bool
    detail: str
    unavailable_reason: str | None = None
    configured_model: str | None = None
    effective_model: str | None = None
    fallback_models: tuple[str, ...] = ()
    fallback_reason: str | None = None
    execution_mode: LLMExecutionMode | None = None
    execution_warning: str | None = None
    profile_id: str | None = None
    base_model: str | None = None
    modelfile_sha256: str | None = None
    profile_reason: str | None = None
    profile_warnings: tuple[str, ...] = ()


class LLMProvider(Protocol):
    """The configured language model: which provider and model, and whether it can be used."""

    provider: str
    model: str

    def health(self) -> ProviderHealth:
        """Return provider and model availability without generating anything."""
        pass


class JsonChat(Protocol):
    """One JSON-mode chat with the model of the current session; returns the reply text."""

    def __call__(
        self,
        messages: Sequence[Mapping[str, str]],
        *,
        num_ctx: int,
        num_predict: int,
        keep_alive: str | float | int | None = DEFAULT_KEEP_ALIVE,
    ) -> object:
        """Return the reply text, or ``None`` when the reply has none."""
        pass


@runtime_checkable
class JsonChatProvider(Protocol):
    """Provider capability for JSON-mode chats with the configured model."""

    def json_chat_session(self, operation: Callable[[JsonChat], TReply]) -> TReply:
        """Run ``operation`` with a JSON chat bound to the configured model.

        The model is checked once, before ``operation`` runs. Any failure inside
        ``operation``, including one raised while reading a reply, is reported as a failure
        of the model; only a session that succeeds counts toward the generation attribution.
        """
        pass


@runtime_checkable
class StructuredJsonGenerationProvider(Protocol):
    """Provider capability for returning one schema-constrained JSON candidate verbatim."""

    provider: str
    model: str

    def generate_structured_json(
        self,
        *,
        messages: Sequence[Mapping[str, str]],
        json_schema: Mapping[str, Any],
        num_ctx: int = 8192,
        num_predict: int = 4096,
        keep_alive: str | float | int | None = DEFAULT_KEEP_ALIVE,
    ) -> str:
        """Return the provider response text without parsing or repairing it."""
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
