from __future__ import annotations

import hashlib
from pathlib import Path

from cert_prep_backend.core.config import Settings


def sha256_hex(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def store_pdf(settings: Settings, project_id: str, sha256: str, content: bytes) -> Path:
    """Store an uploaded PDF by content hash under the project upload directory."""

    project_upload_dir = settings.data_dir / "uploads" / project_id
    project_upload_dir.mkdir(parents=True, exist_ok=True)
    path = project_upload_dir / f"{sha256}.pdf"
    if not path.exists():
        path.write_bytes(content)
    return path
