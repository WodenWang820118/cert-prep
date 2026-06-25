"""Shared LLM profile contracts."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum

from cert_prep_contracts.hardware import MachineInventorySnapshot

OllamaParameterValue = str | int | float | bool


class OllamaProfileSupportStatus(StrEnum):
    """Support status for a selected Ollama profile on a machine snapshot."""

    SUPPORTED = "supported"
    WARNING = "warning"
    UNSUPPORTED = "unsupported"
    DISABLED = "disabled"


@dataclass(frozen=True, slots=True)
class OllamaModelProfile:
    """Installable Ollama model profile owned by cert-prep."""

    profile_id: str
    display_name: str
    base_model: str
    local_model: str
    context_window: int
    system_prompt: str
    parameters: tuple[tuple[str, OllamaParameterValue], ...] = field(default_factory=tuple)
    min_total_ram_bytes: int | None = None
    min_available_ram_bytes: int | None = None
    min_free_disk_bytes: int | None = None
    min_vram_bytes: int | None = None
    auto_selectable: bool = True
    explicit_opt_in_required: bool = False
    fallback_profile_ids: tuple[str, ...] = field(default_factory=tuple)
    description: str = ""

    @classmethod
    def from_mapping(
        cls,
        *,
        parameters: Mapping[str, OllamaParameterValue] | None = None,
        **values: object,
    ) -> "OllamaModelProfile":
        """Create a profile while freezing parameter order by key."""

        ordered_parameters = tuple(sorted((parameters or {}).items()))
        return cls(parameters=ordered_parameters, **values)  # type: ignore[arg-type]


@dataclass(frozen=True, slots=True)
class OllamaProfileSelection:
    """The selected profile and its machine-specific rationale."""

    profile_id: str
    selected_profile: OllamaModelProfile
    support_status: OllamaProfileSupportStatus
    reason: str
    fallback_profiles: tuple[OllamaModelProfile, ...] = field(default_factory=tuple)
    warnings: tuple[str, ...] = field(default_factory=tuple)
    inventory: MachineInventorySnapshot | None = None
    modelfile_sha256: str | None = None


__all__ = [
    "OllamaModelProfile",
    "OllamaParameterValue",
    "OllamaProfileSelection",
    "OllamaProfileSupportStatus",
]
