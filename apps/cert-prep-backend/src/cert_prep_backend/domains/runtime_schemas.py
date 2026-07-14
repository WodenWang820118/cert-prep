from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

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


class RuntimeInstallationStartRequest(BaseModel):
    fastflowlm_terms_accepted_version: str | None = None


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
    error: str | None = None


class MachineCpuRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    architecture: str
    name: str | None = None
    physical_cores: int | None = None
    logical_cores: int | None = None


class MachineRamRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    total_bytes: int | None = None
    available_bytes: int | None = None


class MachineStorageRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    path: str
    free_bytes: int | None = None
    total_bytes: int | None = None


class MachineAcceleratorRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    kind: str
    name: str
    vendor: str | None = None
    memory_bytes: int | None = None
    driver_version: str | None = None
    device_id: str | None = None


class MachineInventoryRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    platform: str
    platform_version: str
    architecture: str
    cpu: MachineCpuRead
    ram: MachineRamRead
    storage: MachineStorageRead
    accelerators: list[MachineAcceleratorRead] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    schema_version: int = 1
