"""The learner's stored choice of Ollama device.

No row is Auto. The effective policy can still fall back when the chosen
adapter is gone; that fallback is a status, not a rewrite of this choice.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from cert_prep_backend.platform.errors import ValidationError


class DevicePreferenceMode(StrEnum):
    """How the learner wants Ollama to pick a device."""

    AUTO = "auto"
    CPU = "cpu"
    ADAPTER = "adapter"


class DevicePreferenceStatus(StrEnum):
    """Whether the stored choice is in effect on this machine right now."""

    ACTIVE = "active"
    PENDING = "pending"
    EXTERNAL_SERVER = "external_server"
    ADAPTER_MISSING = "adapter_missing"
    NOT_APPLICABLE = "not_applicable"


@dataclass(frozen=True, slots=True)
class DevicePreference:
    """One stored device choice. Adapter fields are empty unless mode is adapter."""

    mode: DevicePreferenceMode = DevicePreferenceMode.AUTO
    adapter_key: str | None = None
    adapter_name: str | None = None
    pci_vendor_id: str | None = None
    pci_device_id: str | None = None


class DevicePreferenceRejected(ValidationError):
    """The choice is not one this machine can store."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


__all__ = [
    "DevicePreference",
    "DevicePreferenceMode",
    "DevicePreferenceRejected",
    "DevicePreferenceStatus",
]
