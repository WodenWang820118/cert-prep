from __future__ import annotations

from collections.abc import Callable
from typing import TypeVar

from cert_prep_backend.api.errors import ProviderUnavailableError
from cert_prep_backend.domains.mock_exams.response_parsing import (
    is_non_fatal_generation_error as is_non_fatal_llm_generation_error,
    short_error,
)


T = TypeVar("T")


class FastFlowLMGenerationMixin:
    """Model candidate and fallback execution helpers for FastFlowLM."""

    def _available_model_candidates(self) -> tuple[str, ...]:
        self._refresh_primary_ram_state()
        try:
            model_names = self._served_model_names_for_generation()
        except Exception as exc:
            raise ProviderUnavailableError(f"FastFlowLM unavailable: {exc}") from exc

        candidates = self._fallback_engine.available_model_candidates(model_names)
        if candidates:
            return candidates

        health = self.health()
        raise ProviderUnavailableError(health.detail)

    def _effective_model_from(self, model_names: set[str]) -> str | None:
        return self._fallback_engine.effective_model_from(model_names)

    def _fallback_reason(self, effective_model: str | None) -> str | None:
        return self._fallback_engine.fallback_reason(
            effective_model,
            include_primary_failure=True,
        )

    def _with_model_fallback(self, operation: Callable[[str], T]) -> T:
        self._server_manager.begin_generation_request()
        try:
            errors: list[str] = []
            for model in self._available_model_candidates():
                try:
                    result = operation(model)
                except Exception as exc:
                    if _is_transient_fastflowlm_generation_error(exc):
                        raise ProviderUnavailableError(
                            f"FastFlowLM transient generation error for {model}: {short_error(exc)}"
                        ) from exc
                    errors.append(f"{model}: {short_error(exc)}")
                    if not _is_non_fatal_fastflowlm_generation_error(exc):
                        self._mark_model_unusable(model, exc)
                    continue

                self._record_model_success(model)
                return result

            detail = "FastFlowLM unavailable for configured and fallback models"
            if errors:
                detail = f"{detail}: {'; '.join(errors)}"
            raise ProviderUnavailableError(detail)
        finally:
            self._server_manager.end_generation_request()

    def _mark_model_unusable(self, model: str, exc: Exception) -> None:
        self._fallback_engine.mark_model_unusable(model, exc)

    def _record_model_success(self, model: str) -> None:
        self._fallback_engine.record_model_success(model)

    def _runtime_unusable_models(self) -> set[str]:
        return self._fallback_engine.runtime_unusable_models()

    def _primary_failure_reason(self) -> str | None:
        return self._fallback_engine.primary_failure_reason()


def _is_non_fatal_fastflowlm_generation_error(exc: Exception) -> bool:
    return is_non_fatal_llm_generation_error(exc) or _is_transient_fastflowlm_generation_error(exc)


def _is_transient_fastflowlm_generation_error(exc: Exception) -> bool:
    error = short_error(exc).lower()
    return any(
        marker in error
        for marker in (
            "timed out",
            "timeout",
            "client disconnected",
            "cancelled",
        )
    )
