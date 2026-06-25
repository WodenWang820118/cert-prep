from __future__ import annotations

from collections.abc import Callable, Iterable
from threading import Lock
import time

from cert_prep_backend.domains.mock_exams.response_parsing import short_error_text


class ModelFallbackEngine:
    """Tracks provider-local primary/fallback model state without doing IO."""

    def __init__(
        self,
        *,
        primary_model: str,
        fallback_models: Iterable[str],
        retry_after_seconds: float | None = None,
        error_shortener: Callable[[Exception], str] | None = None,
    ) -> None:
        self.primary_model = primary_model
        self.fallback_models = tuple(
            dict.fromkeys(
                fallback.strip()
                for fallback in fallback_models
                if fallback.strip() and fallback.strip() != primary_model
            )
        )
        self.retry_after_seconds = retry_after_seconds
        self._short_error = error_shortener or (
            lambda exc: short_error_text(str(exc) or exc.__class__.__name__)
        )
        self._lock = Lock()
        self._unusable_models: dict[str, float] = {}
        self._runtime_effective_model: str | None = None
        self._last_primary_failure: str | None = None
        self._runtime_fallback_reason: str | None = None
        self._primary_memory_blocked = False

    def effective_model_from(self, model_names: set[str]) -> str | None:
        unusable_models, runtime_effective_model = self.runtime_model_state()
        if (
            runtime_effective_model
            and runtime_effective_model in model_names
            and runtime_effective_model not in unusable_models
        ):
            return runtime_effective_model
        for candidate in self.model_order:
            if candidate in unusable_models:
                continue
            if candidate in model_names:
                return candidate
        return None

    def available_model_candidates(self, model_names: set[str]) -> tuple[str, ...]:
        unusable_models = self.runtime_unusable_models()
        return tuple(
            candidate
            for candidate in self.model_order
            if candidate in model_names and candidate not in unusable_models
        )

    def fallback_reason(
        self,
        effective_model: str | None,
        *,
        include_primary_failure: bool = False,
    ) -> str | None:
        if effective_model is None or effective_model == self.primary_model:
            return None
        runtime_reason = self.runtime_reason_for(effective_model)
        if runtime_reason:
            return runtime_reason
        primary_failure = self.primary_failure_reason()
        if include_primary_failure and primary_failure:
            return (
                f"Configured model {self.primary_model} is unavailable "
                f"({short_error_text(primary_failure)}); using fallback {effective_model}."
            )
        return (
            f"Configured model {self.primary_model} is missing; "
            f"using fallback {effective_model}."
        )

    def mark_model_unusable(self, model: str, exc: Exception) -> None:
        failure = self._short_error(exc)
        with self._lock:
            self._prune_unusable_models_locked()
            self._unusable_models[model] = time.monotonic()
            if model == self.primary_model:
                self._last_primary_failure = failure
                self._primary_memory_blocked = False
            if self._runtime_effective_model == model:
                self._runtime_effective_model = None
                self._runtime_fallback_reason = None

    def record_model_success(self, model: str) -> None:
        with self._lock:
            self._unusable_models.pop(model, None)
            if model == self.primary_model:
                self._runtime_effective_model = None
                self._runtime_fallback_reason = None
                self._primary_memory_blocked = False
                return

            self._runtime_effective_model = model
            if self._last_primary_failure:
                self._runtime_fallback_reason = (
                    f"Configured model {self.primary_model} was unavailable during generation "
                    f"({short_error_text(self._last_primary_failure)}); using fallback {model}."
                )
            else:
                self._runtime_fallback_reason = (
                    f"Configured model {self.primary_model} is missing; using fallback {model}."
                )

    def mark_primary_blocked(self, reason: str) -> None:
        with self._lock:
            self._unusable_models[self.primary_model] = time.monotonic()
            self._last_primary_failure = reason
            self._primary_memory_blocked = True
            if self._runtime_effective_model == self.primary_model:
                self._runtime_effective_model = None
                self._runtime_fallback_reason = None

    def clear_primary_block(self) -> None:
        with self._lock:
            if not self._primary_memory_blocked:
                return
            self._unusable_models.pop(self.primary_model, None)
            self._last_primary_failure = None
            self._runtime_effective_model = None
            self._runtime_fallback_reason = None
            self._primary_memory_blocked = False

    def runtime_unusable_models(self) -> set[str]:
        with self._lock:
            self._prune_unusable_models_locked()
            return set(self._unusable_models)

    def runtime_selected_model(self) -> str | None:
        with self._lock:
            return self._runtime_effective_model

    def runtime_model_state(self) -> tuple[set[str], str | None]:
        with self._lock:
            self._prune_unusable_models_locked()
            return set(self._unusable_models), self._runtime_effective_model

    def runtime_reason_for(self, effective_model: str) -> str | None:
        with self._lock:
            if self._runtime_effective_model != effective_model:
                return None
            return self._runtime_fallback_reason

    def primary_failure_reason(self) -> str | None:
        with self._lock:
            return self._last_primary_failure

    @property
    def model_order(self) -> tuple[str, ...]:
        return (self.primary_model, *self.fallback_models)

    def _prune_unusable_models_locked(self) -> None:
        if self.retry_after_seconds is None:
            return
        retry_before = time.monotonic() - self.retry_after_seconds
        expired = [
            model
            for model, marked_at in self._unusable_models.items()
            if marked_at <= retry_before
        ]
        for model in expired:
            self._unusable_models.pop(model, None)
