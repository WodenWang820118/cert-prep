"""Shared local runtime installation contracts."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class RuntimeRequirementKind(StrEnum):
    """Installable local runtime dependency categories."""

    OLLAMA = "ollama"
    OLLAMA_MODEL = "ollama_model"
    FASTFLOWLM = "fastflowlm"
    FASTFLOWLM_MODEL = "fastflowlm_model"
    PADDLE_OCR = "paddle_ocr"
    WINDOWSML_OCR = "windowsml_ocr"


class RuntimeInstallationStatus(StrEnum):
    """Lifecycle states for explicit user-started runtime installation jobs."""

    QUEUED = "queued"
    RUNNING = "running"
    WAITING_FOR_USER = "waiting_for_user"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class RuntimeRequirementSnapshot:
    """Read-only availability snapshot for a local runtime requirement."""

    kind: RuntimeRequirementKind
    label: str
    available: bool
    detail: str
    unavailable_reason: str | None
    version: str | None = None
    bytes: int | None = None
    installed_path: str | None = None


@dataclass(frozen=True, slots=True)
class RuntimeInstallProgress:
    """Progress message emitted by a concrete runtime installer."""

    detail: str
    completed: int | None = None
    total: int | None = None


__all__ = [
    "RuntimeInstallationStatus",
    "RuntimeInstallProgress",
    "RuntimeRequirementKind",
    "RuntimeRequirementSnapshot",
]

