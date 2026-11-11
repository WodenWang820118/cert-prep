"""SQLite storage of the single Ollama device choice."""

from __future__ import annotations

from cert_prep_backend.ai_providers.domain.preference import DevicePreference, DevicePreferenceMode
from cert_prep_backend.platform.database import Database, utc_now


class SqliteDevicePreferenceRepository:
    def __init__(self, db: Database) -> None:
        self._db = db

    def load(self) -> DevicePreference | None:
        with self._db.connect() as connection:
            row = connection.execute(
                """
                SELECT mode, adapter_key, adapter_name, pci_vendor_id, pci_device_id
                FROM ollama_device_preference
                WHERE id = 1
                """
            ).fetchone()
        if row is None:
            return None
        return DevicePreference(
            mode=DevicePreferenceMode(row["mode"]),
            adapter_key=row["adapter_key"],
            adapter_name=row["adapter_name"],
            pci_vendor_id=row["pci_vendor_id"],
            pci_device_id=row["pci_device_id"],
        )

    def save(self, preference: DevicePreference) -> None:
        with self._db.connect() as connection:
            connection.execute(
                """
                INSERT INTO ollama_device_preference(
                    id, mode, adapter_key, adapter_name, pci_vendor_id, pci_device_id, updated_at
                ) VALUES (1, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    mode = excluded.mode,
                    adapter_key = excluded.adapter_key,
                    adapter_name = excluded.adapter_name,
                    pci_vendor_id = excluded.pci_vendor_id,
                    pci_device_id = excluded.pci_device_id,
                    updated_at = excluded.updated_at
                """,
                (
                    preference.mode.value,
                    preference.adapter_key,
                    preference.adapter_name,
                    preference.pci_vendor_id,
                    preference.pci_device_id,
                    utc_now(),
                ),
            )


__all__ = ["SqliteDevicePreferenceRepository"]
