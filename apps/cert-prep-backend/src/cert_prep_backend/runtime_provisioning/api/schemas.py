from __future__ import annotations

from pydantic import BaseModel, ConfigDict

from cert_prep_contracts.runtime import (
    RuntimeInstallationStatus,
    RuntimeRequirementKind,
)


class RuntimeRequirementRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    kind: RuntimeRequirementKind
    label: str
    available: bool
    detail: str
    unavailable_reason: str | None
    version: str | None = None
    bytes: int | None = None
    installed_path: str | None = None


class RuntimeRequirementsRead(BaseModel):
    items: list[RuntimeRequirementRead]


class RuntimeInstallationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

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


class ModelDownloadRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
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
