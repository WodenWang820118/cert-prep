from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from cert_prep_ollama.models import (
    RuntimeInstallationStatus,
    RuntimeRequirementKind,
)

__all__ = [
    "OcrRuntimeManifest",
    "RuntimeInstallationSnapshot",
    "utcnow",
]


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
class OcrRuntimeManifest:
    """Manifest metadata for a packaged OCR runtime artifact."""

    kind: RuntimeRequirementKind
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
