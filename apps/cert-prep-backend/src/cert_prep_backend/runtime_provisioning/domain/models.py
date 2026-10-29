from __future__ import annotations

from dataclasses import dataclass
from cert_prep_contracts.runtime import (
    RuntimeInstallationStatus,
    RuntimeRequirementKind,
)

__all__ = [
    "RuntimeInstallationSnapshot",
]


@dataclass(frozen=True, slots=True)
class RuntimeInstallationSnapshot:
    """Serializable view of a runtime installation job."""

    id: str
    kind: RuntimeRequirementKind
    provider: str
    model: str
    status: RuntimeInstallationStatus
    phase: str
    cancellable: bool
    detail: str
    completed: int | None
    total: int | None
    created_at: str
    updated_at: str
    commit_started_at: str | None = None
    error: str | None = None
