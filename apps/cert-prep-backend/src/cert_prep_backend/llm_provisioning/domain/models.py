from __future__ import annotations

from dataclasses import dataclass
from cert_prep_contracts.llm_installation import (
    LLMInstallationStatus,
    LLMRequirementKind,
)

__all__ = [
    "LLMInstallationSnapshot",
]


@dataclass(frozen=True, slots=True)
class LLMInstallationSnapshot:
    """Serializable view of a LLM installation job."""

    id: str
    kind: LLMRequirementKind
    provider: str
    model: str
    status: LLMInstallationStatus
    phase: str
    cancellable: bool
    detail: str
    completed: int | None
    total: int | None
    created_at: str
    updated_at: str
    commit_started_at: str | None = None
    error: str | None = None
