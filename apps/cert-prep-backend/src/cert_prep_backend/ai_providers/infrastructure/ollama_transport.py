from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from functools import partial
import logging
from threading import local
from typing import Any, TypeVar

from cert_prep_backend.ai_providers.domain.generation_errors import short_error
from cert_prep_backend.ai_providers.domain.provider import (
    DEFAULT_KEEP_ALIVE,
    JsonChat,
    ProviderHealth,
)
from cert_prep_backend.ai_providers.infrastructure.ollama_client import OllamaClient
from cert_prep_contracts.llm import (
    GenerationAttribution,
    LLMExecutionMode,
    LLMExecutionPolicy,
)
from cert_prep_backend.platform.errors import ProviderUnavailableError
from cert_prep_contracts.llm_profiles import OllamaProfileSelection
from cert_prep_contracts.runtime import RuntimeRequirementKind
from cert_prep_ollama.models import extract_model_names, pull_progress
from cert_prep_ollama.server import ensure_ollama_server_running, resolve_ollama_executable


STREAMING_PREWARM_KEEP_ALIVE = DEFAULT_KEEP_ALIVE
STREAMING_RELEASE_KEEP_ALIVE = 0
T = TypeVar("T")
_LOGGER = logging.getLogger(__name__)


class OllamaProvider:
    """Ollama-backed language model provider and model-download transport."""

    provider = "ollama"

    def __init__(
        self,
        host: str,
        model: str,
        timeout_seconds: float,
        profile_selection: OllamaProfileSelection | None = None,
        execution_policy: LLMExecutionPolicy | None = None,
        client: Any | None = None,
    ) -> None:
        self.host = host
        self.model = model
        self.fallback_models: tuple[str, ...] = ()
        self.profile_selection = profile_selection
        self.execution_policy = execution_policy or LLMExecutionPolicy()
        self._generation_state = local()
        self._client = client or OllamaClient(host=host, timeout_seconds=timeout_seconds)
        if self.execution_policy.warning is not None:
            _LOGGER.warning("Ollama CPU fallback: %s", self.execution_policy.warning)

    @property
    def runtime_requirement_kind(self) -> RuntimeRequirementKind:
        return RuntimeRequirementKind.OLLAMA

    @property
    def starts_on_generation(self) -> bool:
        return False

    def streaming_generation_kwargs(self) -> dict[str, Any]:
        return {"keep_alive": STREAMING_RELEASE_KEEP_ALIVE}

    def reset_generation_attribution(self) -> None:
        self._generation_state.model = None

    def generation_attribution(self) -> GenerationAttribution:
        model = getattr(self._generation_state, "model", None)
        return GenerationAttribution(
            effective_provider=self.provider if model is not None else None,
            effective_model=model,
            fallback_reason=None,
        )

    def health(self) -> ProviderHealth:
        """Return Ollama process and configured-model availability."""

        try:
            model_names = self._installed_model_names()
        except Exception as exc:
            executable = resolve_ollama_executable()
            if executable is None:
                detail = "Ollama is not installed."
                unavailable_reason = "ollama_missing"
            else:
                if ensure_ollama_server_running(self.host, executable=executable):
                    try:
                        model_names = self._installed_model_names()
                    except Exception as retry_exc:
                        detail = f"Ollama unavailable: {retry_exc}"
                        unavailable_reason = "ollama_not_running"
                    else:
                        return self._health_from_model_names(model_names)
                else:
                    detail = f"Ollama unavailable: {exc}"
                    unavailable_reason = "ollama_not_running"
            return ProviderHealth(
                provider=self.provider,
                model=self.model,
                available=False,
                detail=detail,
                unavailable_reason=unavailable_reason,
                configured_model=self.model,
                fallback_models=self.fallback_models,
                **self._health_metadata_fields(),
            )

        return self._health_from_model_names(model_names)

    def _health_from_model_names(self, model_names: set[str]) -> ProviderHealth:
        effective_model = self._effective_model_from(model_names)
        available = effective_model is not None
        detail = self._health_detail(effective_model)
        return ProviderHealth(
            provider=self.provider,
            model=self.model,
            available=available,
            detail=detail,
            unavailable_reason=None if available else "model_missing",
            configured_model=self.model,
            effective_model=effective_model,
            fallback_models=self.fallback_models,
            fallback_reason=None,
            **self._health_metadata_fields(),
        )

    def _health_metadata_fields(self) -> dict[str, object]:
        fields: dict[str, object] = {
            "execution_mode": self.execution_policy.mode,
            "execution_warning": self.execution_policy.warning,
        }
        selection = self.profile_selection
        if selection is None:
            return fields
        fields.update(
            {
                "profile_id": selection.profile_id,
                "base_model": selection.selected_profile.base_model,
                "modelfile_sha256": selection.modelfile_sha256,
                "profile_reason": selection.reason,
                "profile_warnings": selection.warnings,
            }
        )
        return fields

    def _chat_options(self, *, num_ctx: int, num_predict: int) -> dict[str, int]:
        options = {
            "temperature": 0,
            "num_ctx": num_ctx,
            "num_predict": num_predict,
        }
        if self.execution_policy.mode == LLMExecutionMode.CPU:
            options["num_gpu"] = 0
        return options

    def generate_structured_json(
        self,
        *,
        messages: Sequence[Mapping[str, str]],
        json_schema: Mapping[str, Any],
        num_ctx: int = 8192,
        num_predict: int = 4096,
        keep_alive: str | float | int | None = STREAMING_PREWARM_KEEP_ALIVE,
    ) -> str:
        """Return one schema-constrained response from the existing Ollama provider verbatim."""

        return self._with_primary_model(
            lambda model: _message_content(
                self._client.chat(
                    model=model,
                    messages=[dict(message) for message in messages],
                    format=dict(json_schema),
                    options=self._chat_options(
                        num_ctx=num_ctx,
                        num_predict=num_predict,
                    ),
                    think=False,
                    keep_alive=keep_alive,
                )
            )
        )

    def json_chat_session(self, operation: Callable[[JsonChat], T]) -> T:
        """Run ``operation`` with JSON-mode chats bound to the configured Ollama model."""

        return self._with_primary_model(lambda model: operation(partial(self._json_chat, model)))

    def _json_chat(
        self,
        model: str,
        messages: Sequence[Mapping[str, str]],
        *,
        num_ctx: int,
        num_predict: int,
        keep_alive: str | float | int | None = STREAMING_PREWARM_KEEP_ALIVE,
    ) -> object:
        return _reply_content(
            self._client.chat(
                model=model,
                messages=[dict(message) for message in messages],
                format="json",
                options=self._chat_options(
                    num_ctx=num_ctx,
                    num_predict=num_predict,
                ),
                think=False,
                keep_alive=keep_alive,
            )
        )

    def pull_model(self, progress) -> None:
        """Pull the configured Ollama model after explicit user confirmation."""

        for update in self._client.pull(self.model, stream=True):
            progress(pull_progress(update))

    def _available_effective_model(self) -> str:
        health = self.health()
        if health.available and health.effective_model:
            return health.effective_model
        raise ProviderUnavailableError(health.detail)

    def _effective_model_from(self, model_names: set[str]) -> str | None:
        return self.model if self.model in model_names else None

    def _health_detail(self, effective_model: str | None) -> str:
        if effective_model is None:
            return "model not found"
        return "model available"

    def _installed_model_names(self) -> set[str]:
        return extract_model_names(self._client.list())

    def _available_primary_model(self) -> str:
        try:
            model_names = self._installed_model_names()
        except Exception as exc:
            raise ProviderUnavailableError(f"Ollama unavailable: {exc}") from exc

        if self.model in model_names:
            return self.model

        raise ProviderUnavailableError(self._health_detail(None))

    def _with_primary_model(self, operation: Callable[[str], T]) -> T:
        model = self._available_primary_model()
        try:
            result = operation(model)
        except Exception as exc:
            raise ProviderUnavailableError(
                f"Ollama unavailable for configured model {model}: {short_error(exc)}"
            ) from exc
        self._generation_state.model = model
        return result


def _message_content(response: Any) -> str:
    content = getattr(getattr(response, "message", None), "content", None)
    if content is None and isinstance(response, dict):
        message = response.get("message")
        if isinstance(message, dict):
            content = message.get("content")
    if not isinstance(content, str) or not content.strip():
        raise ValueError("Ollama returned an empty structured JSON candidate")
    return content


def _reply_content(response: Any) -> object:
    message = getattr(response, "message", None)
    content = None
    if isinstance(message, dict):
        content = message.get("content")
    elif message is not None:
        content = getattr(message, "content", None)
    if content is None and isinstance(response, dict):
        message = response.get("message")
        if isinstance(message, dict):
            content = message.get("content")
    return content
