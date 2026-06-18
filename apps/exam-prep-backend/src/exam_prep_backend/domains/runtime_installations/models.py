from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path


class RuntimeRequirementKind(StrEnum):
    """Installable local runtime dependency categories."""

    OLLAMA = "ollama"
    OLLAMA_MODEL = "ollama_model"
    PADDLE_OCR = "paddle_ocr"


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
class RuntimeInstallationSnapshot:
    """Serializable view of a runtime installation job."""

    id: str
    kind: RuntimeRequirementKind
    provider: str
    model: str
    status: RuntimeInstallationStatus
    detail: str
    completed: int | None
    total: int | None
    created_at: str
    updated_at: str
    error: str | None = None


@dataclass(frozen=True, slots=True)
class RuntimeInstallProgress:
    """Progress message emitted by a concrete runtime installer."""

    detail: str
    completed: int | None = None
    total: int | None = None


@dataclass(frozen=True, slots=True)
class OcrRuntimeManifest:
    """Manifest metadata for a packaged PaddleOCR runtime artifact."""

    version: str
    target: str
    file_name: str
    sha256: str
    bytes: int
    entrypoint: str
    url: str | None = None
    base_dir: Path | None = None


def utcnow() -> datetime:
    """Return the timezone-aware timestamp used by runtime installation snapshots."""

    return datetime.now(UTC)
