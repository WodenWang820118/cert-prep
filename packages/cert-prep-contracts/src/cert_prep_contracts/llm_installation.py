"""Shared local LLM installation contracts."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class LLMRequirementKind(StrEnum):
    """Installable local LLM dependency categories."""

    OLLAMA = "ollama"
    OLLAMA_MODEL = "ollama_model"


class LLMInstallationStatus(StrEnum):
    """Lifecycle states for explicit user-started LLM installation jobs."""

    QUEUED = "queued"
    RUNNING = "running"
    CANCEL_REQUESTED = "cancel_requested"
    CANCELED = "canceled"
    WAITING_FOR_USER = "waiting_for_user"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class LLMRequirementSnapshot:
    """Read-only availability snapshot for a local LLM requirement."""

    kind: LLMRequirementKind
    label: str
    available: bool
    detail: str
    unavailable_reason: str | None
    version: str | None = None
    bytes: int | None = None
    installed_path: str | None = None


@dataclass(frozen=True, slots=True)
class LLMInstallProgress:
    """Progress message emitted by a concrete LLM installer."""

    detail: str
    completed: int | None = None
    total: int | None = None
    phase: str | None = None
    cancellable: bool | None = None


__all__ = [
    "LLMInstallationStatus",
    "LLMInstallProgress",
    "LLMRequirementKind",
    "LLMRequirementSnapshot",
]
