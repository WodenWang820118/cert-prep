"""Shared runtime installation types and Ollama model helpers."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any


DEFAULT_OLLAMA_MODEL = "qwen3.5:4b"


class RuntimeRequirementKind(StrEnum):
    """Installable local runtime dependency categories."""

    OLLAMA = "ollama"
    OLLAMA_MODEL = "ollama_model"
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


@dataclass(frozen=True, slots=True)
class ModelPullProgress:
    """Progress reported by an explicit model download provider."""

    status: str
    completed: int | None = None
    total: int | None = None


def extract_model_names(response: Any) -> set[str]:
    """Extract model names from the shapes returned by Ollama clients."""

    models = getattr(response, "models", None)
    if models is None and isinstance(response, dict):
        models = response.get("models", [])
    names: set[str] = set()
    for model in models or []:
        name = getattr(model, "model", None)
        if name is None and isinstance(model, dict):
            name = model.get("model") or model.get("name")
        if isinstance(name, str):
            names.add(name)
    return names


def pull_progress(response: Any) -> ModelPullProgress:
    """Normalize streamed Ollama pull progress into domain progress values."""

    status = getattr(response, "status", None)
    completed = getattr(response, "completed", None)
    total = getattr(response, "total", None)
    if isinstance(response, dict):
        status = response.get("status", status)
        completed = response.get("completed", completed)
        total = response.get("total", total)
    return ModelPullProgress(
        status=status if isinstance(status, str) else "downloading model",
        completed=completed if isinstance(completed, int) else None,
        total=total if isinstance(total, int) else None,
    )
