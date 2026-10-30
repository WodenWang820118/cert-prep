"""DTOs of AI Providers: provider health and selection, Ollama profiles, and the machine they fit."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from cert_prep_contracts.llm import (
    LLMExecutionMode,
    LLMProviderName,
    LLMProviderPreference,
)
from cert_prep_contracts.runtime import RuntimeRequirementKind


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
    classification: Literal["integrated", "dedicated", "software", "unknown"] | None = None
    dedicated_memory_bytes: int | None = None
    shared_memory_bytes: int | None = None
    classification_source: Literal["native_dxgi", "vendor_tool", "unknown"] | None = None
    pci_vendor_id: str | None = None
    pci_device_id: str | None = None
    adapter_luid: str | None = None


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


class LLMHealthRead(BaseModel):
    provider: str
    model: str
    available: bool
    detail: str
    unavailable_reason: str | None = None
    configured_model: str | None = None
    effective_model: str | None = None
    fallback_models: list[str] = Field(default_factory=list)
    fallback_reason: str | None = None
    execution_mode: LLMExecutionMode | None = None
    execution_warning: str | None = None
    profile_id: str | None = None
    base_model: str | None = None
    modelfile_sha256: str | None = None
    profile_reason: str | None = None
    profile_warnings: list[str] = Field(default_factory=list)


class LLMProviderSelectionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    preference: LLMProviderPreference
    selected_provider: LLMProviderName
    effective_provider: LLMProviderName
    configured_model: str
    effective_model: str
    selection_reason: str
    fallback_reason: str | None = None
    runtime_requirement_kind: RuntimeRequirementKind | None = None
    model_requirement_kind: RuntimeRequirementKind | None = None


class OllamaModelProfileRead(BaseModel):
    profile_id: str
    display_name: str
    description: str
    base_model: str
    local_model: str
    context_window: int
    system_prompt: str
    parameters: dict[str, str | int | float | bool] = Field(default_factory=dict)
    min_total_ram_bytes: int | None = None
    min_available_ram_bytes: int | None = None
    min_free_disk_bytes: int | None = None
    min_vram_bytes: int | None = None
    auto_selectable: bool
    explicit_opt_in_required: bool
    fallback_profile_ids: list[str] = Field(default_factory=list)


class OllamaProfilesRead(BaseModel):
    items: list[OllamaModelProfileRead]


class OllamaProfileSelectionRead(BaseModel):
    profile_enabled: bool
    profile_id: str | None = None
    selected_profile: OllamaModelProfileRead | None = None
    support_status: str
    reason: str
    fallback_profiles: list[OllamaModelProfileRead] = Field(default_factory=list)
    fallback_models: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    inventory: MachineInventoryRead | None = None
    modelfile_sha256: str | None = None
    effective_model: str
    base_model: str | None = None
