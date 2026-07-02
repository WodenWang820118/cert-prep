from __future__ import annotations

from cert_prep_backend.domains.mock_exams.ports import ProviderHealth
from cert_prep_backend.domains.mock_exams.response_parsing import short_error_text


class FastFlowLMHealthMixin:
    """Health and RAM-aware fallback helpers for FastFlowLM providers."""

    def _health_from_model_names(self, model_names: set[str]) -> ProviderHealth:
        effective_model = self._effective_model_from(model_names)

        # RAM-aware override: report the fallback model when primary is
        # blocked by low system RAM, without mutating the fallback engine
        # (mutation is deferred to actual generation in
        # _available_model_candidates).
        if effective_model == self.model and self._is_primary_ram_blocked():
            for fb in self.fallback_models:
                if fb in model_names:
                    effective_model = fb
                    break

        available = effective_model is not None
        fallback_reason = self._fallback_reason(effective_model)
        if (
            effective_model is not None
            and effective_model != self.model
            and self._is_primary_ram_blocked()
        ):
            fallback_reason = self._ram_blocked_fallback_reason(effective_model)

        return ProviderHealth(
            provider=self.provider,
            model=self.model,
            available=available,
            detail=self._health_detail(effective_model),
            unavailable_reason=None if available else "model_missing",
            configured_model=self.model,
            effective_model=effective_model,
            fallback_models=self.fallback_models,
            fallback_reason=fallback_reason,
        )

    def _health_detail(self, effective_model: str | None) -> str:
        if effective_model is None:
            primary_failure = self._primary_failure_reason()
            if primary_failure:
                return (
                    f"{short_error_text(primary_failure)}; fallback model "
                    f"{self._ram_fallback_model} is not served."
                )
            return "model not found"
        if effective_model == self.model:
            return "model available"
        return f"model available via fallback {effective_model}"

    def _is_primary_ram_blocked(self) -> bool:
        """Return True when primary model cannot run due to low system RAM.

        Read-only: does not mutate the fallback engine.
        """

        if not self._should_guard_primary_ram():
            return False
        available_ram = self._available_system_ram_bytes()
        if available_ram is None:
            return False
        return available_ram < self.primary_min_available_ram_bytes

    def _ram_blocked_fallback_reason(self, effective_model: str) -> str:
        available_ram = self._available_system_ram_bytes()
        return (
            f"Available system RAM {_format_gib(available_ram or 0)} is below the "
            f"{_format_gib(self.primary_min_available_ram_bytes)} required for "
            f"{self.model}; using fallback {effective_model}."
        )

    def _refresh_primary_ram_state(self) -> None:
        if not self._should_guard_primary_ram():
            return
        available_ram = self._available_system_ram_bytes()
        if available_ram is None:
            return
        if available_ram < self.primary_min_available_ram_bytes:
            self._mark_primary_blocked_by_ram(available_ram)
            return
        self._clear_primary_ram_block()

    def _should_guard_primary_ram(self) -> bool:
        return (
            self.primary_min_available_ram_bytes > 0
            and self.model == self._primary_model_name
            and self._ram_fallback_model in self.fallback_models
        )

    def _mark_primary_blocked_by_ram(self, available_ram: int) -> None:
        reason = (
            f"Available system RAM {_format_gib(available_ram)} is below the "
            f"{_format_gib(self.primary_min_available_ram_bytes)} required for "
            f"{self.model}; trying fallback {self._ram_fallback_model}"
        )
        self._fallback_engine.mark_primary_blocked(reason)

    def _clear_primary_ram_block(self) -> None:
        self._fallback_engine.clear_primary_block()


def _format_gib(value: int) -> str:
    return f"{value / (1024**3):.1f} GiB"
