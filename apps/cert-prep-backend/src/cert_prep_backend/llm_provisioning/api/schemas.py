from __future__ import annotations

from pydantic import BaseModel, ConfigDict

from cert_prep_contracts.llm_installation import (
    LLMInstallationStatus,
    LLMRequirementKind,
)


class LLMRequirementRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    kind: LLMRequirementKind
    label: str
    available: bool
    detail: str
    unavailable_reason: str | None
    version: str | None = None
    bytes: int | None = None
    installed_path: str | None = None


class LLMRequirementsRead(BaseModel):
    items: list[LLMRequirementRead]


class LLMInstallationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

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


class StartLLMInstallationRequest(BaseModel):
    kind: LLMRequirementKind
