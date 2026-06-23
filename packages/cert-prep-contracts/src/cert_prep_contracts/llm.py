"""Shared LLM provider value types."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ModelPullProgress:
    """Progress reported by an explicit model download provider."""

    status: str
    completed: int | None = None
    total: int | None = None


__all__ = ["ModelPullProgress"]

