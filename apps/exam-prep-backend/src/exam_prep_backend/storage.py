from __future__ import annotations

import hashlib
from pathlib import Path

from exam_prep_backend.config import Settings


def sha256_hex(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def store_pdf(settings: Settings, project_id: str, sha256: str, content: bytes) -> Path:
    upload_dir = settings.data_dir / "uploads" / project_id
    upload_dir.mkdir(parents=True, exist_ok=True)
    storage_path = upload_dir / f"{sha256}.pdf"
    if not storage_path.exists():
        storage_path.write_bytes(content)
    return storage_path.resolve()
